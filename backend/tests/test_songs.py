from pathlib import Path
from types import SimpleNamespace

from fastapi.testclient import TestClient
from mutagen.id3 import APIC, ID3

import openband.daily as daily_module
from music_taste_rec.api import create_app
from openband.auth import AuthStore, AuthUser
from openband.daily import DailyGenerationContext, DailyGenerationService, DailyStore
from openband.songs import LIKED_PLAYLIST_ID, LIKED_PLAYLIST_NAME, SongStore


ADMIN_KEY = "admin-test-key"
PNG_BYTES = (
    b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01"
    b"\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15\xc4\x89"
    b"\x00\x00\x00\rIDATx\x9cc\xf8\xff\xff?\x00\x05\xfe"
    b"\x02\xfeA\xe2&\xb8\x00\x00\x00\x00IEND\xaeB`\x82"
)


def _login_headers(client: TestClient) -> dict[str, str]:
    invite = client.post(
        "/v1/auth/invite-keys",
        headers={"X-Admin-Key": ADMIN_KEY},
        json={"label": "Song Tester"},
    )
    assert invite.status_code == 200
    login = client.post(
        "/v1/auth/login",
        json={"key": invite.json()["key"], "device_name": "pytest"},
    )
    assert login.status_code == 200
    return {"Authorization": f"Bearer {login.json()['access_token']}"}


def _mp3_with_cover(tmp_path: Path) -> bytes:
    path = tmp_path / "covered.mp3"
    tags = ID3()
    tags.add(
        APIC(
            encoding=3,
            mime="image/png",
            type=3,
            desc="Cover",
            data=PNG_BYTES,
        )
    )
    tags.save(path)
    return path.read_bytes()


def test_daily_prompt_can_mark_suno_generated_lyrics(monkeypatch, tmp_path: Path) -> None:
    service = DailyGenerationService(
        model_path=tmp_path / "missing-model.joblib",
        responses_url="http://localhost.test",
        responses_model="test-model",
        runtime_root=tmp_path / "daily",
    )
    service._style_prompt_tags = lambda _style_prompt: ["nu metal"]  # type: ignore[method-assign]

    monkeypatch.setattr(
        daily_module.prompt_cli,
        "run_brief_candidates",
        lambda *_args, **_kwargs: ([{"title_seed": "One Song"}], 0, {"title_seed": "One Song"}),
    )
    monkeypatch.setattr(
        daily_module.prompt_cli,
        "selected_brief_user_text",
        lambda *_args, **_kwargs: "selected brief request",
    )
    monkeypatch.setattr(
        daily_module.prompt_cli,
        "apply_profile",
        lambda user_text, _profile: user_text,
    )
    flow_result = (
        "# Suno Prompt Result\n\n"
        "## Selected Brief\n\n"
        '{"title_seed": "One Song"}\n\n'
        "## Style Prompt\n\n"
        "nu metal, hard rock\n\n"
        "## Lyrics\n\n"
        "[Chorus]\nSing this line\n"
    )
    monkeypatch.setattr(
        daily_module.prompt_cli,
        "run_generation_flow",
        lambda *_args, **_kwargs: ("", flow_result),
    )
    monkeypatch.setattr(
        daily_module.prompt_cli,
        "format_song_brief_result",
        lambda **_kwargs: flow_result,
    )
    monkeypatch.setattr(daily_module.secrets, "randbelow", lambda _upper: 0)

    manifest = service._generate_song_prompts(
        args=SimpleNamespace(),
        api_key="test-key",
        profile={},
        seed={"songs": [{"index": 1, "tags": ["nu metal"]}]},
        prompt_dir=tmp_path,
        date_value="2026-06-25",
    )

    assert manifest[0]["lyrics_mode"] == "suno"
    prompt_text = Path(manifest[0]["prompt_file"]).read_text(encoding="utf-8")
    assert "## Lyrics" in prompt_text
    assert "Sing this line" in prompt_text
    assert "## Suno Submit" in prompt_text
    assert "lyrics_mode: suno" in prompt_text
    assert "probability_percent: 30" in prompt_text
    recovered = service._prompt_manifest_from_file(Path(manifest[0]["prompt_file"]), fallback_index=1)
    assert recovered["lyrics_mode"] == "suno"
    assert recovered["used_llm_lyrics"] is False


class FakeDailyGenerator:
    def __init__(self, mp3_bytes: bytes):
        self.mp3_bytes = mp3_bytes

    def run(self, context: DailyGenerationContext) -> None:
        song_seeds = [
            {
                "index": index,
                "tags": ["ambient", "piano", "sleep"] if index % 2 else ["jazz", "guitar", "night"],
            }
            for index in range(1, 11)
        ]
        context.daily_store.mark_job_running(job_id=context.job_id, stage="generating_tags")
        context.daily_store.set_playlist_status(
            playlist_id=context.playlist_id,
            status="generating_tags",
            job_id=context.job_id,
            prompt_seed={
                "date": context.date,
                "songs": song_seeds,
            },
        )
        context.daily_store.mark_job_stage(job_id=context.job_id, stage="suno_queue")
        batches = context.daily_store.create_suno_batches(
            daily_job_id=context.job_id,
            user_id=context.user.id,
            date_value=context.date,
            daily_playlist_id=context.playlist_id,
            batches=[
                {
                    "batch_index": 1,
                    "position_start": 1,
                    "position_end": 5,
                    "prompt_files": [f"mock/{index:02d}.md" for index in range(1, 6)],
                    "state_path": f"mock/{context.job_id}/suno-batch-01-state.json",
                },
                {
                    "batch_index": 2,
                    "position_start": 6,
                    "position_end": 10,
                    "prompt_files": [f"mock/{index:02d}.md" for index in range(6, 11)],
                    "state_path": f"mock/{context.job_id}/suno-batch-02-state.json",
                },
            ],
        )
        for batch in batches:
            context.daily_store.mark_suno_batch_running(
                batch_id=batch.id,
                stage="submitting_to_suno",
            )
            context.daily_store.mark_suno_batch_succeeded(
                batch_id=batch.id,
                result={
                    "batchName": f"mock-batch-{batch.batch_index:02d}",
                    "results": [
                        {"title": f"Mock Daily Song {index}"}
                        for index in range(batch.position_start, batch.position_end + 1)
                    ],
                },
            )
        daily_songs = []
        for index in range(1, 11):
            title = f"Mock Daily Song {index}"
            source_path = context.song_store.storage_root / f"{context.job_id}-{index}.mp3"
            source_path.write_bytes(self.mp3_bytes)
            tags = ["ambient", "piano", "sleep"] if index % 2 else ["jazz", "guitar", "night"]
            song = context.song_store.create_song_from_file(
                source_path=source_path,
                title=title,
                artist="OpenTunes Daily",
                album=f"Daily {context.date}",
                tags=tags,
                duration_seconds=120 + index,
                source="mock-daily",
            )
            daily_songs.append(
                {
                    "song_id": song.id,
                    "position": index - 1,
                    "tags": tags,
                    "prompt_file": f"mock/{index:02d}.md",
                    "suno_url": f"https://suno.example/song/{index}",
                    "generation_status": "ready",
                    "metadata": {"selected_brief": {"title_seed": title}},
                }
            )
            source_path.unlink(missing_ok=True)
        context.daily_store.replace_daily_songs(
            daily_playlist_id=context.playlist_id,
            songs=daily_songs,
        )
        context.daily_store.set_playlist_status(
            playlist_id=context.playlist_id,
            status="ready",
            job_id=context.job_id,
            prompt_seed={"date": context.date, "mock": True},
            completed=True,
        )
        context.daily_store.mark_job_succeeded(
            job_id=context.job_id,
            result={"daily_playlist_id": context.playlist_id, "song_count": len(daily_songs)},
        )


class ResumeAwareDailyGenerator:
    def __init__(self, *, failure_stage: str = "download_failed", failure_message: str = "download broke"):
        self.runs = []
        self.failure_stage = failure_stage
        self.failure_message = failure_message

    def run(self, context: DailyGenerationContext) -> None:
        self.runs.append({"job_id": context.job_id, "resume": context.resume})
        if not context.resume:
            context.daily_store.mark_job_running(job_id=context.job_id, stage="suno_batch_1")
            context.daily_store.set_playlist_status(
                playlist_id=context.playlist_id,
                status="suno_batch_1",
                job_id=context.job_id,
                prompt_seed={"date": context.date, "mock": True},
            )
            batches = context.daily_store.create_suno_batches(
                daily_job_id=context.job_id,
                user_id=context.user.id,
                date_value=context.date,
                daily_playlist_id=context.playlist_id,
                batches=[
                    {
                        "batch_index": 1,
                        "position_start": 1,
                        "position_end": 5,
                        "prompt_files": [f"mock/{index:02d}.md" for index in range(1, 6)],
                        "state_path": f"mock/{context.job_id}/suno-batch-01-state.json",
                    }
                ],
            )
            context.daily_store.mark_suno_batch_failed(
                batch_id=batches[0].id,
                error=self.failure_message,
                stage=self.failure_stage,
            )
            raise RuntimeError(self.failure_message)

        for batch in context.daily_store.list_suno_batches(daily_job_id=context.job_id):
            context.daily_store.mark_suno_batch_running(
                batch_id=batch.id,
                stage="submitting_to_suno",
            )
            context.daily_store.mark_suno_batch_succeeded(
                batch_id=batch.id,
                result={"batchName": f"resumed-{batch.batch_index}", "results": []},
            )
        context.daily_store.replace_daily_songs(
            daily_playlist_id=context.playlist_id,
            songs=[],
        )
        context.daily_store.set_playlist_status(
            playlist_id=context.playlist_id,
            status="ready",
            job_id=context.job_id,
            prompt_seed={"date": context.date, "resumed": True},
            completed=True,
        )
        context.daily_store.mark_job_succeeded(
            job_id=context.job_id,
            result={"daily_playlist_id": context.playlist_id, "song_count": 0},
        )


class PreSunoFailThenSucceedDailyGenerator:
    def __init__(self):
        self.runs = []

    def run(self, context: DailyGenerationContext) -> None:
        self.runs.append({"job_id": context.job_id, "resume": context.resume})
        if len(self.runs) == 1:
            raise RuntimeError("profile tags were missing")

        context.daily_store.replace_daily_songs(
            daily_playlist_id=context.playlist_id,
            songs=[],
        )
        context.daily_store.set_playlist_status(
            playlist_id=context.playlist_id,
            status="ready",
            job_id=context.job_id,
            prompt_seed={"date": context.date, "mock": True},
            completed=True,
        )
        context.daily_store.mark_job_succeeded(
            job_id=context.job_id,
            result={"daily_playlist_id": context.playlist_id, "song_count": 0},
        )


def test_song_upload_list_and_audio_download(tmp_path: Path) -> None:
    client = TestClient(
        create_app(
            model_path=tmp_path / "missing-model.joblib",
            auth_db_path=tmp_path / "openband.sqlite3",
            song_storage_root=tmp_path / "songs",
            admin_key=ADMIN_KEY,
        )
    )
    headers = _login_headers(client)

    unauthorized = client.get("/v1/songs")
    assert unauthorized.status_code == 401

    mp3_bytes = _mp3_with_cover(tmp_path)

    forbidden_upload = client.post(
        "/v1/songs",
        data={"title": "Lake Light"},
        files={"file": ("lake-light.mp3", mp3_bytes, "audio/mpeg")},
    )
    assert forbidden_upload.status_code == 403

    upload = client.post(
        "/v1/songs",
        headers={"X-Admin-Key": ADMIN_KEY},
        data={
            "title": "Lake Light",
            "artist": "Suno Sketch",
            "album": "Midnight Sketches",
            "tags": "ambient; piano; sleep",
            "duration_seconds": "138",
            "source": "suno",
        },
        files={"file": ("lake-light.mp3", mp3_bytes, "audio/mpeg")},
    )
    assert upload.status_code == 200
    song = upload.json()
    assert song["id"].startswith("song_")
    assert song["title"] == "Lake Light"
    assert song["artist"] == "Suno Sketch"
    assert song["duration_seconds"] == 138
    assert song["tags"] == ["ambient", "piano", "sleep"]
    assert song["file_size"] == len(mp3_bytes)
    assert song["audio_url"].endswith(f"/{song['id']}/audio")
    assert song["cover_url"].endswith(f"/{song['id']}/cover")
    assert song["is_liked"] is False
    assert song["liked_at"] is None

    songs = client.get("/v1/songs", headers=headers)
    assert songs.status_code == 200
    songs_body = songs.json()
    assert songs_body["total"] == 1
    assert songs_body["songs"][0]["id"] == song["id"]
    assert songs_body["songs"][0]["is_liked"] is False

    default_playlists = client.get("/v1/playlists", headers=headers)
    assert default_playlists.status_code == 200
    default_playlists_body = default_playlists.json()
    assert default_playlists_body["total"] == 1
    default_playlist = default_playlists_body["playlists"][0]
    assert default_playlist["id"] == LIKED_PLAYLIST_ID
    assert default_playlist["name"] == LIKED_PLAYLIST_NAME
    assert default_playlist["kind"] == "liked"
    assert default_playlist["is_system"] is True
    assert default_playlist["can_delete"] is False
    assert default_playlist["song_count"] == 0

    like_status = client.get(f"/v1/songs/{song['id']}/like", headers=headers)
    assert like_status.status_code == 200
    assert like_status.json() == {"song_id": song["id"], "is_liked": False, "liked_at": None}

    liked = client.put(f"/v1/songs/{song['id']}/like", headers=headers)
    assert liked.status_code == 200
    liked_body = liked.json()
    assert liked_body["song_id"] == song["id"]
    assert liked_body["is_liked"] is True
    assert liked_body["liked_at"]

    liked_songs = client.get("/v1/songs/liked", headers=headers)
    assert liked_songs.status_code == 200
    assert liked_songs.json()["total"] == 1
    assert liked_songs.json()["songs"][0]["is_liked"] is True

    liked_playlist = client.get(f"/v1/playlists/{LIKED_PLAYLIST_ID}", headers=headers)
    assert liked_playlist.status_code == 200
    assert liked_playlist.json()["song_count"] == 1
    assert liked_playlist.json()["songs"][0]["id"] == song["id"]
    assert liked_playlist.json()["songs"][0]["is_liked"] is True

    filtered = client.get("/v1/songs?tag=ambient", headers=headers)
    assert filtered.status_code == 200
    assert filtered.json()["total"] == 1

    title_search = client.get("/v1/songs?q=lake", headers=headers)
    assert title_search.status_code == 200
    assert title_search.json()["total"] == 1
    assert title_search.json()["songs"][0]["id"] == song["id"]

    tag_search = client.get("/v1/songs?q=piano", headers=headers)
    assert tag_search.status_code == 200
    assert tag_search.json()["total"] == 1
    assert tag_search.json()["songs"][0]["id"] == song["id"]

    missing_search = client.get("/v1/songs?q=metal", headers=headers)
    assert missing_search.status_code == 200
    assert missing_search.json()["total"] == 0

    missing_filter = client.get("/v1/songs?tag=metal", headers=headers)
    assert missing_filter.status_code == 200
    assert missing_filter.json()["total"] == 0

    daily = client.get("/v1/songs/daily", headers=headers)
    assert daily.status_code == 200
    assert daily.json()["songs"][0]["id"] == song["id"]

    audio = client.get(song["audio_url"], headers=headers)
    assert audio.status_code == 200
    assert audio.content == mp3_bytes
    assert audio.headers["etag"] == song["file_sha256"]
    assert audio.headers["content-type"].startswith("audio/mpeg")

    cover = client.get(song["cover_url"], headers=headers)
    assert cover.status_code == 200
    assert cover.content == PNG_BYTES
    assert cover.headers["content-type"].startswith("image/png")

    unliked = client.delete(f"/v1/songs/{song['id']}/like", headers=headers)
    assert unliked.status_code == 200
    assert unliked.json() == {"song_id": song["id"], "is_liked": False, "liked_at": None}

    liked_songs_after_delete = client.get("/v1/songs/liked", headers=headers)
    assert liked_songs_after_delete.status_code == 200
    assert liked_songs_after_delete.json()["total"] == 0

    liked_playlist_after_delete = client.get(f"/v1/playlists/{LIKED_PLAYLIST_ID}", headers=headers)
    assert liked_playlist_after_delete.status_code == 200
    assert liked_playlist_after_delete.json()["song_count"] == 0
    assert liked_playlist_after_delete.json()["songs"] == []

    add_to_liked_playlist = client.post(
        f"/v1/playlists/{LIKED_PLAYLIST_ID}/songs",
        headers=headers,
        json={"song_id": song["id"]},
    )
    assert add_to_liked_playlist.status_code == 200
    assert add_to_liked_playlist.json()["song_count"] == 1

    remove_from_liked_playlist = client.delete(
        f"/v1/playlists/{LIKED_PLAYLIST_ID}/songs/{song['id']}",
        headers=headers,
    )
    assert remove_from_liked_playlist.status_code == 200
    assert remove_from_liked_playlist.json()["song_count"] == 0

    playlist_create = client.post(
        "/v1/playlists",
        headers=headers,
        json={"name": "Night Drive", "description": "Late AI rock tests"},
    )
    assert playlist_create.status_code == 200
    playlist = playlist_create.json()
    assert playlist["id"].startswith("playlist_")
    assert playlist["name"] == "Night Drive"
    assert playlist["song_count"] == 0
    assert playlist["cover_song_id"] is None

    playlist_list = client.get("/v1/playlists", headers=headers)
    assert playlist_list.status_code == 200
    assert playlist_list.json()["total"] == 2
    assert playlist_list.json()["playlists"][0]["id"] == LIKED_PLAYLIST_ID
    assert playlist_list.json()["playlists"][1]["id"] == playlist["id"]

    playlist_add = client.post(
        f"/v1/playlists/{playlist['id']}/songs",
        headers=headers,
        json={"song_id": song["id"]},
    )
    assert playlist_add.status_code == 200
    playlist_detail = playlist_add.json()
    assert playlist_detail["song_count"] == 1
    assert playlist_detail["songs"][0]["id"] == song["id"]
    assert playlist_detail["cover_song_id"] == song["id"]

    playlist_update = client.patch(
        f"/v1/playlists/{playlist['id']}",
        headers=headers,
        json={"name": "Night Drive Edited", "cover_song_id": song["id"]},
    )
    assert playlist_update.status_code == 200
    assert playlist_update.json()["name"] == "Night Drive Edited"
    assert playlist_update.json()["cover_song_id"] == song["id"]

    playlist_get = client.get(f"/v1/playlists/{playlist['id']}", headers=headers)
    assert playlist_get.status_code == 200
    assert playlist_get.json()["name"] == "Night Drive Edited"
    assert playlist_get.json()["songs"][0]["title"] == "Lake Light"

    playlist_remove = client.delete(
        f"/v1/playlists/{playlist['id']}/songs/{song['id']}",
        headers=headers,
    )
    assert playlist_remove.status_code == 200
    assert playlist_remove.json()["song_count"] == 0
    assert playlist_remove.json()["cover_song_id"] is None
    assert playlist_remove.json()["songs"] == []


def test_daily_generation_creates_system_playlist_without_user_playlist(tmp_path: Path) -> None:
    mp3_bytes = _mp3_with_cover(tmp_path)
    client = TestClient(
        create_app(
            model_path=tmp_path / "missing-model.joblib",
            auth_db_path=tmp_path / "openband.sqlite3",
            song_storage_root=tmp_path / "songs",
            admin_key=ADMIN_KEY,
            daily_generator=FakeDailyGenerator(mp3_bytes),
        )
    )
    headers = _login_headers(client)

    tags = client.put(
        "/v1/me/music-tags",
        headers=headers,
        json={"tags": ["ambient", "piano", "sleep", "jazz", "guitar", "night"]},
    )
    assert tags.status_code == 200

    before = client.get("/v1/daily/today?date=2026-06-22", headers=headers)
    assert before.status_code == 200
    assert before.json()["status"] == "not_started"
    assert before.json()["playlist"] is None

    generated = client.post(
        "/v1/daily/today/generate",
        headers=headers,
        json={"date": "2026-06-22", "wait": True},
    )
    assert generated.status_code == 200
    generated_body = generated.json()
    assert generated_body["status"] == "ready"
    assert generated_body["job"]["status"] == "succeeded"
    assert len(generated_body["job"]["batches"]) == 2
    assert [batch["status"] for batch in generated_body["job"]["batches"]] == ["succeeded", "succeeded"]
    assert [
        (batch["position_start"], batch["position_end"])
        for batch in generated_body["job"]["batches"]
    ] == [(1, 5), (6, 10)]
    assert generated_body["playlist"]["title"] == "Daily 2026-06-22"
    assert generated_body["playlist"]["song_count"] == 10
    assert [item["position"] for item in generated_body["playlist"]["songs"]] == list(range(10))
    assert generated_body["playlist"]["songs"][0]["song"]["album"] == "Daily 2026-06-22"
    assert generated_body["playlist"]["songs"][0]["song"]["cover_url"].endswith("/cover")

    daily = client.get("/v1/daily/2026-06-22", headers=headers)
    assert daily.status_code == 200
    assert [item["song"]["title"] for item in daily.json()["songs"]] == [
        f"Mock Daily Song {index}" for index in range(1, 11)
    ]

    job = client.get(f"/v1/daily/jobs/{generated_body['job']['id']}", headers=headers)
    assert job.status_code == 200
    assert [batch["batch_index"] for batch in job.json()["batches"]] == [1, 2]

    history = client.get("/v1/daily/history", headers=headers)
    assert history.status_code == 200
    assert history.json()["total"] == 1
    assert history.json()["playlists"][0]["date"] == "2026-06-22"

    user_playlists = client.get("/v1/playlists", headers=headers)
    assert user_playlists.status_code == 200
    assert user_playlists.json()["total"] == 1
    assert user_playlists.json()["playlists"][0]["id"] == LIKED_PLAYLIST_ID

    repeated = client.post(
        "/v1/daily/today/generate",
        headers=headers,
        json={"date": "2026-06-22", "wait": True},
    )
    assert repeated.status_code == 200
    assert repeated.json()["job"] is None
    assert repeated.json()["playlist"]["song_count"] == 10


def test_daily_suno_import_keeps_one_library_song_per_prompt(tmp_path: Path) -> None:
    db_path = tmp_path / "openband.sqlite3"
    auth_store = AuthStore(db_path)
    song_store = SongStore(db_path, tmp_path / "songs")
    daily_store = DailyStore(db_path)
    invite = auth_store.create_invite_key(
        label="Daily Import Tester",
        base_url="http://testserver",
    )
    login = auth_store.login_with_invite_key(invite["key"])
    user = AuthUser(**login["user"])
    playlist = daily_store.get_or_create_daily_playlist(user_id=user.id, date_value="2026-06-27")
    job = daily_store.create_job(
        user_id=user.id,
        date_value="2026-06-27",
        daily_playlist_id=playlist.id,
    )
    context = DailyGenerationContext(
        user=user,
        date="2026-06-27",
        playlist_id=playlist.id,
        job_id=job.id,
        daily_store=daily_store,
        song_store=song_store,
        auth_store=auth_store,
    )
    service = DailyGenerationService(
        model_path=tmp_path / "missing-model.joblib",
        responses_url="https://example.test/responses",
        responses_model="test-model",
        runtime_root=tmp_path / "daily",
        suno_timeout_seconds=1,
    )

    prompt_file = tmp_path / "01-one-song.md"
    prompt_file.write_text("# One Song\n", encoding="utf-8")
    mp3_bytes = _mp3_with_cover(tmp_path)
    first_path = tmp_path / "first.mp3"
    second_path = tmp_path / "second.mp3"
    first_path.write_bytes(mp3_bytes)
    second_path.write_bytes(mp3_bytes)
    prompt_manifest = [
        {
            "index": 1,
            "tags": ["ambient", "piano"],
            "prompt_file": prompt_file,
            "selected_brief_index": 1,
            "selected_brief": {"title_seed": "One Song"},
            "lyrics_mode": "suno",
            "song_metrics": {},
        }
    ]

    imported = service._import_batch_results(
        context=context,
        prompt_manifest=prompt_manifest,
        batch_results=[
            {
                "file": str(prompt_file),
                "title": "One Song",
                "targetPath": str(first_path),
                "selectedSeconds": 120,
            },
            {
                "file": str(prompt_file),
                "title": "One Song Alternate",
                "targetPath": str(second_path),
                "selectedSeconds": 121,
            },
        ],
    )

    assert len(imported) == 1
    songs, total = song_store.list_songs(limit=10)
    assert total == 1
    assert songs[0].title == "One Song"
    assert imported[0]["metadata"]["lyrics_mode"] == "suno"
    assert imported[0]["metadata"]["used_llm_lyrics"] is False
    daily_store.replace_daily_songs(daily_playlist_id=playlist.id, songs=imported)
    stored_daily_songs = daily_store.list_daily_songs(daily_playlist_id=playlist.id)
    assert stored_daily_songs[0].metadata["lyrics_mode"] == "suno"
    assert stored_daily_songs[0].metadata["used_llm_lyrics"] is False

    imported_again = service._import_batch_results(
        context=context,
        prompt_manifest=prompt_manifest,
        batch_results=[
            {
                "file": str(prompt_file),
                "title": "One Song Reimport",
                "targetPath": str(second_path),
                "selectedSeconds": 122,
            }
        ],
    )

    assert imported_again[0]["song_id"] == imported[0]["song_id"]
    songs_after, total_after = song_store.list_songs(limit=10)
    assert total_after == 1
    assert songs_after[0].id == imported[0]["song_id"]


def test_daily_generation_retry_resumes_failed_suno_job(tmp_path: Path) -> None:
    generator = ResumeAwareDailyGenerator()
    client = TestClient(
        create_app(
            model_path=tmp_path / "missing-model.joblib",
            auth_db_path=tmp_path / "openband.sqlite3",
            song_storage_root=tmp_path / "songs",
            admin_key=ADMIN_KEY,
            daily_generator=generator,
        )
    )
    headers = _login_headers(client)

    failed = client.post(
        "/v1/daily/today/generate",
        headers=headers,
        json={"date": "2026-06-23", "wait": True},
    )
    assert failed.status_code == 200
    failed_body = failed.json()
    job_id = failed_body["job"]["id"]
    assert failed_body["status"] == "failed"
    assert failed_body["job"]["status"] == "failed"
    assert failed_body["job"]["batches"][0]["status"] == "failed"
    assert failed_body["job"]["batches"][0]["stage"] == "download_failed"

    retried = client.post(
        "/v1/daily/today/generate",
        headers=headers,
        json={"date": "2026-06-23", "resume": True, "wait": True},
    )
    assert retried.status_code == 200
    retried_body = retried.json()
    assert retried_body["status"] == "ready"
    assert retried_body["job"]["id"] == job_id
    assert retried_body["job"]["status"] == "succeeded"
    assert retried_body["job"]["batches"][0]["status"] == "succeeded"
    assert generator.runs == [
        {"job_id": job_id, "resume": False},
        {"job_id": job_id, "resume": True},
    ]


def test_daily_generation_force_retry_resumes_failed_suno_job_for_stale_clients(tmp_path: Path) -> None:
    generator = ResumeAwareDailyGenerator()
    client = TestClient(
        create_app(
            model_path=tmp_path / "missing-model.joblib",
            auth_db_path=tmp_path / "openband.sqlite3",
            song_storage_root=tmp_path / "songs",
            admin_key=ADMIN_KEY,
            daily_generator=generator,
        )
    )
    headers = _login_headers(client)

    failed = client.post(
        "/v1/daily/today/generate",
        headers=headers,
        json={"date": "2026-06-24", "wait": True},
    )
    assert failed.status_code == 200
    job_id = failed.json()["job"]["id"]

    retried = client.post(
        "/v1/daily/today/generate",
        headers=headers,
        json={"date": "2026-06-24", "force": True, "wait": True},
    )
    assert retried.status_code == 200
    retried_body = retried.json()
    assert retried_body["status"] == "ready"
    assert retried_body["job"]["id"] == job_id
    assert retried_body["job"]["status"] == "succeeded"
    assert generator.runs == [
        {"job_id": job_id, "resume": False},
        {"job_id": job_id, "resume": True},
    ]


def test_daily_generation_resume_without_batches_starts_fresh_job_for_allowlisted_user(
    tmp_path: Path,
    monkeypatch,
) -> None:
    monkeypatch.setattr("openband.daily.TEMP_PRE_SUNO_RETRY_USER_IDS", {1})
    generator = PreSunoFailThenSucceedDailyGenerator()
    client = TestClient(
        create_app(
            model_path=tmp_path / "missing-model.joblib",
            auth_db_path=tmp_path / "openband.sqlite3",
            song_storage_root=tmp_path / "songs",
            admin_key=ADMIN_KEY,
            daily_generator=generator,
        )
    )
    headers = _login_headers(client)

    failed = client.post(
        "/v1/daily/today/generate",
        headers=headers,
        json={"date": "2026-06-25", "wait": True},
    )
    assert failed.status_code == 200
    failed_body = failed.json()
    failed_job_id = failed_body["job"]["id"]
    assert failed_body["status"] == "failed"
    assert failed_body["job"]["batches"] == []

    retried = client.post(
        "/v1/daily/today/generate",
        headers=headers,
        json={"date": "2026-06-25", "resume": True, "wait": True},
    )
    assert retried.status_code == 200
    retried_body = retried.json()
    retried_job_id = retried_body["job"]["id"]
    assert retried_body["status"] == "ready"
    assert retried_job_id != failed_job_id
    assert retried_body["job"]["status"] == "succeeded"
    assert generator.runs == [
        {"job_id": failed_job_id, "resume": False},
        {"job_id": retried_job_id, "resume": False},
    ]


def test_daily_generation_resume_without_batches_still_409s_for_other_users(tmp_path: Path) -> None:
    generator = PreSunoFailThenSucceedDailyGenerator()
    client = TestClient(
        create_app(
            model_path=tmp_path / "missing-model.joblib",
            auth_db_path=tmp_path / "openband.sqlite3",
            song_storage_root=tmp_path / "songs",
            admin_key=ADMIN_KEY,
            daily_generator=generator,
        )
    )
    headers = _login_headers(client)

    failed = client.post(
        "/v1/daily/today/generate",
        headers=headers,
        json={"date": "2026-06-25", "wait": True},
    )
    assert failed.status_code == 200
    failed_body = failed.json()
    failed_job_id = failed_body["job"]["id"]
    assert failed_body["status"] == "failed"
    assert failed_body["job"]["batches"] == []

    retried = client.post(
        "/v1/daily/today/generate",
        headers=headers,
        json={"date": "2026-06-25", "resume": True, "wait": True},
    )
    assert retried.status_code == 409
    assert retried.json()["detail"] == "No resumable daily job found for this user, date, and playlist."
    assert generator.runs == [{"job_id": failed_job_id, "resume": False}]


def test_daily_generation_resume_uses_requested_job_id_not_latest_failed_job(tmp_path: Path) -> None:
    generator = ResumeAwareDailyGenerator()
    app = create_app(
        model_path=tmp_path / "missing-model.joblib",
        auth_db_path=tmp_path / "openband.sqlite3",
        song_storage_root=tmp_path / "songs",
        admin_key=ADMIN_KEY,
        daily_generator=generator,
    )
    client = TestClient(app)
    headers = _login_headers(client)
    user_id = client.get("/v1/me", headers=headers).json()["user"]["id"]

    failed = client.post(
        "/v1/daily/today/generate",
        headers=headers,
        json={"date": "2026-06-26", "wait": True},
    )
    assert failed.status_code == 200
    failed_body = failed.json()
    original_job_id = failed_body["job"]["id"]
    playlist_id = failed_body["playlist"]["id"]

    newer_job = app.state.daily_store.create_job(
        user_id=user_id,
        date_value="2026-06-26",
        daily_playlist_id=playlist_id,
    )
    newer_batches = app.state.daily_store.create_suno_batches(
        daily_job_id=newer_job.id,
        user_id=user_id,
        date_value="2026-06-26",
        daily_playlist_id=playlist_id,
        batches=[
            {
                "batch_index": 1,
                "position_start": 1,
                "position_end": 5,
                "prompt_files": ["mock/newer-01.md"],
                "state_path": f"mock/{newer_job.id}/suno-batch-01-state.json",
            }
        ],
    )
    app.state.daily_store.mark_suno_batch_failed(
        batch_id=newer_batches[0].id,
        error="newer failed",
        stage="download_failed",
    )
    app.state.daily_store.mark_job_failed(job_id=newer_job.id, error="newer failed")
    app.state.daily_store.set_playlist_status(
        playlist_id=playlist_id,
        status="failed",
        job_id=newer_job.id,
        error="newer failed",
        completed=True,
    )

    retried = client.post(
        "/v1/daily/today/generate",
        headers=headers,
        json={
            "date": "2026-06-26",
            "resume": True,
            "job_id": original_job_id,
            "wait": True,
        },
    )
    assert retried.status_code == 200
    retried_body = retried.json()
    assert retried_body["status"] == "ready"
    assert retried_body["job"]["id"] == original_job_id
    assert generator.runs == [
        {"job_id": original_job_id, "resume": False},
        {"job_id": original_job_id, "resume": True},
    ]


def test_daily_generation_captcha_required_is_resumable_not_playlist_failed(tmp_path: Path) -> None:
    generator = ResumeAwareDailyGenerator(
        failure_stage="captcha_required",
        failure_message=(
            "Suno needs human verification before continuing. "
            "Open https://suno.com/create in Chrome, finish the CAPTCHA, then rerun daily generation. "
            "Batch 1 is resumable."
        ),
    )
    client = TestClient(
        create_app(
            model_path=tmp_path / "missing-model.joblib",
            auth_db_path=tmp_path / "openband.sqlite3",
            song_storage_root=tmp_path / "songs",
            admin_key=ADMIN_KEY,
            daily_generator=generator,
        )
    )
    headers = _login_headers(client)

    blocked = client.post(
        "/v1/daily/today/generate",
        headers=headers,
        json={"date": "2026-06-25", "wait": True},
    )
    assert blocked.status_code == 200
    blocked_body = blocked.json()
    job_id = blocked_body["job"]["id"]
    assert blocked_body["status"] == "captcha_required"
    assert blocked_body["playlist"]["status"] == "captcha_required"
    assert blocked_body["job"]["status"] == "failed"
    assert blocked_body["job"]["stage"] == "captcha_required"
    assert blocked_body["job"]["batches"][0]["stage"] == "captcha_required"

    retried = client.post(
        "/v1/daily/today/generate",
        headers=headers,
        json={"date": "2026-06-25", "resume": True, "wait": True},
    )
    assert retried.status_code == 200
    retried_body = retried.json()
    assert retried_body["status"] == "ready"
    assert retried_body["job"]["id"] == job_id
    assert retried_body["job"]["status"] == "succeeded"
    assert generator.runs == [
        {"job_id": job_id, "resume": False},
        {"job_id": job_id, "resume": True},
    ]
