from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient
from mutagen.id3 import APIC, ID3

from openband.auth import AuthStore
from openband.songs import SongStore, create_song_router, utc_now


PNG_BYTES = (
    b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01"
    b"\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15\xc4\x89"
    b"\x00\x00\x00\rIDATx\x9cc\xf8\xff\xff?\x00\x05\xfe"
    b"\x02\xfeA\xe2&\xb8\x00\x00\x00\x00IEND\xaeB`\x82"
)


class FakeObjectStorage:
    def __init__(self) -> None:
        self.objects: dict[str, tuple[bytes, str]] = {}

    def upload_file(self, key: str, source: Path, content_type: str) -> None:
        self.objects[key] = (Path(source).read_bytes(), content_type)

    def upload_bytes(self, key: str, data: bytes, content_type: str) -> None:
        self.objects[key] = (bytes(data), content_type)

    def exists(self, key: str) -> bool:
        return key in self.objects

    def delete(self, key: str) -> None:
        self.objects.pop(key, None)

    def presigned_get_url(self, key, *, expires_in=3600, download_filename=None, content_type=None) -> str:
        return f"https://fake-r2.example/{key}?exp={expires_in}"


def _make_mp3(path: Path, *, with_cover: bool = True) -> Path:
    tags = ID3()
    if with_cover:
        tags.add(APIC(encoding=3, mime="image/png", type=3, desc="Cover", data=PNG_BYTES))
    tags.save(path)
    return path


def _store(tmp_path: Path, storage: FakeObjectStorage | None) -> SongStore:
    return SongStore(
        tmp_path / "openband.sqlite3",
        tmp_path / "songs",
        object_storage=storage,
        cache_days=7,
        url_ttl=900,
    )


def _ingest(store: SongStore, tmp_path: Path, *, with_cover: bool = True):
    src = _make_mp3(tmp_path / "src.mp3", with_cover=with_cover)
    return store.create_song_from_file(source_path=src, title="Test Song", tags="rock")


def test_ingest_offloads_audio_and_cover_to_r2(tmp_path: Path) -> None:
    storage = FakeObjectStorage()
    store = _store(tmp_path, storage)
    song = _ingest(store, tmp_path)

    assert song.has_cover is True
    assert SongStore.audio_key(song.id) in storage.objects
    assert SongStore.cover_key(song.id) in storage.objects
    # The DB round-trips has_cover.
    assert store.get_song(song.id).has_cover is True


def test_ingest_without_cover_sets_flag_false(tmp_path: Path) -> None:
    storage = FakeObjectStorage()
    store = _store(tmp_path, storage)
    song = _ingest(store, tmp_path, with_cover=False)

    assert song.has_cover is False
    assert SongStore.audio_key(song.id) in storage.objects
    assert SongStore.cover_key(song.id) not in storage.objects


def _router_client(store: SongStore) -> TestClient:
    app = FastAPI()
    app.include_router(
        create_song_router(
            store=store,
            auth_store=AuthStore(store.db_path),
            admin_key=None,
            require_auth=False,
        )
    )
    return TestClient(app)


def test_audio_serves_local_first_when_cached(tmp_path: Path) -> None:
    storage = FakeObjectStorage()
    store = _store(tmp_path, storage)
    song = _ingest(store, tmp_path)
    client = _router_client(store)

    response = client.get(f"/v1/songs/{song.id}/audio", follow_redirects=False)
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("audio/")


def test_audio_redirects_to_r2_when_local_pruned(tmp_path: Path) -> None:
    storage = FakeObjectStorage()
    store = _store(tmp_path, storage)
    song = _ingest(store, tmp_path)
    Path(song.file_path).unlink()  # simulate the 7-day prune having removed the cache
    client = _router_client(store)

    response = client.get(f"/v1/songs/{song.id}/audio", follow_redirects=False)
    assert response.status_code == 302
    assert SongStore.audio_key(song.id) in response.headers["location"]


def test_cover_redirects_to_r2_when_local_pruned(tmp_path: Path) -> None:
    storage = FakeObjectStorage()
    store = _store(tmp_path, storage)
    song = _ingest(store, tmp_path)
    Path(song.file_path).unlink()
    client = _router_client(store)

    response = client.get(f"/v1/songs/{song.id}/cover", follow_redirects=False)
    assert response.status_code == 302
    assert SongStore.cover_key(song.id) in response.headers["location"]


def test_audio_404_without_r2_when_local_missing(tmp_path: Path) -> None:
    store = _store(tmp_path, None)  # pure local, no R2
    song = _ingest(store, tmp_path)
    Path(song.file_path).unlink()
    client = _router_client(store)

    response = client.get(f"/v1/songs/{song.id}/audio", follow_redirects=False)
    assert response.status_code == 404


def _set_created_at(store: SongStore, song_id: str, value: str) -> None:
    with store._connect() as conn:
        conn.execute("UPDATE songs SET created_at = ? WHERE id = ?", (value, song_id))


def test_prune_removes_old_cache_when_in_r2(tmp_path: Path) -> None:
    storage = FakeObjectStorage()
    store = _store(tmp_path, storage)
    song = _ingest(store, tmp_path)
    _set_created_at(store, song.id, "2000-01-01T00:00:00Z")

    removed = store.prune_local_cache()
    assert removed == 1
    assert not Path(song.file_path).exists()
    # R2 still holds the authoritative copy.
    assert SongStore.audio_key(song.id) in storage.objects


def test_prune_keeps_recent_cache(tmp_path: Path) -> None:
    storage = FakeObjectStorage()
    store = _store(tmp_path, storage)
    song = _ingest(store, tmp_path)  # created_at is now

    removed = store.prune_local_cache()
    assert removed == 0
    assert Path(song.file_path).exists()


def test_prune_keeps_cache_when_not_in_r2(tmp_path: Path) -> None:
    storage = FakeObjectStorage()
    store = _store(tmp_path, storage)
    song = _ingest(store, tmp_path)
    _set_created_at(store, song.id, "2000-01-01T00:00:00Z")
    storage.delete(SongStore.audio_key(song.id))  # R2 copy missing -> must not delete local

    removed = store.prune_local_cache()
    assert removed == 0
    assert Path(song.file_path).exists()


def test_prune_noop_without_r2(tmp_path: Path) -> None:
    store = _store(tmp_path, None)
    song = _ingest(store, tmp_path)
    _set_created_at(store, song.id, "2000-01-01T00:00:00Z")

    removed = store.prune_local_cache()
    assert removed == 0
    assert Path(song.file_path).exists()


def test_offload_existing_backfills_and_sets_has_cover(tmp_path: Path) -> None:
    # Ingest while local-only, then attach R2 and backfill.
    store_local = _store(tmp_path, None)
    song = _ingest(store_local, tmp_path)
    assert SongStore.audio_key(song.id)  # sanity

    storage = FakeObjectStorage()
    store = _store(tmp_path, storage)  # same db + storage_root, now with R2
    result = store.offload_existing_to_r2()

    assert result["uploaded"] == 1
    assert result["covers"] == 1
    assert SongStore.audio_key(song.id) in storage.objects
    assert SongStore.cover_key(song.id) in storage.objects
    assert store.get_song(song.id).has_cover is True
