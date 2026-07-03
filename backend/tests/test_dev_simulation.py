from pathlib import Path

from fastapi.testclient import TestClient

from music_taste_rec.api import create_app


ADMIN_KEY = "admin-test-key"


def _create_user(client: TestClient) -> tuple[int, dict[str, str]]:
    invite = client.post(
        "/v1/auth/invite-keys",
        headers={"X-Admin-Key": ADMIN_KEY},
        json={"label": "Dev Simulator"},
    )
    assert invite.status_code == 200
    login = client.post(
        "/v1/auth/login",
        json={"key": invite.json()["key"], "device_name": "pytest"},
    )
    assert login.status_code == 200
    body = login.json()
    return int(body["user"]["id"]), {"Authorization": f"Bearer {body['access_token']}"}


def test_dev_daily_simulation_creates_ready_daily(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("OPENBAND_DAILY_RUNTIME_ROOT", str(tmp_path / "daily-runtime"))
    app = create_app(
        model_path=tmp_path / "missing-model.joblib",
        auth_db_path=tmp_path / "openband.sqlite3",
        song_storage_root=tmp_path / "songs",
        admin_key=ADMIN_KEY,
    )
    client = TestClient(app)
    user_id, user_headers = _create_user(client)

    forbidden = client.post(
        "/v1/dev/daily/simulate",
        json={"user_id": user_id, "date": "2026-06-25"},
    )
    assert forbidden.status_code == 403

    simulated = client.post(
        "/v1/dev/daily/simulate",
        headers={"X-Admin-Key": ADMIN_KEY},
        json={
            "user_id": user_id,
            "date": "2026-06-25",
            "count": 3,
            "duration_seconds": 2,
            "tags": ["8bit", "j pop", "anime", "chiptune"],
            "title_prefix": "Dev",
        },
    )
    assert simulated.status_code == 200
    body = simulated.json()
    assert body["status"] == "ready"
    assert body["mode"] == "ready"
    assert body["job"]["status"] == "succeeded"
    assert body["job"]["result"]["simulated"] is True
    assert len(body["job"]["batches"]) == 1
    assert len(body["prompt_files"]) == 3
    assert len(body["playlist"]["songs"]) == 3
    assert body["playlist"]["prompt_seed"]["simulated"] is True
    assert body["playlist"]["songs"][0]["song"]["source"] == "simulated-daily"
    assert body["playlist"]["songs"][0]["song"]["has_cover"] is True

    prompt_file = Path(body["playlist"]["songs"][0]["prompt_file"])
    assert prompt_file.exists()
    assert "OpenTunes dev simulation" in prompt_file.read_text(encoding="utf-8")
    state_path = Path(body["job"]["batches"][0]["state_path"])
    assert state_path.exists()
    assert '"simulated": true' in state_path.read_text(encoding="utf-8")

    today = client.get("/v1/daily/today?date=2026-06-25", headers=user_headers)
    assert today.status_code == 200
    assert today.json()["playlist"]["song_count"] == 3


def test_dev_daily_simulation_can_stop_after_prompts(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("OPENBAND_DAILY_RUNTIME_ROOT", str(tmp_path / "daily-runtime"))
    app = create_app(
        model_path=tmp_path / "missing-model.joblib",
        auth_db_path=tmp_path / "openband.sqlite3",
        song_storage_root=tmp_path / "songs",
        admin_key=ADMIN_KEY,
    )
    client = TestClient(app)
    user_id, user_headers = _create_user(client)

    simulated = client.post(
        "/v1/dev/daily/simulate",
        headers={"X-Admin-Key": ADMIN_KEY},
        json={
            "user_id": user_id,
            "date": "2026-06-26",
            "count": 2,
            "mode": "prompt_only",
            "tags": ["8bit", "j pop", "anime", "chiptune"],
            "title_prefix": "Prompt",
        },
    )
    assert simulated.status_code == 200
    body = simulated.json()
    assert body["status"] == "prompt_ready"
    assert body["mode"] == "prompt_only"
    assert body["job"]["status"] == "succeeded"
    assert body["job"]["result"]["prompt_count"] == 2
    assert body["job"]["result"]["song_count"] == 0
    assert body["job"]["batches"] == []
    assert len(body["prompt_files"]) == 2
    assert body["playlist"]["song_count"] == 0
    assert body["playlist"]["songs"] == []
    assert body["playlist"]["prompt_seed"]["mode"] == "prompt_only"

    prompt_file = Path(body["prompt_files"][0])
    assert prompt_file.exists()
    prompt_text = prompt_file.read_text(encoding="utf-8")
    assert "## Style Prompt" in prompt_text
    assert "## Lyrics" in prompt_text

    today = client.get("/v1/daily/today?date=2026-06-26", headers=user_headers)
    assert today.status_code == 200
    assert today.json()["status"] == "prompt_ready"
    assert today.json()["playlist"]["song_count"] == 0


def test_dev_single_song_simulation_modes(tmp_path: Path) -> None:
    app = create_app(
        model_path=tmp_path / "missing-model.joblib",
        auth_db_path=tmp_path / "openband.sqlite3",
        song_storage_root=tmp_path / "songs",
        admin_key=ADMIN_KEY,
    )
    client = TestClient(app)

    prompt_only = client.post(
        "/v1/dev/songs/simulate",
        headers={"X-Admin-Key": ADMIN_KEY},
        json={
            "title": "Prompt Only Single",
            "mode": "prompt_only",
            "tags": ["chiptune", "j pop"],
        },
    )
    assert prompt_only.status_code == 200
    prompt_body = prompt_only.json()
    assert prompt_body["status"] == "prompt_ready"
    assert prompt_body["song"] is None
    assert Path(prompt_body["prompt_file"]).exists()
    assert "Prompt Only Single" in Path(prompt_body["prompt_file"]).read_text(encoding="utf-8")

    ready = client.post(
        "/v1/dev/songs/simulate",
        headers={"X-Admin-Key": ADMIN_KEY},
        json={
            "title": "Ready Single",
            "duration_seconds": 2,
            "tags": ["chiptune", "j pop"],
        },
    )
    assert ready.status_code == 200
    ready_body = ready.json()
    assert ready_body["status"] == "ready"
    assert ready_body["song"]["title"] == "Ready Single"
    assert ready_body["song"]["source"] == "simulated-single"
    assert ready_body["song"]["has_cover"] is True
