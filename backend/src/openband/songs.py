from __future__ import annotations

import hashlib
import secrets
import shutil
import sqlite3
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Annotated, Any

from fastapi import APIRouter, Depends, File, Form, Header, HTTPException, Query, Response, UploadFile
from fastapi.responses import FileResponse, RedirectResponse
from mutagen import MutagenError
from mutagen.id3 import ID3, ID3NoHeaderError
from pydantic import BaseModel, Field

from music_taste_rec.style_model import parse_style_tags
from openband.auth import AuthUser, current_user_dependency
from openband.storage import (
    DEFAULT_LOCAL_CACHE_DAYS,
    DEFAULT_URL_TTL_SECONDS,
    ObjectStorage,
)


DEFAULT_SONG_STORAGE_ROOT = Path("storage/songs")
SONG_STORAGE_ROOT_ENV = "OPENBAND_SONG_STORAGE_ROOT"
MP3_CHUNK_SIZE = 1024 * 1024
LIKED_PLAYLIST_ID = "playlist_liked_music"
LIKED_PLAYLIST_NAME = "Liked Music"
LIKED_PLAYLIST_DESCRIPTION = "Songs you have liked"
SYSTEM_PLAYLIST_TIMESTAMP = "1970-01-01T00:00:00Z"
PLAYLIST_EFFECTIVE_COVER_SQL = """
COALESCE(
    (
        SELECT playlist_songs.song_id
        FROM playlist_songs
        JOIN songs ON songs.id = playlist_songs.song_id
        WHERE playlist_songs.playlist_id = playlists.id
          AND playlist_songs.song_id = playlists.cover_song_id
          AND songs.deleted_at IS NULL
        LIMIT 1
    ),
    (
        SELECT playlist_songs.song_id
        FROM playlist_songs
        JOIN songs ON songs.id = playlist_songs.song_id
        WHERE playlist_songs.playlist_id = playlists.id
          AND songs.deleted_at IS NULL
        ORDER BY playlist_songs.position ASC, datetime(playlist_songs.added_at) ASC, playlist_songs.song_id ASC
        LIMIT 1
    )
) AS effective_cover_song_id
"""


@dataclass(frozen=True)
class StoredSong:
    id: str
    title: str
    artist: str
    album: str
    duration_seconds: int | None
    source: str
    original_filename: str
    file_path: str
    file_size: int
    file_sha256: str
    mime_type: str
    created_at: str
    updated_at: str
    tags: list[str]
    has_cover: bool = False


@dataclass(frozen=True)
class SongLike:
    song_id: str
    is_liked: bool
    liked_at: str | None


@dataclass(frozen=True)
class StoredPlaylist:
    id: str
    user_id: int
    name: str
    description: str
    song_count: int
    created_at: str
    updated_at: str
    cover_song_id: str | None = None
    kind: str = "user"
    is_system: bool = False


@dataclass(frozen=True)
class Mp3Cover:
    data: bytes
    mime_type: str
    file_sha256: str


class SongResponse(BaseModel):
    id: str
    title: str
    artist: str
    album: str
    duration_seconds: int | None
    source: str
    original_filename: str
    file_size: int
    file_sha256: str
    mime_type: str
    tags: list[str]
    audio_url: str
    download_url: str
    cover_url: str
    has_cover: bool = False
    is_liked: bool = False
    liked_at: str | None = None
    created_at: str
    updated_at: str


class SongListResponse(BaseModel):
    songs: list[SongResponse]
    limit: int
    offset: int
    total: int


class SongLikeResponse(BaseModel):
    song_id: str
    is_liked: bool
    liked_at: str | None = None


class CreatePlaylistRequest(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: str = Field(default="", max_length=500)


class UpdatePlaylistRequest(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    description: str | None = Field(default=None, max_length=500)
    cover_song_id: str | None = Field(default=None, max_length=120)


class AddPlaylistSongRequest(BaseModel):
    song_id: str = Field(min_length=1, max_length=120)


class PlaylistResponse(BaseModel):
    id: str
    name: str
    description: str
    song_count: int
    cover_song_id: str | None = None
    kind: str = "user"
    is_system: bool = False
    can_delete: bool = True
    created_at: str
    updated_at: str


class PlaylistListResponse(BaseModel):
    playlists: list[PlaylistResponse]
    total: int


class PlaylistDetailResponse(PlaylistResponse):
    songs: list[SongResponse]


class SongStore:
    def __init__(
        self,
        db_path: Path,
        storage_root: Path = DEFAULT_SONG_STORAGE_ROOT,
        *,
        object_storage: ObjectStorage | None = None,
        cache_days: int = DEFAULT_LOCAL_CACHE_DAYS,
        url_ttl: int = DEFAULT_URL_TTL_SECONDS,
    ):
        self.db_path = Path(db_path)
        self.storage_root = Path(storage_root)
        self.object_storage = object_storage
        self.cache_days = cache_days
        self.url_ttl = url_ttl
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self.storage_root.mkdir(parents=True, exist_ok=True)
        self._initialize()

    @staticmethod
    def audio_key(song_id: str) -> str:
        return f"songs/{song_id}.mp3"

    @staticmethod
    def cover_key(song_id: str) -> str:
        return f"covers/{song_id}.jpg"

    def _offload_to_r2(self, song_id: str, final_path: Path, mime_type: str) -> bool:
        """Upload the audio (and extracted cover) to R2. Returns whether a cover exists.

        With no object storage configured the backend stays purely local; the
        return value still reflects whether the MP3 carries embedded cover art so
        the ``/cover`` route can short-circuit consistently.
        """
        cover = extract_mp3_cover(final_path)
        if self.object_storage is None:
            return cover is not None
        self.object_storage.upload_file(self.audio_key(song_id), final_path, mime_type or "audio/mpeg")
        if cover is not None:
            self.object_storage.upload_bytes(self.cover_key(song_id), cover.data, cover.mime_type)
        return cover is not None

    def local_audio_path(self, song: StoredSong) -> Path | None:
        """The cached local MP3 if it still exists, else ``None`` (pruned/offloaded)."""
        path = Path(song.file_path)
        return path if path.exists() else None

    def audio_redirect_url(self, song: StoredSong) -> str | None:
        if self.object_storage is None:
            return None
        return self.object_storage.presigned_get_url(
            self.audio_key(song.id),
            expires_in=self.url_ttl,
            download_filename=song.original_filename,
            content_type=song.mime_type or "audio/mpeg",
        )

    def cover_redirect_url(self, song: StoredSong) -> str | None:
        if self.object_storage is None or not song.has_cover:
            return None
        return self.object_storage.presigned_get_url(
            self.cover_key(song.id),
            expires_in=self.url_ttl,
        )

    def prune_local_cache(self, *, now: datetime | None = None) -> int:
        """Delete cached local MP3s older than ``cache_days`` once R2 has the copy.

        Never deletes anything when R2 is not configured (local is then the only
        copy). Returns the number of files removed.
        """
        if self.object_storage is None:
            return 0
        now = now or datetime.now(UTC)
        cutoff = now - timedelta(days=self.cache_days)
        removed = 0
        with self._connect() as conn:
            rows = conn.execute("SELECT id, file_path, created_at FROM songs").fetchall()
        for row in rows:
            path = Path(row["file_path"])
            if not path.exists():
                continue
            created = _parse_iso_timestamp(row["created_at"])
            if created is None or created > cutoff:
                continue
            if not self.object_storage.exists(self.audio_key(row["id"])):
                continue
            path.unlink(missing_ok=True)
            removed += 1
        return removed

    def offload_existing_to_r2(self, *, overwrite: bool = False) -> dict[str, int]:
        """Backfill: ensure every existing song's audio and cover live in R2."""
        if self.object_storage is None:
            raise RuntimeError("R2 object storage is not configured.")
        with self._connect() as conn:
            rows = conn.execute("SELECT id, file_path, mime_type FROM songs").fetchall()
        uploaded = covers = skipped = missing = 0
        for row in rows:
            song_id = row["id"]
            path = Path(row["file_path"])
            if not path.exists():
                missing += 1
                continue
            audio_key = self.audio_key(song_id)
            if not overwrite and self.object_storage.exists(audio_key):
                skipped += 1
            else:
                self.object_storage.upload_file(audio_key, path, row["mime_type"] or "audio/mpeg")
                uploaded += 1
            cover = extract_mp3_cover(path)
            has_cover = cover is not None
            if has_cover:
                self.object_storage.upload_bytes(self.cover_key(song_id), cover.data, cover.mime_type)
                covers += 1
            with self._connect() as conn:
                conn.execute("UPDATE songs SET has_cover = ? WHERE id = ?", (1 if has_cover else 0, song_id))
        return {"uploaded": uploaded, "covers": covers, "skipped": skipped, "missing": missing}

    async def create_song_from_upload(
        self,
        *,
        upload: UploadFile,
        title: str,
        artist: str = "AI",
        album: str = "",
        tags: str | list[str] = "",
        duration_seconds: int | None = None,
        source: str = "manual",
    ) -> StoredSong:
        filename = Path(upload.filename or "song.mp3").name
        if filename.lower().endswith(".mp3") is False:
            raise ValueError("Only .mp3 files are supported.")

        song_id = f"song_{secrets.token_urlsafe(12).replace('-', '').replace('_', '')}"
        temp_path = self.storage_root / f"{song_id}.uploading"
        final_path = self.storage_root / f"{song_id}.mp3"
        hasher = hashlib.sha256()
        file_size = 0

        try:
            with temp_path.open("wb") as output:
                while chunk := await upload.read(MP3_CHUNK_SIZE):
                    file_size += len(chunk)
                    hasher.update(chunk)
                    output.write(chunk)
            if file_size == 0:
                raise ValueError("MP3 file is empty.")
            shutil.move(str(temp_path), final_path)
        finally:
            temp_path.unlink(missing_ok=True)

        now = utc_now()
        clean_tags = _clean_song_tags(tags)
        mime_type = upload.content_type or "audio/mpeg"
        has_cover = self._offload_to_r2(song_id, final_path, mime_type)
        song = StoredSong(
            id=song_id,
            title=title.strip(),
            artist=artist.strip() or "AI",
            album=album.strip(),
            duration_seconds=duration_seconds,
            source=source.strip() or "manual",
            original_filename=filename,
            file_path=str(final_path),
            file_size=file_size,
            file_sha256=hasher.hexdigest(),
            mime_type=mime_type,
            created_at=now,
            updated_at=now,
            tags=clean_tags,
            has_cover=has_cover,
        )
        self._insert_song(song)
        return song

    def create_song_from_file(
        self,
        *,
        source_path: Path,
        title: str,
        artist: str = "AI",
        album: str = "",
        tags: str | list[str] = "",
        duration_seconds: int | None = None,
        source: str = "manual",
        offload_to_object_storage: bool = True,
    ) -> StoredSong:
        source_path = Path(source_path)
        filename = source_path.name
        if filename.lower().endswith(".mp3") is False:
            raise ValueError("Only .mp3 files are supported.")
        if not source_path.exists():
            raise ValueError(f"MP3 file not found: {source_path}")

        song_id = f"song_{secrets.token_urlsafe(12).replace('-', '').replace('_', '')}"
        temp_path = self.storage_root / f"{song_id}.uploading"
        final_path = self.storage_root / f"{song_id}.mp3"
        hasher = hashlib.sha256()
        file_size = 0

        try:
            with source_path.open("rb") as input_file, temp_path.open("wb") as output:
                while chunk := input_file.read(MP3_CHUNK_SIZE):
                    file_size += len(chunk)
                    hasher.update(chunk)
                    output.write(chunk)
            if file_size == 0:
                raise ValueError("MP3 file is empty.")
            shutil.move(str(temp_path), final_path)
        finally:
            temp_path.unlink(missing_ok=True)

        now = utc_now()
        clean_tags = _clean_song_tags(tags)
        has_cover = (
            self._offload_to_r2(song_id, final_path, "audio/mpeg")
            if offload_to_object_storage
            else extract_mp3_cover(final_path) is not None
        )
        song = StoredSong(
            id=song_id,
            title=title.strip(),
            artist=artist.strip() or "AI",
            album=album.strip(),
            duration_seconds=duration_seconds,
            source=source.strip() or "manual",
            original_filename=filename,
            file_path=str(final_path),
            file_size=file_size,
            file_sha256=hasher.hexdigest(),
            mime_type="audio/mpeg",
            created_at=now,
            updated_at=now,
            tags=clean_tags,
            has_cover=has_cover,
        )
        self._insert_song(song)
        return song

    def _insert_song(self, song: StoredSong) -> None:
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO songs (
                    id, title, artist, album, duration_seconds, source,
                    original_filename, file_path, file_size, file_sha256,
                    mime_type, created_at, updated_at, has_cover
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    song.id,
                    song.title,
                    song.artist,
                    song.album,
                    song.duration_seconds,
                    song.source,
                    song.original_filename,
                    song.file_path,
                    song.file_size,
                    song.file_sha256,
                    song.mime_type,
                    song.created_at,
                    song.updated_at,
                    1 if song.has_cover else 0,
                ),
            )
            self._replace_tags(conn, song.id, song.tags)

    def list_songs(
        self,
        *,
        limit: int = 50,
        offset: int = 0,
        tag: str | None = None,
        q: str | None = None,
    ) -> tuple[list[StoredSong], int]:
        clean_tags = _clean_song_tags([tag]) if tag else []
        clean_tag = clean_tags[0] if clean_tags else None
        query = (q or "").strip()
        where = "WHERE songs.deleted_at IS NULL"
        params: list[Any] = []
        if clean_tag:
            where += " AND EXISTS (SELECT 1 FROM song_tags WHERE song_tags.song_id = songs.id AND tag = ?)"
            params.append(clean_tag)
        if query:
            like_query = _like_pattern(query)
            where += """
                AND (
                    songs.title LIKE ? ESCAPE '\\' COLLATE NOCASE
                    OR songs.artist LIKE ? ESCAPE '\\' COLLATE NOCASE
                    OR songs.album LIKE ? ESCAPE '\\' COLLATE NOCASE
                    OR songs.original_filename LIKE ? ESCAPE '\\' COLLATE NOCASE
                    OR EXISTS (
                        SELECT 1
                        FROM song_tags
                        WHERE song_tags.song_id = songs.id
                          AND song_tags.tag LIKE ? ESCAPE '\\' COLLATE NOCASE
                    )
                )
            """
            params.extend([like_query, like_query, like_query, like_query, like_query])

        with self._connect() as conn:
            total = int(
                conn.execute(
                    f"SELECT COUNT(*) AS count FROM songs {where}",
                    params,
                ).fetchone()["count"]
            )
            rows = conn.execute(
                f"""
                SELECT songs.*
                FROM songs
                {where}
                ORDER BY datetime(created_at) DESC, id DESC
                LIMIT ? OFFSET ?
                """,
                [*params, limit, offset],
            ).fetchall()
            songs = [self._song_from_row(conn, row) for row in rows]
        return songs, total

    def get_song(self, song_id: str) -> StoredSong:
        with self._connect() as conn:
            row = conn.execute(
                """
                SELECT *
                FROM songs
                WHERE id = ? AND deleted_at IS NULL
                """,
                (song_id,),
            ).fetchone()
            if row is None:
                raise KeyError(song_id)
            return self._song_from_row(conn, row)

    def liked_at_for_songs(self, user_id: int, song_ids: list[str]) -> dict[str, str]:
        if not song_ids:
            return {}
        placeholders = ",".join("?" for _ in song_ids)
        with self._connect() as conn:
            rows = conn.execute(
                f"""
                SELECT song_id, liked_at
                FROM user_liked_songs
                WHERE user_id = ? AND song_id IN ({placeholders})
                """,
                [user_id, *song_ids],
            ).fetchall()
        return {row["song_id"]: row["liked_at"] for row in rows}

    def like_song(self, user_id: int, song_id: str) -> SongLike:
        now = utc_now()
        with self._connect() as conn:
            if not self._song_exists(conn, song_id):
                raise KeyError(song_id)
            conn.execute(
                """
                INSERT INTO user_liked_songs (user_id, song_id, liked_at)
                VALUES (?, ?, ?)
                ON CONFLICT(user_id, song_id)
                DO UPDATE SET liked_at = excluded.liked_at
                """,
                (user_id, song_id, now),
            )
        return SongLike(song_id=song_id, is_liked=True, liked_at=now)

    def unlike_song(self, user_id: int, song_id: str) -> SongLike:
        with self._connect() as conn:
            if not self._song_exists(conn, song_id):
                raise KeyError(song_id)
            conn.execute(
                """
                DELETE FROM user_liked_songs
                WHERE user_id = ? AND song_id = ?
                """,
                (user_id, song_id),
            )
        return SongLike(song_id=song_id, is_liked=False, liked_at=None)

    def get_song_like(self, user_id: int, song_id: str) -> SongLike:
        with self._connect() as conn:
            if not self._song_exists(conn, song_id):
                raise KeyError(song_id)
            row = conn.execute(
                """
                SELECT liked_at
                FROM user_liked_songs
                WHERE user_id = ? AND song_id = ?
                """,
                (user_id, song_id),
            ).fetchone()
        return SongLike(
            song_id=song_id,
            is_liked=row is not None,
            liked_at=row["liked_at"] if row is not None else None,
        )

    def list_liked_songs(
        self,
        *,
        user_id: int,
        limit: int = 50,
        offset: int = 0,
    ) -> tuple[list[StoredSong], int, dict[str, str]]:
        with self._connect() as conn:
            total = int(
                conn.execute(
                    """
                    SELECT COUNT(*) AS count
                    FROM user_liked_songs
                    JOIN songs ON songs.id = user_liked_songs.song_id
                    WHERE user_liked_songs.user_id = ? AND songs.deleted_at IS NULL
                    """,
                    (user_id,),
                ).fetchone()["count"]
            )
            rows = conn.execute(
                """
                SELECT songs.*, user_liked_songs.liked_at AS liked_at
                FROM user_liked_songs
                JOIN songs ON songs.id = user_liked_songs.song_id
                WHERE user_liked_songs.user_id = ? AND songs.deleted_at IS NULL
                ORDER BY datetime(user_liked_songs.liked_at) DESC, songs.id DESC
                LIMIT ? OFFSET ?
                """,
                (user_id, limit, offset),
            ).fetchall()
            songs = [self._song_from_row(conn, row) for row in rows]
            liked_at_by_song_id = {row["id"]: row["liked_at"] for row in rows}
        return songs, total, liked_at_by_song_id

    def create_playlist(self, *, user_id: int, name: str, description: str = "") -> StoredPlaylist:
        playlist_id = f"playlist_{secrets.token_urlsafe(10).replace('-', '').replace('_', '')}"
        now = utc_now()
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO playlists (id, user_id, name, description, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (playlist_id, user_id, name.strip(), description.strip(), now, now),
            )
            playlist = self._get_playlist(conn, user_id, playlist_id)
        if playlist is None:
            raise KeyError(playlist_id)
        return playlist

    def list_playlists(self, *, user_id: int) -> tuple[list[StoredPlaylist], int]:
        with self._connect() as conn:
            liked_playlist = self._liked_playlist(conn, user_id)
            rows = conn.execute(
                f"""
                SELECT playlists.*, COUNT(playlist_songs.song_id) AS song_count, {PLAYLIST_EFFECTIVE_COVER_SQL}
                FROM playlists
                LEFT JOIN playlist_songs ON playlist_songs.playlist_id = playlists.id
                WHERE playlists.user_id = ? AND playlists.deleted_at IS NULL
                GROUP BY playlists.id
                ORDER BY datetime(playlists.updated_at) DESC, playlists.id DESC
                """,
                (user_id,),
            ).fetchall()
        playlists = [liked_playlist, *[playlist_from_row(row) for row in rows]]
        return playlists, len(playlists)

    def update_playlist(
        self,
        *,
        user_id: int,
        playlist_id: str,
        name: str | None = None,
        description: str | None = None,
        cover_song_id: str | None = None,
        update_cover_song_id: bool = False,
    ) -> tuple[StoredPlaylist, list[StoredSong]]:
        if playlist_id == LIKED_PLAYLIST_ID:
            raise ValueError("System playlists cannot be edited.")

        now = utc_now()
        updates: list[str] = []
        params: list[Any] = []
        with self._connect() as conn:
            if self._get_playlist(conn, user_id, playlist_id) is None:
                raise KeyError(playlist_id)
            if name is not None:
                clean_name = name.strip()
                if not clean_name:
                    raise ValueError("Playlist name is required.")
                updates.append("name = ?")
                params.append(clean_name)
            if description is not None:
                updates.append("description = ?")
                params.append(description.strip())
            if update_cover_song_id:
                if cover_song_id is not None and not self._playlist_has_song(conn, playlist_id, cover_song_id):
                    raise KeyError(cover_song_id)
                updates.append("cover_song_id = ?")
                params.append(cover_song_id)
            if updates:
                updates.append("updated_at = ?")
                params.append(now)
                params.extend([playlist_id, user_id])
                conn.execute(
                    f"""
                    UPDATE playlists
                    SET {", ".join(updates)}
                    WHERE id = ? AND user_id = ? AND deleted_at IS NULL
                    """,
                    params,
                )
        return self.get_playlist_detail(user_id=user_id, playlist_id=playlist_id)

    def get_playlist_detail(self, *, user_id: int, playlist_id: str) -> tuple[StoredPlaylist, list[StoredSong]]:
        with self._connect() as conn:
            if playlist_id == LIKED_PLAYLIST_ID:
                return self._liked_playlist(conn, user_id), self._liked_playlist_songs(conn, user_id)
            playlist = self._get_playlist(conn, user_id, playlist_id)
            if playlist is None:
                raise KeyError(playlist_id)
            rows = conn.execute(
                """
                SELECT songs.*
                FROM playlist_songs
                JOIN songs ON songs.id = playlist_songs.song_id
                WHERE playlist_songs.playlist_id = ? AND songs.deleted_at IS NULL
                ORDER BY playlist_songs.position ASC, datetime(playlist_songs.added_at) ASC
                """,
                (playlist_id,),
            ).fetchall()
            songs = [self._song_from_row(conn, row) for row in rows]
        return playlist, songs

    def add_playlist_song(self, *, user_id: int, playlist_id: str, song_id: str) -> tuple[StoredPlaylist, list[StoredSong]]:
        if playlist_id == LIKED_PLAYLIST_ID:
            self.like_song(user_id, song_id)
            return self.get_playlist_detail(user_id=user_id, playlist_id=playlist_id)

        now = utc_now()
        with self._connect() as conn:
            if self._get_playlist(conn, user_id, playlist_id) is None:
                raise KeyError(playlist_id)
            if not self._song_exists(conn, song_id):
                raise KeyError(song_id)
            row = conn.execute(
                """
                SELECT MAX(position) AS max_position
                FROM playlist_songs
                WHERE playlist_id = ?
                """,
                (playlist_id,),
            ).fetchone()
            next_position = int(row["max_position"] or 0)
            if row["max_position"] is not None:
                next_position += 1
            conn.execute(
                """
                INSERT INTO playlist_songs (playlist_id, song_id, position, added_at)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(playlist_id, song_id) DO NOTHING
                """,
                (playlist_id, song_id, next_position, now),
            )
            conn.execute(
                "UPDATE playlists SET updated_at = ? WHERE id = ?",
                (now, playlist_id),
            )
        return self.get_playlist_detail(user_id=user_id, playlist_id=playlist_id)

    def remove_playlist_song(self, *, user_id: int, playlist_id: str, song_id: str) -> tuple[StoredPlaylist, list[StoredSong]]:
        if playlist_id == LIKED_PLAYLIST_ID:
            self.unlike_song(user_id, song_id)
            return self.get_playlist_detail(user_id=user_id, playlist_id=playlist_id)

        now = utc_now()
        with self._connect() as conn:
            if self._get_playlist(conn, user_id, playlist_id) is None:
                raise KeyError(playlist_id)
            conn.execute(
                """
                DELETE FROM playlist_songs
                WHERE playlist_id = ? AND song_id = ?
                """,
                (playlist_id, song_id),
            )
            conn.execute(
                """
                UPDATE playlists
                SET updated_at = ?,
                    cover_song_id = CASE WHEN cover_song_id = ? THEN NULL ELSE cover_song_id END
                WHERE id = ?
                """,
                (now, song_id, playlist_id),
            )
        return self.get_playlist_detail(user_id=user_id, playlist_id=playlist_id)

    def _liked_playlist(self, conn: sqlite3.Connection, user_id: int) -> StoredPlaylist:
        row = conn.execute(
            """
            SELECT
                COUNT(*) AS song_count,
                MIN(user_liked_songs.liked_at) AS created_at,
                MAX(user_liked_songs.liked_at) AS updated_at
            FROM user_liked_songs
            JOIN songs ON songs.id = user_liked_songs.song_id
            WHERE user_liked_songs.user_id = ? AND songs.deleted_at IS NULL
            """,
            (user_id,),
        ).fetchone()
        created_at = row["created_at"] or SYSTEM_PLAYLIST_TIMESTAMP
        updated_at = row["updated_at"] or created_at
        return StoredPlaylist(
            id=LIKED_PLAYLIST_ID,
            user_id=user_id,
            name=LIKED_PLAYLIST_NAME,
            description=LIKED_PLAYLIST_DESCRIPTION,
            song_count=int(row["song_count"]),
            created_at=created_at,
            updated_at=updated_at,
            cover_song_id=self._liked_playlist_cover_song_id(conn, user_id),
            kind="liked",
            is_system=True,
        )

    def _liked_playlist_songs(self, conn: sqlite3.Connection, user_id: int) -> list[StoredSong]:
        rows = conn.execute(
            """
            SELECT songs.*
            FROM user_liked_songs
            JOIN songs ON songs.id = user_liked_songs.song_id
            WHERE user_liked_songs.user_id = ? AND songs.deleted_at IS NULL
            ORDER BY datetime(user_liked_songs.liked_at) DESC, songs.id DESC
            """,
            (user_id,),
        ).fetchall()
        return [self._song_from_row(conn, row) for row in rows]

    def _replace_tags(self, conn: sqlite3.Connection, song_id: str, tags: list[str]) -> None:
        conn.execute("DELETE FROM song_tags WHERE song_id = ?", (song_id,))
        conn.executemany(
            """
            INSERT INTO song_tags (song_id, tag, position)
            VALUES (?, ?, ?)
            """,
            [(song_id, tag, index) for index, tag in enumerate(tags)],
        )

    def _song_from_row(self, conn: sqlite3.Connection, row: sqlite3.Row) -> StoredSong:
        tag_rows = conn.execute(
            """
            SELECT tag
            FROM song_tags
            WHERE song_id = ?
            ORDER BY position ASC, tag ASC
            """,
            (row["id"],),
        ).fetchall()
        return StoredSong(
            id=row["id"],
            title=row["title"],
            artist=row["artist"],
            album=row["album"],
            duration_seconds=row["duration_seconds"],
            source=row["source"],
            original_filename=row["original_filename"],
            file_path=row["file_path"],
            file_size=int(row["file_size"]),
            file_sha256=row["file_sha256"],
            mime_type=row["mime_type"],
            created_at=row["created_at"],
            updated_at=row["updated_at"],
            tags=[tag_row["tag"] for tag_row in tag_rows],
            has_cover=bool(row["has_cover"]) if "has_cover" in row.keys() else False,
        )

    def _song_exists(self, conn: sqlite3.Connection, song_id: str) -> bool:
        row = conn.execute(
            """
            SELECT 1
            FROM songs
            WHERE id = ? AND deleted_at IS NULL
            """,
            (song_id,),
        ).fetchone()
        return row is not None

    def _playlist_has_song(self, conn: sqlite3.Connection, playlist_id: str, song_id: str) -> bool:
        row = conn.execute(
            """
            SELECT 1
            FROM playlist_songs
            JOIN songs ON songs.id = playlist_songs.song_id
            WHERE playlist_songs.playlist_id = ?
              AND playlist_songs.song_id = ?
              AND songs.deleted_at IS NULL
            """,
            (playlist_id, song_id),
        ).fetchone()
        return row is not None

    def _liked_playlist_cover_song_id(self, conn: sqlite3.Connection, user_id: int) -> str | None:
        row = conn.execute(
            """
            SELECT songs.id
            FROM user_liked_songs
            JOIN songs ON songs.id = user_liked_songs.song_id
            WHERE user_liked_songs.user_id = ? AND songs.deleted_at IS NULL
            ORDER BY datetime(user_liked_songs.liked_at) DESC, songs.id DESC
            LIMIT 1
            """,
            (user_id,),
        ).fetchone()
        return row["id"] if row is not None else None

    def _get_playlist(self, conn: sqlite3.Connection, user_id: int, playlist_id: str) -> StoredPlaylist | None:
        row = conn.execute(
            f"""
            SELECT playlists.*, COUNT(playlist_songs.song_id) AS song_count, {PLAYLIST_EFFECTIVE_COVER_SQL}
            FROM playlists
            LEFT JOIN playlist_songs ON playlist_songs.playlist_id = playlists.id
            WHERE playlists.user_id = ? AND playlists.id = ? AND playlists.deleted_at IS NULL
            GROUP BY playlists.id
            """,
            (user_id, playlist_id),
        ).fetchone()
        return playlist_from_row(row) if row is not None else None

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        return conn

    def _initialize(self) -> None:
        with self._connect() as conn:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS songs (
                    id TEXT PRIMARY KEY,
                    title TEXT NOT NULL,
                    artist TEXT NOT NULL DEFAULT 'AI',
                    album TEXT NOT NULL DEFAULT '',
                    duration_seconds INTEGER,
                    source TEXT NOT NULL DEFAULT 'manual',
                    original_filename TEXT NOT NULL,
                    file_path TEXT NOT NULL,
                    file_size INTEGER NOT NULL,
                    file_sha256 TEXT NOT NULL,
                    mime_type TEXT NOT NULL DEFAULT 'audio/mpeg',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    deleted_at TEXT,
                    has_cover INTEGER NOT NULL DEFAULT 0
                );

                CREATE TABLE IF NOT EXISTS song_tags (
                    song_id TEXT NOT NULL,
                    tag TEXT NOT NULL,
                    position INTEGER NOT NULL DEFAULT 0,
                    PRIMARY KEY(song_id, tag),
                    FOREIGN KEY(song_id) REFERENCES songs(id) ON DELETE CASCADE
                );

                CREATE INDEX IF NOT EXISTS idx_songs_created_at
                ON songs(created_at);

                CREATE INDEX IF NOT EXISTS idx_song_tags_tag
                ON song_tags(tag);

                CREATE TABLE IF NOT EXISTS user_liked_songs (
                    user_id INTEGER NOT NULL,
                    song_id TEXT NOT NULL,
                    liked_at TEXT NOT NULL,
                    PRIMARY KEY(user_id, song_id),
                    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
                    FOREIGN KEY(song_id) REFERENCES songs(id) ON DELETE CASCADE
                );

                CREATE INDEX IF NOT EXISTS idx_user_liked_songs_user_liked_at
                ON user_liked_songs(user_id, liked_at);

                CREATE TABLE IF NOT EXISTS playlists (
                    id TEXT PRIMARY KEY,
                    user_id INTEGER NOT NULL,
                    name TEXT NOT NULL,
                    description TEXT NOT NULL DEFAULT '',
                    cover_song_id TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    deleted_at TEXT,
                    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS playlist_songs (
                    playlist_id TEXT NOT NULL,
                    song_id TEXT NOT NULL,
                    position INTEGER NOT NULL DEFAULT 0,
                    added_at TEXT NOT NULL,
                    PRIMARY KEY(playlist_id, song_id),
                    FOREIGN KEY(playlist_id) REFERENCES playlists(id) ON DELETE CASCADE,
                    FOREIGN KEY(song_id) REFERENCES songs(id) ON DELETE CASCADE
                );

                CREATE INDEX IF NOT EXISTS idx_playlists_user_updated_at
                ON playlists(user_id, updated_at);

                CREATE INDEX IF NOT EXISTS idx_playlist_songs_position
                ON playlist_songs(playlist_id, position);
                """
            )
            playlist_columns = {row["name"] for row in conn.execute("PRAGMA table_info(playlists)").fetchall()}
            if "cover_song_id" not in playlist_columns:
                conn.execute("ALTER TABLE playlists ADD COLUMN cover_song_id TEXT")
            song_columns = {row["name"] for row in conn.execute("PRAGMA table_info(songs)").fetchall()}
            if "has_cover" not in song_columns:
                conn.execute("ALTER TABLE songs ADD COLUMN has_cover INTEGER NOT NULL DEFAULT 0")


def create_song_router(
    *,
    store: SongStore,
    auth_store: Any,
    admin_key: str | None = None,
    require_auth: bool = True,
) -> APIRouter:
    router = APIRouter(prefix="/v1/songs", tags=["songs"])
    current_user = current_user_dependency(auth_store) if require_auth else _anonymous_user

    def require_admin(x_admin_key: Annotated[str | None, Header()] = None) -> None:
        if not admin_key:
            raise HTTPException(status_code=503, detail="Admin key is not configured.")
        if not x_admin_key or not secrets.compare_digest(x_admin_key, admin_key):
            raise HTTPException(status_code=403, detail="Invalid admin key.")

    @router.post("", response_model=SongResponse, dependencies=[Depends(require_admin)])
    async def upload_song(
        file: Annotated[UploadFile, File()],
        title: Annotated[str, Form(min_length=1, max_length=180)],
        artist: Annotated[str, Form(max_length=180)] = "AI",
        album: Annotated[str, Form(max_length=180)] = "",
        tags: Annotated[str, Form(max_length=1000)] = "",
        duration_seconds: Annotated[int | None, Form(ge=0, le=60 * 60 * 4)] = None,
        source: Annotated[str, Form(max_length=120)] = "manual",
    ) -> SongResponse:
        try:
            song = await store.create_song_from_upload(
                upload=file,
                title=title,
                artist=artist,
                album=album,
                tags=tags,
                duration_seconds=duration_seconds,
                source=source,
            )
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        return song_response(song)

    @router.get("", response_model=SongListResponse)
    def list_songs(
        limit: int = Query(default=50, ge=1, le=200),
        offset: int = Query(default=0, ge=0),
        tag: str | None = Query(default=None, min_length=1, max_length=120),
        q: str | None = Query(default=None, min_length=1, max_length=120),
        user: AuthUser | None = Depends(current_user),
    ) -> SongListResponse:
        songs, total = store.list_songs(limit=limit, offset=offset, tag=tag, q=q)
        return song_list_response(store=store, songs=songs, total=total, limit=limit, offset=offset, user=user)

    @router.get("/daily", response_model=SongListResponse)
    def daily_songs(
        limit: int = Query(default=20, ge=1, le=100),
        user: AuthUser | None = Depends(current_user),
    ) -> SongListResponse:
        songs, total = store.list_songs(limit=limit, offset=0)
        return song_list_response(store=store, songs=songs, total=total, limit=limit, offset=0, user=user)

    @router.get("/liked", response_model=SongListResponse)
    def liked_songs(
        limit: int = Query(default=50, ge=1, le=200),
        offset: int = Query(default=0, ge=0),
        user: AuthUser | None = Depends(current_user),
    ) -> SongListResponse:
        if user is None:
            return SongListResponse(songs=[], limit=limit, offset=offset, total=0)
        songs, total, liked_at_by_song_id = store.list_liked_songs(user_id=user.id, limit=limit, offset=offset)
        return SongListResponse(
            songs=[song_response(song, liked_at=liked_at_by_song_id.get(song.id)) for song in songs],
            limit=limit,
            offset=offset,
            total=total,
        )

    @router.get("/{song_id}", response_model=SongResponse)
    def get_song(
        song_id: str,
        user: AuthUser | None = Depends(current_user),
    ) -> SongResponse:
        try:
            song = store.get_song(song_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="Song not found.") from exc
        liked_at = store.liked_at_for_songs(user.id, [song.id]).get(song.id) if user else None
        return song_response(song, liked_at=liked_at)

    @router.get("/{song_id}/like", response_model=SongLikeResponse)
    def get_song_like(
        song_id: str,
        user: AuthUser | None = Depends(current_user),
    ) -> SongLikeResponse:
        if user is None:
            return SongLikeResponse(song_id=song_id, is_liked=False, liked_at=None)
        try:
            return song_like_response(store.get_song_like(user.id, song_id))
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="Song not found.") from exc

    @router.put("/{song_id}/like", response_model=SongLikeResponse)
    def like_song(
        song_id: str,
        user: AuthUser | None = Depends(current_user),
    ) -> SongLikeResponse:
        if user is None:
            return SongLikeResponse(song_id=song_id, is_liked=False, liked_at=None)
        try:
            return song_like_response(store.like_song(user.id, song_id))
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="Song not found.") from exc

    @router.delete("/{song_id}/like", response_model=SongLikeResponse)
    def unlike_song(
        song_id: str,
        user: AuthUser | None = Depends(current_user),
    ) -> SongLikeResponse:
        if user is None:
            return SongLikeResponse(song_id=song_id, is_liked=False, liked_at=None)
        try:
            return song_like_response(store.unlike_song(user.id, song_id))
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="Song not found.") from exc

    @router.get("/{song_id}/audio")
    def song_audio(
        song_id: str,
        _user: AuthUser | None = Depends(current_user),
    ) -> Response:
        try:
            song = store.get_song(song_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="Song not found.") from exc
        # Local-first: serve from the 7-day cache when present, otherwise redirect
        # to a short-lived presigned R2 URL so bytes never proxy through the API.
        path = store.local_audio_path(song)
        if path is not None:
            return FileResponse(
                path,
                media_type=song.mime_type or "audio/mpeg",
                filename=song.original_filename,
                headers={
                    "ETag": song.file_sha256,
                    "Cache-Control": "private, max-age=31536000, immutable",
                },
            )
        redirect_url = store.audio_redirect_url(song)
        if redirect_url is None:
            raise HTTPException(status_code=404, detail="Song file not found.")
        return RedirectResponse(redirect_url, status_code=302)

    @router.get("/{song_id}/cover")
    def song_cover(
        song_id: str,
        _user: AuthUser | None = Depends(current_user),
    ) -> Response:
        try:
            song = store.get_song(song_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="Song not found.") from exc
        path = store.local_audio_path(song)
        if path is not None:
            cover = extract_mp3_cover(path)
            if cover is None:
                raise HTTPException(status_code=404, detail="Song cover not found.")
            return Response(
                content=cover.data,
                media_type=cover.mime_type,
                headers={
                    "ETag": cover.file_sha256,
                    "Cache-Control": "private, max-age=31536000, immutable",
                },
            )
        redirect_url = store.cover_redirect_url(song)
        if redirect_url is None:
            raise HTTPException(status_code=404, detail="Song cover not found.")
        return RedirectResponse(redirect_url, status_code=302)

    return router


def create_playlist_router(
    *,
    store: SongStore,
    auth_store: Any,
    require_auth: bool = True,
) -> APIRouter:
    router = APIRouter(prefix="/v1/playlists", tags=["playlists"])
    current_user = current_user_dependency(auth_store) if require_auth else _anonymous_user

    def require_user(user: AuthUser | None) -> AuthUser:
        if user is None:
            raise HTTPException(status_code=401, detail="Missing bearer token.")
        return user

    @router.post("", response_model=PlaylistResponse)
    def create_playlist(
        request: CreatePlaylistRequest,
        user: AuthUser | None = Depends(current_user),
    ) -> PlaylistResponse:
        owner = require_user(user)
        playlist = store.create_playlist(
            user_id=owner.id,
            name=request.name,
            description=request.description,
        )
        return playlist_response(playlist)

    @router.get("", response_model=PlaylistListResponse)
    def list_playlists(user: AuthUser | None = Depends(current_user)) -> PlaylistListResponse:
        owner = require_user(user)
        playlists, total = store.list_playlists(user_id=owner.id)
        return PlaylistListResponse(
            playlists=[playlist_response(playlist) for playlist in playlists],
            total=total,
        )

    @router.patch("/{playlist_id}", response_model=PlaylistDetailResponse)
    def update_playlist(
        playlist_id: str,
        request: UpdatePlaylistRequest,
        user: AuthUser | None = Depends(current_user),
    ) -> PlaylistDetailResponse:
        owner = require_user(user)
        try:
            playlist, songs = store.update_playlist(
                user_id=owner.id,
                playlist_id=playlist_id,
                name=request.name,
                description=request.description,
                cover_song_id=request.cover_song_id,
                update_cover_song_id="cover_song_id" in request.model_fields_set,
            )
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="Playlist or cover song not found.") from exc
        return playlist_detail_response(store=store, playlist=playlist, songs=songs, user=owner)

    @router.get("/{playlist_id}", response_model=PlaylistDetailResponse)
    def get_playlist(
        playlist_id: str,
        user: AuthUser | None = Depends(current_user),
    ) -> PlaylistDetailResponse:
        owner = require_user(user)
        try:
            playlist, songs = store.get_playlist_detail(user_id=owner.id, playlist_id=playlist_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="Playlist not found.") from exc
        return playlist_detail_response(store=store, playlist=playlist, songs=songs, user=owner)

    @router.post("/{playlist_id}/songs", response_model=PlaylistDetailResponse)
    def add_playlist_song(
        playlist_id: str,
        request: AddPlaylistSongRequest,
        user: AuthUser | None = Depends(current_user),
    ) -> PlaylistDetailResponse:
        owner = require_user(user)
        try:
            playlist, songs = store.add_playlist_song(
                user_id=owner.id,
                playlist_id=playlist_id,
                song_id=request.song_id,
            )
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="Playlist or song not found.") from exc
        return playlist_detail_response(store=store, playlist=playlist, songs=songs, user=owner)

    @router.delete("/{playlist_id}/songs/{song_id}", response_model=PlaylistDetailResponse)
    def remove_playlist_song(
        playlist_id: str,
        song_id: str,
        user: AuthUser | None = Depends(current_user),
    ) -> PlaylistDetailResponse:
        owner = require_user(user)
        try:
            playlist, songs = store.remove_playlist_song(
                user_id=owner.id,
                playlist_id=playlist_id,
                song_id=song_id,
            )
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="Playlist not found.") from exc
        return playlist_detail_response(store=store, playlist=playlist, songs=songs, user=owner)

    return router


def song_list_response(
    *,
    store: SongStore,
    songs: list[StoredSong],
    total: int,
    limit: int,
    offset: int,
    user: AuthUser | None,
) -> SongListResponse:
    liked_at_by_song_id = store.liked_at_for_songs(user.id, [song.id for song in songs]) if user else {}
    return SongListResponse(
        songs=[song_response(song, liked_at=liked_at_by_song_id.get(song.id)) for song in songs],
        limit=limit,
        offset=offset,
        total=total,
    )


def song_response(song: StoredSong, *, liked_at: str | None = None) -> SongResponse:
    audio_url = f"/v1/songs/{song.id}/audio"
    cover_url = f"/v1/songs/{song.id}/cover"
    return SongResponse(
        id=song.id,
        title=song.title,
        artist=song.artist,
        album=song.album,
        duration_seconds=song.duration_seconds,
        source=song.source,
        original_filename=song.original_filename,
        file_size=song.file_size,
        file_sha256=song.file_sha256,
        mime_type=song.mime_type,
        tags=song.tags,
        audio_url=audio_url,
        download_url=audio_url,
        cover_url=cover_url,
        has_cover=song.has_cover,
        is_liked=liked_at is not None,
        liked_at=liked_at,
        created_at=song.created_at,
        updated_at=song.updated_at,
    )


def song_like_response(like: SongLike) -> SongLikeResponse:
    return SongLikeResponse(song_id=like.song_id, is_liked=like.is_liked, liked_at=like.liked_at)


def playlist_from_row(row: sqlite3.Row) -> StoredPlaylist:
    keys = set(row.keys())
    cover_song_id = None
    if "effective_cover_song_id" in keys:
        cover_song_id = row["effective_cover_song_id"]
    elif "cover_song_id" in keys:
        cover_song_id = row["cover_song_id"]
    return StoredPlaylist(
        id=row["id"],
        user_id=int(row["user_id"]),
        name=row["name"],
        description=row["description"],
        song_count=int(row["song_count"]),
        created_at=row["created_at"],
        updated_at=row["updated_at"],
        cover_song_id=cover_song_id,
    )


def playlist_response(playlist: StoredPlaylist) -> PlaylistResponse:
    return PlaylistResponse(
        id=playlist.id,
        name=playlist.name,
        description=playlist.description,
        song_count=playlist.song_count,
        cover_song_id=playlist.cover_song_id,
        kind=playlist.kind,
        is_system=playlist.is_system,
        can_delete=not playlist.is_system,
        created_at=playlist.created_at,
        updated_at=playlist.updated_at,
    )


def playlist_detail_response(
    *,
    store: SongStore,
    playlist: StoredPlaylist,
    songs: list[StoredSong],
    user: AuthUser,
) -> PlaylistDetailResponse:
    liked_at_by_song_id = store.liked_at_for_songs(user.id, [song.id for song in songs])
    return PlaylistDetailResponse(
        **playlist_response(playlist).model_dump(),
        songs=[song_response(song, liked_at=liked_at_by_song_id.get(song.id)) for song in songs],
    )


def utc_now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")


def _parse_iso_timestamp(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)


def _clean_song_tags(tags: str | list[str]) -> list[str]:
    return list(dict.fromkeys(parse_style_tags(tags)))


def _like_pattern(value: str) -> str:
    escaped = value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"


def extract_mp3_cover(path: Path) -> Mp3Cover | None:
    try:
        id3 = ID3(path)
    except (ID3NoHeaderError, MutagenError, OSError):
        return None

    covers = id3.getall("APIC")
    if not covers:
        return None

    cover = next((candidate for candidate in covers if candidate.type == 3), covers[0])
    data = bytes(cover.data)
    if not data:
        return None
    return Mp3Cover(
        data=data,
        mime_type=cover.mime or "image/jpeg",
        file_sha256=hashlib.sha256(data).hexdigest(),
    )


def _anonymous_user() -> None:
    return None
