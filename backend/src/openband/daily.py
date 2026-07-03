from __future__ import annotations

import json
import os
import re
import secrets
import sqlite3
from dataclasses import dataclass
from datetime import UTC, date, datetime
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Protocol

import numpy as np
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field

from music_taste_rec.style_model import StyleAssociationModel
from music_taste_rec.style_model import parse_style_tags
from openband.auth import AuthStore, AuthUser, current_user_dependency
from openband.prompt_generation import cli as prompt_cli
from openband.songs import SongResponse, SongStore, StoredSong, song_response, utc_now
from openband.suno_browser.client import SunoBrowserCommand, run_suno_browser_command


DEFAULT_DAILY_SONG_COUNT = 10
DEFAULT_DAILY_PROFILE_ONLY = 7
DEFAULT_SUNO_BATCH_SIZE = 5
SUNO_LYRICS_AUTOGENERATE_PERCENT = 30
DAILY_RUNTIME_ROOT_ENV = "OPENBAND_DAILY_RUNTIME_ROOT"
DAILY_SUNO_TIMEOUT_ENV = "OPENBAND_DAILY_SUNO_TIMEOUT_SECONDS"
SUNO_CAPTCHA_ERROR_CODE = "SUNO_CAPTCHA_REQUIRED"
SUNO_BROWSER_ERROR_CODE = "SUNO_BROWSER_ERROR"
SUNO_CAPTCHA_STATUS = "captcha_required"
TEMP_PRE_SUNO_RETRY_USER_IDS = {37}
STYLE_PROMPT_TAG_MIN_SIMILARITY = 0.58
STYLE_PROMPT_TAG_SIMILARITY_MARGIN = 0.08


def _redact_sensitive_error(value: str) -> str:
    message = str(value)
    for env_name in ("SUNO_2CAPTCHA_KEY", "TWOCAPTCHA_KEY"):
        secret = os.getenv(env_name)
        if secret:
            message = message.replace(secret, "[redacted]")
    message = re.sub(
        r"([?&](?:key|apikey|api_key)=)[^&\s]+",
        r"\1[redacted]",
        message,
        flags=re.IGNORECASE,
    )
    return re.sub(r"ob_(?:key|at|rt)_[A-Za-z0-9_-]+", "[redacted-token]", message)


def _clean_suno_error_message(value: str) -> str:
    message = _redact_sensitive_error(value).strip()
    if message.startswith(f"{SUNO_CAPTCHA_ERROR_CODE}:"):
        message = message.split(":", 1)[1].strip()
    return message[:4000]


def _structured_suno_error(result: SunoBrowserCommand) -> dict[str, Any] | None:
    for stream in (result.stderr, result.stdout):
        for line in reversed(stream.splitlines()):
            candidate = line.strip()
            if not candidate.startswith("{"):
                continue
            try:
                parsed = json.loads(candidate)
            except json.JSONDecodeError:
                continue
            if isinstance(parsed, dict) and ("code" in parsed or "error" in parsed):
                return parsed
    return None


def suno_batch_failure_message(
    result: SunoBrowserCommand,
    *,
    batch_index: int,
) -> tuple[str, str]:
    structured = _structured_suno_error(result)
    detail = result.stderr.strip() or result.stdout.strip()
    if structured:
        code = str(structured.get("code") or SUNO_BROWSER_ERROR_CODE)
        error = _clean_suno_error_message(str(structured.get("error") or detail or code))
        if code == SUNO_CAPTCHA_ERROR_CODE:
            return (
                "Suno needs human verification before continuing. "
                "Open https://suno.com/create in Chrome, finish the CAPTCHA, then rerun daily generation. "
                f"Batch {batch_index} is resumable. {error}",
                SUNO_CAPTCHA_STATUS,
            )
        return (f"Suno batch {batch_index} failed: {error}", "failed")

    return (f"Suno batch {batch_index} failed: {_clean_suno_error_message(detail)}", "failed")


def is_suno_captcha_required_error(message: str) -> bool:
    return (
        SUNO_CAPTCHA_ERROR_CODE in message
        or "Suno needs human verification" in message
        or "Batch " in message and " is resumable" in message and "human verification" in message
    )


@dataclass(frozen=True)
class StoredDailyPlaylist:
    id: str
    user_id: int
    date: str
    title: str
    status: str
    song_count: int
    job_id: str | None
    error: str
    prompt_seed: dict[str, Any]
    created_at: str
    updated_at: str
    completed_at: str | None


@dataclass(frozen=True)
class StoredDailySong:
    daily_playlist_id: str
    song_id: str
    position: int
    tags: list[str]
    prompt_file: str
    suno_url: str
    generation_status: str
    metadata: dict[str, Any]
    added_at: str


@dataclass(frozen=True)
class StoredDailyJob:
    id: str
    user_id: int
    date: str
    daily_playlist_id: str
    status: str
    stage: str
    error: str
    result: dict[str, Any]
    created_at: str
    updated_at: str
    started_at: str | None
    completed_at: str | None


@dataclass(frozen=True)
class StoredDailySunoBatch:
    id: str
    daily_job_id: str
    user_id: int
    date: str
    daily_playlist_id: str
    batch_index: int
    position_start: int
    position_end: int
    status: str
    stage: str
    error: str
    prompt_files: list[str]
    state_path: str
    result: dict[str, Any]
    created_at: str
    updated_at: str
    started_at: str | None
    completed_at: str | None


@dataclass(frozen=True)
class DailyGenerationContext:
    user: AuthUser
    date: str
    playlist_id: str
    job_id: str
    daily_store: "DailyStore"
    song_store: SongStore
    auth_store: AuthStore
    resume: bool = False


class DailyGenerator(Protocol):
    def run(self, context: DailyGenerationContext) -> None:
        ...


class DailySongResponse(BaseModel):
    position: int
    tags: list[str]
    generation_status: str
    prompt_file: str
    suno_url: str
    metadata: dict[str, Any]
    song: SongResponse


class DailyPlaylistResponse(BaseModel):
    id: str
    date: str
    title: str
    status: str
    song_count: int
    job_id: str | None = None
    error: str = ""
    created_at: str
    updated_at: str
    completed_at: str | None = None


class DailyPlaylistDetailResponse(DailyPlaylistResponse):
    prompt_seed: dict[str, Any] = Field(default_factory=dict)
    songs: list[DailySongResponse] = Field(default_factory=list)


class DailyHistoryResponse(BaseModel):
    playlists: list[DailyPlaylistResponse]
    total: int
    limit: int
    offset: int


class DailySunoBatchResponse(BaseModel):
    id: str
    daily_job_id: str
    batch_index: int
    position_start: int
    position_end: int
    status: str
    stage: str
    error: str = ""
    prompt_files: list[str] = Field(default_factory=list)
    state_path: str = ""
    result: dict[str, Any] = Field(default_factory=dict)
    created_at: str
    updated_at: str
    started_at: str | None = None
    completed_at: str | None = None


class DailyJobResponse(BaseModel):
    id: str
    date: str
    daily_playlist_id: str
    status: str
    stage: str
    error: str = ""
    result: dict[str, Any] = Field(default_factory=dict)
    created_at: str
    updated_at: str
    started_at: str | None = None
    completed_at: str | None = None
    batches: list[DailySunoBatchResponse] = Field(default_factory=list)


class DailyTodayResponse(BaseModel):
    date: str
    status: str
    playlist: DailyPlaylistDetailResponse | None = None
    active_job: DailyJobResponse | None = None


class GenerateDailyRequest(BaseModel):
    date: str | None = None
    force: bool = False
    resume: bool = False
    job_id: str | None = None
    wait: bool = False


class GenerateDailyResponse(BaseModel):
    date: str
    status: str
    playlist: DailyPlaylistDetailResponse | None = None
    job: DailyJobResponse | None = None


class DailyStore:
    def __init__(self, db_path: Path):
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._initialize()

    def get_or_create_daily_playlist(self, *, user_id: int, date_value: str) -> StoredDailyPlaylist:
        existing = self.get_daily_playlist(user_id=user_id, date_value=date_value)
        if existing is not None:
            return existing

        now = utc_now()
        playlist_id = f"daily_{date_value.replace('-', '')}_{secrets.token_urlsafe(8).replace('-', '').replace('_', '')}"
        title = f"Daily {date_value}"
        with self._connect() as conn:
            try:
                conn.execute(
                    """
                    INSERT INTO daily_playlists (
                        id, user_id, date, title, status, error,
                        prompt_seed_json, created_at, updated_at
                    )
                    VALUES (?, ?, ?, ?, 'not_started', '', '{}', ?, ?)
                    """,
                    (playlist_id, user_id, date_value, title, now, now),
                )
            except sqlite3.IntegrityError:
                pass
        playlist = self.get_daily_playlist(user_id=user_id, date_value=date_value)
        if playlist is None:
            raise KeyError(date_value)
        return playlist

    def get_daily_playlist(self, *, user_id: int, date_value: str) -> StoredDailyPlaylist | None:
        with self._connect() as conn:
            row = conn.execute(
                """
                SELECT daily_playlists.*, COUNT(daily_playlist_songs.song_id) AS song_count
                FROM daily_playlists
                LEFT JOIN daily_playlist_songs
                    ON daily_playlist_songs.daily_playlist_id = daily_playlists.id
                WHERE daily_playlists.user_id = ? AND daily_playlists.date = ?
                GROUP BY daily_playlists.id
                """,
                (user_id, date_value),
            ).fetchone()
        return daily_playlist_from_row(row) if row is not None else None

    def get_daily_playlist_by_id(self, *, user_id: int, playlist_id: str) -> StoredDailyPlaylist | None:
        with self._connect() as conn:
            row = conn.execute(
                """
                SELECT daily_playlists.*, COUNT(daily_playlist_songs.song_id) AS song_count
                FROM daily_playlists
                LEFT JOIN daily_playlist_songs
                    ON daily_playlist_songs.daily_playlist_id = daily_playlists.id
                WHERE daily_playlists.user_id = ? AND daily_playlists.id = ?
                GROUP BY daily_playlists.id
                """,
                (user_id, playlist_id),
            ).fetchone()
        return daily_playlist_from_row(row) if row is not None else None

    def list_daily_playlists(
        self,
        *,
        user_id: int,
        limit: int = 30,
        offset: int = 0,
    ) -> tuple[list[StoredDailyPlaylist], int]:
        with self._connect() as conn:
            total = int(
                conn.execute(
                    "SELECT COUNT(*) AS count FROM daily_playlists WHERE user_id = ?",
                    (user_id,),
                ).fetchone()["count"]
            )
            rows = conn.execute(
                """
                SELECT daily_playlists.*, COUNT(daily_playlist_songs.song_id) AS song_count
                FROM daily_playlists
                LEFT JOIN daily_playlist_songs
                    ON daily_playlist_songs.daily_playlist_id = daily_playlists.id
                WHERE daily_playlists.user_id = ?
                GROUP BY daily_playlists.id
                ORDER BY daily_playlists.date DESC, datetime(daily_playlists.created_at) DESC
                LIMIT ? OFFSET ?
                """,
                (user_id, limit, offset),
            ).fetchall()
        return [daily_playlist_from_row(row) for row in rows], total

    def list_daily_songs(self, *, daily_playlist_id: str) -> list[StoredDailySong]:
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT *
                FROM daily_playlist_songs
                WHERE daily_playlist_id = ?
                ORDER BY position ASC, datetime(added_at) ASC
                """,
                (daily_playlist_id,),
            ).fetchall()
        return [daily_song_from_row(row) for row in rows]

    def create_job(self, *, user_id: int, date_value: str, daily_playlist_id: str) -> StoredDailyJob:
        now = utc_now()
        job_id = f"daily_job_{secrets.token_urlsafe(12).replace('-', '').replace('_', '')}"
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO daily_generation_jobs (
                    id, user_id, date, daily_playlist_id, status, stage,
                    error, result_json, created_at, updated_at
                )
                VALUES (?, ?, ?, ?, 'queued', 'queued', '', '{}', ?, ?)
                """,
                (job_id, user_id, date_value, daily_playlist_id, now, now),
            )
            conn.execute(
                """
                UPDATE daily_playlists
                SET status = 'queued', job_id = ?, error = '', updated_at = ?, completed_at = NULL
                WHERE id = ?
                """,
                (job_id, now, daily_playlist_id),
            )
        return self.get_job(user_id=user_id, job_id=job_id)

    def get_job(self, *, user_id: int, job_id: str) -> StoredDailyJob:
        with self._connect() as conn:
            row = conn.execute(
                """
                SELECT *
                FROM daily_generation_jobs
                WHERE user_id = ? AND id = ?
                """,
                (user_id, job_id),
            ).fetchone()
        if row is None:
            raise KeyError(job_id)
        return daily_job_from_row(row)

    def get_job_by_id(self, job_id: str) -> StoredDailyJob:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM daily_generation_jobs WHERE id = ?",
                (job_id,),
            ).fetchone()
        if row is None:
            raise KeyError(job_id)
        return daily_job_from_row(row)

    def get_active_job(self, *, user_id: int, date_value: str) -> StoredDailyJob | None:
        with self._connect() as conn:
            row = conn.execute(
                """
                SELECT *
                FROM daily_generation_jobs
                WHERE user_id = ? AND date = ? AND status IN ('queued', 'running')
                ORDER BY datetime(created_at) DESC
                LIMIT 1
                """,
                (user_id, date_value),
            ).fetchone()
        return daily_job_from_row(row) if row is not None else None

    def get_resumable_job(
        self,
        *,
        user_id: int,
        date_value: str,
        daily_playlist_id: str,
        preferred_job_id: str | None = None,
        allow_fallback: bool = True,
    ) -> StoredDailyJob | None:
        if preferred_job_id:
            with self._connect() as conn:
                row = conn.execute(
                    """
                    SELECT *
                    FROM daily_generation_jobs
                    WHERE id = ?
                        AND user_id = ?
                        AND date = ?
                        AND daily_playlist_id = ?
                        AND status = 'failed'
                        AND EXISTS (
                            SELECT 1
                            FROM daily_suno_batches
                            WHERE daily_suno_batches.daily_job_id = daily_generation_jobs.id
                        )
                    LIMIT 1
                    """,
                    (preferred_job_id, user_id, date_value, daily_playlist_id),
                ).fetchone()
            if row is not None:
                return daily_job_from_row(row)
            if not allow_fallback:
                return None

        with self._connect() as conn:
            row = conn.execute(
                """
                SELECT *
                FROM daily_generation_jobs
                WHERE user_id = ?
                    AND date = ?
                    AND daily_playlist_id = ?
                    AND status = 'failed'
                    AND EXISTS (
                        SELECT 1
                        FROM daily_suno_batches
                        WHERE daily_suno_batches.daily_job_id = daily_generation_jobs.id
                    )
                ORDER BY datetime(updated_at) DESC, datetime(created_at) DESC
                LIMIT 1
                """,
                (user_id, date_value, daily_playlist_id),
            ).fetchone()
        return daily_job_from_row(row) if row is not None else None

    def create_suno_batches(
        self,
        *,
        daily_job_id: str,
        user_id: int,
        date_value: str,
        daily_playlist_id: str,
        batches: list[dict[str, Any]],
    ) -> list[StoredDailySunoBatch]:
        now = utc_now()
        with self._connect() as conn:
            conn.executemany(
                """
                INSERT OR IGNORE INTO daily_suno_batches (
                    id, daily_job_id, user_id, date, daily_playlist_id,
                    batch_index, position_start, position_end, status, stage,
                    error, prompt_files_json, state_path, result_json,
                    created_at, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', 'queued', '', ?, ?, '{}', ?, ?)
                """,
                [
                    (
                        f"{daily_job_id}_batch_{int(item['batch_index']):02d}",
                        daily_job_id,
                        user_id,
                        date_value,
                        daily_playlist_id,
                        int(item["batch_index"]),
                        int(item["position_start"]),
                        int(item["position_end"]),
                        _json_dumps([str(path) for path in item.get("prompt_files", [])]),
                        str(item.get("state_path", "")),
                        now,
                        now,
                    )
                    for item in batches
                ],
            )
        return self.list_suno_batches(daily_job_id=daily_job_id)

    def list_suno_batches(self, *, daily_job_id: str) -> list[StoredDailySunoBatch]:
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT *
                FROM daily_suno_batches
                WHERE daily_job_id = ?
                ORDER BY batch_index ASC
                """,
                (daily_job_id,),
            ).fetchall()
        return [daily_suno_batch_from_row(row) for row in rows]

    def mark_suno_batch_running(self, *, batch_id: str, stage: str = "running") -> None:
        now = utc_now()
        with self._connect() as conn:
            conn.execute(
                """
                UPDATE daily_suno_batches
                SET status = 'running',
                    stage = ?,
                    error = '',
                    started_at = COALESCE(started_at, ?),
                    updated_at = ?,
                    completed_at = NULL
                WHERE id = ?
                """,
                (stage, now, now, batch_id),
            )

    def mark_suno_batch_succeeded(
        self,
        *,
        batch_id: str,
        result: dict[str, Any],
        stage: str = "downloaded",
    ) -> None:
        now = utc_now()
        with self._connect() as conn:
            conn.execute(
                """
                UPDATE daily_suno_batches
                SET status = 'succeeded',
                    stage = ?,
                    error = '',
                    result_json = ?,
                    updated_at = ?,
                    completed_at = ?
                WHERE id = ?
                """,
                (stage, _json_dumps(result), now, now, batch_id),
            )

    def mark_suno_batch_failed(self, *, batch_id: str, error: str, stage: str = "failed") -> None:
        now = utc_now()
        with self._connect() as conn:
            conn.execute(
                """
                UPDATE daily_suno_batches
                SET status = 'failed',
                    stage = ?,
                    error = ?,
                    updated_at = ?,
                    completed_at = ?
                WHERE id = ?
                """,
                (stage, error, now, now, batch_id),
            )

    def mark_job_running(self, *, job_id: str, stage: str) -> None:
        now = utc_now()
        with self._connect() as conn:
            conn.execute(
                """
                UPDATE daily_generation_jobs
                SET status = 'running',
                    stage = ?,
                    error = '',
                    started_at = COALESCE(started_at, ?),
                    updated_at = ?,
                    completed_at = NULL
                WHERE id = ?
                """,
                (stage, now, now, job_id),
            )

    def mark_job_stage(self, *, job_id: str, stage: str) -> None:
        now = utc_now()
        with self._connect() as conn:
            conn.execute(
                """
                UPDATE daily_generation_jobs
                SET status = 'running', stage = ?, updated_at = ?
                WHERE id = ?
                """,
                (stage, now, job_id),
            )

    def mark_job_succeeded(self, *, job_id: str, result: dict[str, Any]) -> None:
        now = utc_now()
        with self._connect() as conn:
            conn.execute(
                """
                UPDATE daily_generation_jobs
                SET status = 'succeeded',
                    stage = 'ready',
                    error = '',
                    result_json = ?,
                    updated_at = ?,
                    completed_at = ?
                WHERE id = ?
                """,
                (_json_dumps(result), now, now, job_id),
            )

    def mark_job_failed(self, *, job_id: str, error: str, stage: str = "failed") -> None:
        now = utc_now()
        with self._connect() as conn:
            conn.execute(
                """
                UPDATE daily_generation_jobs
                SET status = 'failed',
                    stage = ?,
                    error = ?,
                    updated_at = ?,
                    completed_at = ?
                WHERE id = ?
                """,
                (stage, error, now, now, job_id),
            )

    def set_playlist_status(
        self,
        *,
        playlist_id: str,
        status: str,
        job_id: str | None = None,
        error: str = "",
        prompt_seed: dict[str, Any] | None = None,
        completed: bool = False,
        clear_completed: bool = False,
    ) -> None:
        now = utc_now()
        fields = ["status = ?", "error = ?", "updated_at = ?"]
        params: list[Any] = [status, error, now]
        if job_id is not None:
            fields.append("job_id = ?")
            params.append(job_id)
        if prompt_seed is not None:
            fields.append("prompt_seed_json = ?")
            params.append(_json_dumps(prompt_seed))
        if clear_completed:
            fields.append("completed_at = NULL")
        elif completed:
            fields.append("completed_at = ?")
            params.append(now)
        params.append(playlist_id)
        with self._connect() as conn:
            conn.execute(
                f"UPDATE daily_playlists SET {', '.join(fields)} WHERE id = ?",
                params,
            )

    def replace_daily_songs(
        self,
        *,
        daily_playlist_id: str,
        songs: list[dict[str, Any]],
    ) -> None:
        now = utc_now()
        with self._connect() as conn:
            conn.execute(
                "DELETE FROM daily_playlist_songs WHERE daily_playlist_id = ?",
                (daily_playlist_id,),
            )
            conn.executemany(
                """
                INSERT INTO daily_playlist_songs (
                    daily_playlist_id, song_id, position, tags_json, prompt_file,
                    suno_url, generation_status, metadata_json, added_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                [
                    (
                        daily_playlist_id,
                        item["song_id"],
                        int(item["position"]),
                        _json_dumps(_clean_tags(item.get("tags", []))),
                        str(item.get("prompt_file", "")),
                        str(item.get("suno_url", "")),
                        str(item.get("generation_status", "ready")),
                        _json_dumps(item.get("metadata", {})),
                        now,
                    )
                    for item in songs
                ],
            )
            conn.execute(
                "UPDATE daily_playlists SET updated_at = ? WHERE id = ?",
                (now, daily_playlist_id),
            )

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        return conn

    def _initialize(self) -> None:
        with self._connect() as conn:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS daily_playlists (
                    id TEXT PRIMARY KEY,
                    user_id INTEGER NOT NULL,
                    date TEXT NOT NULL,
                    title TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'not_started',
                    job_id TEXT,
                    error TEXT NOT NULL DEFAULT '',
                    prompt_seed_json TEXT NOT NULL DEFAULT '{}',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    completed_at TEXT,
                    UNIQUE(user_id, date),
                    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS daily_playlist_songs (
                    daily_playlist_id TEXT NOT NULL,
                    song_id TEXT NOT NULL,
                    position INTEGER NOT NULL DEFAULT 0,
                    tags_json TEXT NOT NULL DEFAULT '[]',
                    prompt_file TEXT NOT NULL DEFAULT '',
                    suno_url TEXT NOT NULL DEFAULT '',
                    generation_status TEXT NOT NULL DEFAULT 'ready',
                    metadata_json TEXT NOT NULL DEFAULT '{}',
                    added_at TEXT NOT NULL,
                    PRIMARY KEY(daily_playlist_id, song_id),
                    FOREIGN KEY(daily_playlist_id) REFERENCES daily_playlists(id) ON DELETE CASCADE,
                    FOREIGN KEY(song_id) REFERENCES songs(id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS daily_generation_jobs (
                    id TEXT PRIMARY KEY,
                    user_id INTEGER NOT NULL,
                    date TEXT NOT NULL,
                    daily_playlist_id TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'queued',
                    stage TEXT NOT NULL DEFAULT 'queued',
                    error TEXT NOT NULL DEFAULT '',
                    result_json TEXT NOT NULL DEFAULT '{}',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    started_at TEXT,
                    completed_at TEXT,
                    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
                    FOREIGN KEY(daily_playlist_id) REFERENCES daily_playlists(id) ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS daily_suno_batches (
                    id TEXT PRIMARY KEY,
                    daily_job_id TEXT NOT NULL,
                    user_id INTEGER NOT NULL,
                    date TEXT NOT NULL,
                    daily_playlist_id TEXT NOT NULL,
                    batch_index INTEGER NOT NULL,
                    position_start INTEGER NOT NULL,
                    position_end INTEGER NOT NULL,
                    status TEXT NOT NULL DEFAULT 'queued',
                    stage TEXT NOT NULL DEFAULT 'queued',
                    error TEXT NOT NULL DEFAULT '',
                    prompt_files_json TEXT NOT NULL DEFAULT '[]',
                    state_path TEXT NOT NULL DEFAULT '',
                    result_json TEXT NOT NULL DEFAULT '{}',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    started_at TEXT,
                    completed_at TEXT,
                    UNIQUE(daily_job_id, batch_index),
                    FOREIGN KEY(daily_job_id) REFERENCES daily_generation_jobs(id) ON DELETE CASCADE,
                    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
                    FOREIGN KEY(daily_playlist_id) REFERENCES daily_playlists(id) ON DELETE CASCADE
                );

                CREATE INDEX IF NOT EXISTS idx_daily_playlists_user_date
                ON daily_playlists(user_id, date);

                CREATE INDEX IF NOT EXISTS idx_daily_jobs_user_date_status
                ON daily_generation_jobs(user_id, date, status);

                CREATE INDEX IF NOT EXISTS idx_daily_suno_batches_job_status
                ON daily_suno_batches(daily_job_id, status);

                CREATE INDEX IF NOT EXISTS idx_daily_playlist_songs_position
                ON daily_playlist_songs(daily_playlist_id, position);
                """
            )


class DailyGenerationService:
    def __init__(
        self,
        *,
        model_path: Path,
        responses_url: str,
        responses_model: str,
        api_key_env: str = "OPENAI_API_KEY",
        runtime_root: Path | None = None,
        suno_timeout_seconds: int | None = None,
    ):
        self.model_path = Path(model_path)
        self.responses_url = responses_url
        self.responses_model = responses_model
        self.api_key_env = api_key_env
        runtime_root_path = Path(
            runtime_root
            or os.getenv(DAILY_RUNTIME_ROOT_ENV)
            or prompt_cli.BACKEND_ROOT / "runtime" / "daily"
        )
        if not runtime_root_path.is_absolute():
            runtime_root_path = prompt_cli.BACKEND_ROOT / runtime_root_path
        self.runtime_root = runtime_root_path.resolve()
        self.suno_timeout_seconds = int(
            suno_timeout_seconds
            or os.getenv(DAILY_SUNO_TIMEOUT_ENV, "1800")
        )
        self._style_tag_model: StyleAssociationModel | None = None
        self._style_tag_model_loaded = False

    def run(self, context: DailyGenerationContext) -> None:
        job_dir = self.runtime_root / str(context.user.id) / context.date / context.job_id
        prompt_dir = job_dir / "prompts"
        download_dir = job_dir / "downloads"
        prompt_dir.mkdir(parents=True, exist_ok=True)
        download_dir.mkdir(parents=True, exist_ok=True)

        if context.resume:
            self._resume_suno_job(context=context, download_dir=download_dir)
            return

        api_key = os.getenv(self.api_key_env)
        if not api_key:
            raise RuntimeError(f"Missing API key. Set {self.api_key_env}.")

        user_tags = context.auth_store.get_music_tags(context.user.id).tags
        if not user_tags:
            raise RuntimeError("No music taste tags found. Run taste setup first.")

        args = self._args(context=context, job_dir=job_dir)
        profile = {
            "version": 1,
            "reference_summary": "OpenTunes saved user music taste tags.",
            "source_notes": "Generated from user_music_tag_preferences.",
            "tags": user_tags,
        }

        context.daily_store.mark_job_running(job_id=context.job_id, stage="generating_tags")
        context.daily_store.set_playlist_status(
            playlist_id=context.playlist_id,
            status="generating_tags",
            job_id=context.job_id,
        )
        seed = prompt_cli.build_daily_playlist_seed(args, profile)
        context.daily_store.set_playlist_status(
            playlist_id=context.playlist_id,
            status="generating_playlist_prompt",
            prompt_seed=seed,
        )

        context.daily_store.mark_job_stage(job_id=context.job_id, stage="generating_playlist_prompt")
        playlist_prompt = prompt_cli.read_text(
            prompt_cli.PROMPT_ROOT / prompt_cli.PROMPT_FILES["playlist"]
        )
        playlist_text, _playlist_data = prompt_cli.run_prompt(
            args,
            api_key,
            playlist_prompt,
            prompt_cli.playlist_llm_input(seed),
        )
        seed_with_prompt = {**seed, "playlist_prompt": playlist_text}
        context.daily_store.set_playlist_status(
            playlist_id=context.playlist_id,
            status="generating_song_prompts",
            prompt_seed=seed_with_prompt,
        )

        context.daily_store.mark_job_stage(job_id=context.job_id, stage="generating_song_prompts")
        prompt_manifest = self._generate_song_prompts(
            args=args,
            api_key=api_key,
            profile=profile,
            seed=seed,
            prompt_dir=prompt_dir,
            date_value=context.date,
        )

        suno_batches = self._queue_suno_batches(
            context=context,
            prompt_manifest=prompt_manifest,
            job_dir=job_dir,
        )

        context.daily_store.mark_job_stage(job_id=context.job_id, stage="suno_queue")
        context.daily_store.set_playlist_status(
            playlist_id=context.playlist_id,
            status="suno_queue",
        )
        batch_data_list = self._drain_suno_queue(
            context=context,
            batches=suno_batches,
            download_dir=download_dir,
        )
        self._finish_suno_results(
            context=context,
            prompt_manifest=prompt_manifest,
            batch_data_list=batch_data_list,
            prompt_seed=seed_with_prompt,
            playlist_history_args=args,
            playlist_history_seed=seed,
        )

    def _args(self, *, context: DailyGenerationContext, job_dir: Path) -> SimpleNamespace:
        return SimpleNamespace(
            tag_model_path=str(self.model_path),
            playlist_history_file=str(self.runtime_root / str(context.user.id) / "playlist_history.json"),
            no_playlist_history=False,
            playlist_date=context.date,
            playlist_total=DEFAULT_DAILY_SONG_COUNT,
            playlist_profile_only=DEFAULT_DAILY_PROFILE_ONLY,
            playlist_tags_per_song=prompt_cli.DEFAULT_PLAYLIST_TAGS_PER_SONG,
            playlist_user_tags_per_hybrid=prompt_cli.DEFAULT_PLAYLIST_TAGS_PER_SONG // 2,
            playlist_related_top_n=40,
            playlist_candidate_count=prompt_cli.DEFAULT_PLAYLIST_CANDIDATE_COUNT,
            playlist_diversity_weight=prompt_cli.DEFAULT_PLAYLIST_DIVERSITY_WEIGHT,
            playlist_max_cluster_similarity=prompt_cli.DEFAULT_PLAYLIST_MAX_CLUSTER_SIMILARITY,
            playlist_history_days=prompt_cli.DEFAULT_PLAYLIST_HISTORY_DAYS,
            playlist_history_weight=prompt_cli.DEFAULT_PLAYLIST_HISTORY_WEIGHT,
            playlist_history_tag_weight=prompt_cli.DEFAULT_PLAYLIST_HISTORY_TAG_WEIGHT,
            no_tag_filter=False,
            url=self.responses_url,
            model=self.responses_model,
            flat=False,
            print_json=False,
            kind="both",
            prompt_file=None,
            message="",
            song_tags="",
            song_index=1,
            brief_choice_seed=None,
            brief_only=False,
            output_dir=str(job_dir),
            output_file=None,
            no_save=False,
            no_profile=False,
            profile_file=str(job_dir / "profile.json"),
        )

    def _generate_song_prompts(
        self,
        *,
        args: SimpleNamespace,
        api_key: str,
        profile: dict[str, Any],
        seed: dict[str, Any],
        prompt_dir: Path,
        date_value: str,
    ) -> list[dict[str, Any]]:
        manifest = []
        for song_seed in seed.get("songs", []):
            index = int(song_seed["index"])
            seed_tags = [str(tag) for tag in song_seed.get("tags", [])]
            args.song_index = index
            args.message = f"Generate prompt and lyrics for Daily {date_value}, song {index}."
            candidates, selected_index, selected = prompt_cli.run_brief_candidates(
                args,
                api_key,
                seed_tags,
            )
            user_text = prompt_cli.apply_profile(
                prompt_cli.selected_brief_user_text(args, seed_tags, selected),
                profile,
            )
            _flow_output, flow_result = prompt_cli.run_generation_flow(
                args,
                api_key,
                user_text,
            )
            content = prompt_cli.format_song_brief_result(
                tags=seed_tags,
                candidates=candidates,
                selected_index=selected_index,
                selected=selected,
                flow_output=flow_result,
            )
            lyrics_text = _markdown_section(flow_result, "Lyrics")
            lyrics_mode = "llm"
            if lyrics_text.strip() and secrets.randbelow(100) < SUNO_LYRICS_AUTOGENERATE_PERCENT:
                lyrics_mode = "suno"
                content = _append_suno_submit_section(
                    content,
                    lyrics_mode=lyrics_mode,
                    reason="autogenerated_lyrics_sample",
                    probability_percent=SUNO_LYRICS_AUTOGENERATE_PERCENT,
                )
            title = str(selected.get("title_seed") or f"Daily Song {index}")
            prompt_file = prompt_dir / f"{index:02d}-{prompt_cli.safe_slug(title)}.md"
            prompt_file.write_text(content, encoding="utf-8")
            style_prompt = _markdown_section(flow_result, "Style Prompt")
            tags = self._style_prompt_tags(style_prompt)
            manifest.append(
                {
                    "index": index,
                    "tags": tags,
                    "style_prompt": style_prompt,
                    "lyrics_mode": lyrics_mode,
                    "used_llm_lyrics": lyrics_mode != "suno",
                    "prompt_file": prompt_file,
                    "selected_brief_index": selected_index + 1,
                    "selected_brief": selected,
                    "song_metrics": {
                        "intra_similarity": song_seed.get("intra_similarity"),
                        "nearest_previous_similarity": song_seed.get("nearest_previous_similarity"),
                        "nearest_history_similarity": song_seed.get("nearest_history_similarity"),
                    },
                }
            )
        return manifest

    def _queue_suno_batches(
        self,
        *,
        context: DailyGenerationContext,
        prompt_manifest: list[dict[str, Any]],
        job_dir: Path,
    ) -> list[StoredDailySunoBatch]:
        batches = []
        for offset in range(0, len(prompt_manifest), DEFAULT_SUNO_BATCH_SIZE):
            batch_index = (offset // DEFAULT_SUNO_BATCH_SIZE) + 1
            batch_manifest = prompt_manifest[offset : offset + DEFAULT_SUNO_BATCH_SIZE]
            indexes = [
                int(item.get("index", offset + position + 1))
                for position, item in enumerate(batch_manifest)
            ]
            batches.append(
                {
                    "batch_index": batch_index,
                    "position_start": min(indexes),
                    "position_end": max(indexes),
                    "prompt_files": [str(item["prompt_file"]) for item in batch_manifest],
                    "state_path": str(job_dir / f"suno-batch-{batch_index:02d}-state.json"),
                }
            )
        return context.daily_store.create_suno_batches(
            daily_job_id=context.job_id,
            user_id=context.user.id,
            date_value=context.date,
            daily_playlist_id=context.playlist_id,
            batches=batches,
        )

    def _drain_suno_queue(
        self,
        *,
        context: DailyGenerationContext,
        batches: list[StoredDailySunoBatch],
        download_dir: Path,
    ) -> list[dict[str, Any]]:
        batch_data_list = []
        screenshot_root = download_dir.parent / "screenshots"

        for batch in batches:
            if batch.status == "succeeded" and isinstance(batch.result.get("results"), list):
                batch_data_list.append(batch.result)
                continue

            stage = f"suno_batch_{batch.batch_index}"
            context.daily_store.mark_job_stage(job_id=context.job_id, stage=stage)
            context.daily_store.set_playlist_status(
                playlist_id=context.playlist_id,
                status=stage,
            )
            context.daily_store.mark_suno_batch_running(
                batch_id=batch.id,
                stage="submitting_to_suno",
            )
            batch_name = f"daily-{context.user.id}-{context.date}-{context.job_id}-batch-{batch.batch_index:02d}"
            batch_result = run_suno_browser_command(
                "batch-suno.mjs",
                [
                    f"--batch={batch_name}",
                    f"--dir={download_dir}",
                    f"--screenshots={screenshot_root}",
                    f"--state={batch.state_path}",
                    *batch.prompt_files,
                ],
                timeout_seconds=self.suno_timeout_seconds,
            )
            if batch_result.returncode != 0:
                message, failure_stage = suno_batch_failure_message(
                    batch_result,
                    batch_index=batch.batch_index,
                )
                context.daily_store.mark_suno_batch_failed(
                    batch_id=batch.id,
                    error=message,
                    stage=failure_stage,
                )
                raise RuntimeError(message)

            batch_data = batch_result.json_output()
            if not isinstance(batch_data, dict) or not isinstance(batch_data.get("results"), list):
                message = f"Invalid Suno batch {batch.batch_index} output: {batch_result.stdout[:1000]}"
                context.daily_store.mark_suno_batch_failed(
                    batch_id=batch.id,
                    error=message,
                )
                raise RuntimeError(message)

            context.daily_store.mark_suno_batch_succeeded(
                batch_id=batch.id,
                result=batch_data,
            )
            batch_data_list.append(batch_data)

        return batch_data_list

    def _resume_suno_job(self, *, context: DailyGenerationContext, download_dir: Path) -> None:
        batches = context.daily_store.list_suno_batches(daily_job_id=context.job_id)
        if not batches:
            raise RuntimeError("No Suno batches found to resume.")

        prompt_manifest = self._prompt_manifest_from_suno_batches(batches)
        if not prompt_manifest:
            raise RuntimeError("No Suno prompt files found to resume.")

        playlist = context.daily_store.get_daily_playlist_by_id(
            user_id=context.user.id,
            playlist_id=context.playlist_id,
        )
        prompt_seed = playlist.prompt_seed if playlist is not None else {"date": context.date}

        context.daily_store.mark_job_running(job_id=context.job_id, stage="suno_queue")
        context.daily_store.set_playlist_status(
            playlist_id=context.playlist_id,
            status="suno_queue",
            job_id=context.job_id,
            clear_completed=True,
        )
        batch_data_list = self._drain_suno_queue(
            context=context,
            batches=batches,
            download_dir=download_dir,
        )
        self._finish_suno_results(
            context=context,
            prompt_manifest=prompt_manifest,
            batch_data_list=batch_data_list,
            prompt_seed=prompt_seed,
        )

    def _finish_suno_results(
        self,
        *,
        context: DailyGenerationContext,
        prompt_manifest: list[dict[str, Any]],
        batch_data_list: list[dict[str, Any]],
        prompt_seed: dict[str, Any],
        playlist_history_args: SimpleNamespace | None = None,
        playlist_history_seed: dict[str, Any] | None = None,
    ) -> None:
        batch_results = [
            result
            for batch_data in batch_data_list
            for result in batch_data.get("results", [])
            if isinstance(result, dict)
        ]

        context.daily_store.mark_job_stage(job_id=context.job_id, stage="importing")
        context.daily_store.set_playlist_status(
            playlist_id=context.playlist_id,
            status="importing",
        )
        songs = self._import_batch_results(
            context=context,
            prompt_manifest=prompt_manifest,
            batch_results=batch_results,
        )

        if playlist_history_args is not None and playlist_history_seed is not None:
            prompt_cli.save_playlist_history(playlist_history_args, playlist_history_seed)
        context.daily_store.replace_daily_songs(
            daily_playlist_id=context.playlist_id,
            songs=songs,
        )
        context.daily_store.set_playlist_status(
            playlist_id=context.playlist_id,
            status="ready",
            error="",
            prompt_seed={
                **prompt_seed,
                "suno_batches": [
                    {
                        "batch_name": batch_data.get("batchName"),
                        "download_dir": batch_data.get("downloadDir"),
                        "screenshot_dir": batch_data.get("screenshotDir"),
                        "state_path": batch_data.get("statePath"),
                        "song_count": len(batch_data.get("results", [])),
                    }
                    for batch_data in batch_data_list
                ],
            },
            completed=True,
        )
        context.daily_store.mark_job_succeeded(
            job_id=context.job_id,
            result={
                "daily_playlist_id": context.playlist_id,
                "song_count": len(songs),
                "date": context.date,
                "suno_batch_count": len(batch_data_list),
            },
        )

    def _prompt_manifest_from_suno_batches(
        self,
        batches: list[StoredDailySunoBatch],
    ) -> list[dict[str, Any]]:
        manifest: list[dict[str, Any]] = []
        seen: set[str] = set()
        for batch in batches:
            for offset, prompt_file in enumerate(batch.prompt_files):
                if prompt_file in seen:
                    continue
                seen.add(prompt_file)
                manifest.append(
                    self._prompt_manifest_from_file(
                        Path(prompt_file),
                        fallback_index=batch.position_start + offset,
                    )
                )
        return sorted(manifest, key=lambda item: int(item.get("index") or 0))

    def _prompt_manifest_from_file(self, prompt_file: Path, *, fallback_index: int) -> dict[str, Any]:
        index_match = re.match(r"^(\d+)-", prompt_file.name)
        index = int(index_match.group(1)) if index_match else fallback_index
        selected_brief_index = None
        tags: list[str] = []
        style_prompt = ""
        selected_brief: dict[str, Any] = {}
        if prompt_file.exists():
            content = prompt_file.read_text(encoding="utf-8")
            style_prompt = _markdown_section(content, "Style Prompt")
            tags = self._style_prompt_tags(style_prompt)
            selected_brief = _json_code_block(_markdown_section(content, "Selected Brief"))
            suno_submit = _key_value_section(_markdown_section(content, "Suno Submit"))
            lyrics_text = _markdown_section(content, "Lyrics")
            selected_match = re.search(r"^- Selected:\s*(\d+)\s*$", content, flags=re.MULTILINE)
            if selected_match:
                selected_brief_index = int(selected_match.group(1))
        else:
            suno_submit = {}
            lyrics_text = ""
        lyrics_mode = _lyrics_mode(
            suno_submit.get("lyrics_mode"),
            has_lyrics=bool(lyrics_text.strip()),
        )
        return {
            "index": index,
            "tags": tags,
            "style_prompt": style_prompt,
            "prompt_file": prompt_file,
            "lyrics_mode": lyrics_mode,
            "used_llm_lyrics": lyrics_mode != "suno",
            "selected_brief_index": selected_brief_index,
            "selected_brief": selected_brief,
            "song_metrics": {},
        }

    def _import_batch_results(
        self,
        *,
        context: DailyGenerationContext,
        prompt_manifest: list[dict[str, Any]],
        batch_results: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        selected_results = self._select_one_result_per_prompt(
            prompt_manifest=prompt_manifest,
            batch_results=batch_results,
        )
        existing_daily_songs = context.daily_store.list_daily_songs(
            daily_playlist_id=context.playlist_id,
        )
        existing_by_prompt = {
            self._prompt_file_key(item.prompt_file): item
            for item in existing_daily_songs
            if item.prompt_file
        }
        existing_by_position = {
            item.position: item
            for item in existing_daily_songs
        }
        songs = []
        for meta, result in selected_results:
            position = int(meta.get("index", len(songs) + 1)) - 1
            prompt_file = str(meta.get("prompt_file", ""))
            title = str(result.get("title") or meta.get("selected_brief", {}).get("title_seed") or "Daily Song")
            duration_seconds = result.get("selectedSeconds")
            if duration_seconds is not None:
                duration_seconds = int(duration_seconds)

            existing_entry = existing_by_prompt.get(self._prompt_file_key(prompt_file))
            if existing_entry is None and context.resume:
                existing_entry = existing_by_position.get(position)
            song: StoredSong | None = None
            if existing_entry is not None:
                try:
                    song = context.song_store.get_song(existing_entry.song_id)
                except KeyError:
                    song = None
            if song is None:
                song = context.song_store.create_song_from_file(
                    source_path=Path(str(result.get("targetPath", ""))),
                    title=title,
                    artist="OpenTunes Daily",
                    album=f"Daily {context.date}",
                    tags=meta.get("tags", []),
                    duration_seconds=duration_seconds,
                    source="suno-daily",
                )
            songs.append(
                {
                    "song_id": song.id,
                    "position": position,
                    "tags": meta.get("tags", []),
                    "prompt_file": prompt_file,
                    "suno_url": str(result.get("songUrl", "")),
                    "generation_status": "ready",
                    "metadata": {
                        "selected_brief_index": meta.get("selected_brief_index"),
                        "selected_brief": meta.get("selected_brief", {}),
                        "style_prompt_tags": meta.get("tags", []),
                        "lyrics_mode": meta.get("lyrics_mode", "llm"),
                        "used_llm_lyrics": bool(meta.get("lyrics_mode", "llm") != "suno"),
                        "song_metrics": meta.get("song_metrics", {}),
                        "selected_duration": result.get("selectedDuration"),
                        "suggested_filename": result.get("suggestedFilename"),
                    },
                }
            )
        return songs

    def _select_one_result_per_prompt(
        self,
        *,
        prompt_manifest: list[dict[str, Any]],
        batch_results: list[dict[str, Any]],
    ) -> list[tuple[dict[str, Any], dict[str, Any]]]:
        ordered_manifest = sorted(
            prompt_manifest,
            key=lambda item: int(item.get("index") or 0),
        )
        if not ordered_manifest:
            return [
                (
                    {"index": index + 1, "tags": [], "prompt_file": ""},
                    result,
                )
                for index, result in enumerate(batch_results)
            ]

        manifest_by_file = {
            self._prompt_file_key(item["prompt_file"]): item
            for item in ordered_manifest
            if item.get("prompt_file")
        }
        selected: list[tuple[dict[str, Any], dict[str, Any]]] = []
        fallback_results: list[dict[str, Any]] = []
        used_positions: set[int] = set()

        for result in batch_results:
            file_key = self._prompt_file_key(result.get("file", ""))
            meta = manifest_by_file.get(file_key)
            if meta is None:
                fallback_results.append(result)
                continue
            position = int(meta.get("index", len(selected) + 1)) - 1
            if position in used_positions:
                continue
            selected.append((meta, result))
            used_positions.add(position)

        fallback_index = 0
        for meta in ordered_manifest:
            position = int(meta.get("index", len(selected) + 1)) - 1
            if position in used_positions:
                continue
            if fallback_index >= len(fallback_results):
                break
            selected.append((meta, fallback_results[fallback_index]))
            fallback_index += 1
            used_positions.add(position)

        return sorted(
            selected,
            key=lambda item: int(item[0].get("index") or 0),
        )

    def _prompt_file_key(self, value: Any) -> str:
        if value is None:
            return ""
        raw_value = str(value)
        if not raw_value:
            return ""
        return str(Path(raw_value).expanduser().resolve())

    def _style_prompt_tags(self, style_prompt: str) -> list[str]:
        model = self._load_style_tag_model()
        if model is None:
            return []
        return style_prompt_tags_from_text(model, style_prompt)

    def _load_style_tag_model(self) -> StyleAssociationModel | None:
        if self._style_tag_model_loaded:
            return self._style_tag_model
        self._style_tag_model_loaded = True
        if not self.model_path.exists():
            return None
        self._style_tag_model = StyleAssociationModel.load(self.model_path)
        return self._style_tag_model


def style_prompt_tags_from_text(
    model: StyleAssociationModel,
    style_prompt: str,
    *,
    min_similarity: float = STYLE_PROMPT_TAG_MIN_SIMILARITY,
    similarity_margin: float = STYLE_PROMPT_TAG_SIMILARITY_MARGIN,
) -> list[str]:
    """Map positive Suno style-prompt language onto known model tags."""
    fragments = _positive_style_prompt_fragments(style_prompt)
    if not fragments:
        return []

    normalized_tags = [(tag, _style_text(tag)) for tag in model.tags]
    blocked_tags = set(
        _negative_style_prompt_tags(
            model=model,
            style_prompt=style_prompt,
            normalized_tags=normalized_tags,
        )
    )
    tag_scores: dict[str, float] = {}
    first_seen: dict[str, int] = {}

    for position, fragment in enumerate(fragments):
        fragment_tags = _known_tags_in_style_fragment(
            model=model,
            fragment=fragment,
            normalized_tags=normalized_tags,
        )
        if not fragment_tags:
            continue

        for tag in fragment_tags:
            if tag in blocked_tags:
                continue
            _record_style_tag(
                tag_scores=tag_scores,
                first_seen=first_seen,
                tag=tag,
                score=1.0,
                position=position,
            )

        vector = model.embed_tags(fragment_tags)
        if not np.any(vector):
            continue
        scores = model.tag_embeddings @ vector
        max_score = float(np.max(scores)) if len(scores) else 0.0
        cutoff = max(float(min_similarity), max_score - float(similarity_margin))
        for index in np.where(scores >= cutoff)[0]:
            tag = model.tags[int(index)]
            if tag in blocked_tags:
                continue
            _record_style_tag(
                tag_scores=tag_scores,
                first_seen=first_seen,
                tag=tag,
                score=float(scores[int(index)]),
                position=position,
            )

    return sorted(
        tag_scores,
        key=lambda tag: (-tag_scores[tag], first_seen[tag], tag),
    )


def _record_style_tag(
    *,
    tag_scores: dict[str, float],
    first_seen: dict[str, int],
    tag: str,
    score: float,
    position: int,
) -> None:
    if score > tag_scores.get(tag, -1.0):
        tag_scores[tag] = score
    first_seen.setdefault(tag, position)


def _positive_style_prompt_fragments(style_prompt: str) -> list[str]:
    fragments: list[str] = []
    for raw_fragment in re.split(r"[,.;\n]+", style_prompt):
        fragment = _style_text(raw_fragment)
        if not fragment:
            continue
        if _negative_style_fragment(fragment):
            continue
        fragment = _trim_negative_style_tail(fragment)
        if fragment:
            fragments.append(fragment)
    return fragments


def _negative_style_prompt_tags(
    *,
    model: StyleAssociationModel,
    style_prompt: str,
    normalized_tags: list[tuple[str, str]],
) -> list[str]:
    tags: list[str] = []
    for fragment in _negative_style_prompt_fragments(style_prompt):
        tags.extend(
            _known_tags_in_style_fragment(
                model=model,
                fragment=fragment,
                normalized_tags=normalized_tags,
            )
        )
    return list(dict.fromkeys(tags))


def _negative_style_prompt_fragments(style_prompt: str) -> list[str]:
    fragments: list[str] = []
    for raw_fragment in re.split(r"[,.;\n]+", style_prompt):
        fragment = _style_text(raw_fragment)
        if not fragment:
            continue
        if _negative_style_fragment(fragment):
            fragments.append(_strip_negative_style_prefix(fragment))
            continue
        tail = _negative_style_tail(fragment)
        if tail:
            fragments.append(tail)
    return [fragment for fragment in fragments if fragment]


def _negative_style_fragment(fragment: str) -> bool:
    return (
        fragment.startswith("no ")
        or fragment.startswith("without ")
        or fragment.startswith("avoid ")
        or fragment.startswith("exclude ")
        or fragment.startswith("negative ")
    )


def _strip_negative_style_prefix(fragment: str) -> str:
    for prefix in ("negative constraints no ", "negative no ", "no ", "without ", "avoid ", "exclude "):
        if fragment.startswith(prefix):
            return fragment[len(prefix) :].strip()
    return fragment


def _trim_negative_style_tail(fragment: str) -> str:
    padded = f" {fragment} "
    indexes = [
        padded.find(marker)
        for marker in (" no ", " without ", " avoid ", " exclude ")
        if padded.find(marker) >= 0
    ]
    if not indexes:
        return fragment
    return padded[: min(indexes)].strip()


def _negative_style_tail(fragment: str) -> str:
    padded = f" {fragment} "
    matches = [
        (padded.find(marker), marker)
        for marker in (" no ", " without ", " avoid ", " exclude ")
        if padded.find(marker) >= 0
    ]
    if not matches:
        return ""
    index, marker = min(matches, key=lambda item: item[0])
    return padded[index + len(marker) :].strip()


def _known_tags_in_style_fragment(
    *,
    model: StyleAssociationModel,
    fragment: str,
    normalized_tags: list[tuple[str, str]],
) -> list[str]:
    found: list[str] = []
    for tag, normalized_tag in normalized_tags:
        if not normalized_tag:
            continue
        if re.search(rf"(?<![a-z0-9]){re.escape(normalized_tag)}(?![a-z0-9])", fragment):
            found.append(tag)

    for alias_tag, patterns in _style_prompt_aliases().items():
        if alias_tag not in model.tag_to_index:
            continue
        if any(re.search(pattern, fragment) for pattern in patterns):
            found.append(alias_tag)

    return list(dict.fromkeys(found))


def _style_prompt_aliases() -> dict[str, tuple[str, ...]]:
    return {
        "male vocalists": (
            r"\bmale fronted\b",
            r"\bmale lead\b",
            r"\bmale vocal\b",
            r"\bbaritone\b",
        ),
        "female vocalists": (
            r"\bfemale fronted\b",
            r"\bfemale lead\b",
            r"\bfemale vocal\b",
            r"\bsoprano\b",
        ),
        "instrumental": (
            r"\binstrumental\b",
            r"\bwordless\b",
        ),
        "soundtrack": (
            r"\bcinematic\b",
            r"\bscore\b",
        ),
        "japanese": (
            r"\bj pop\b",
            r"\bjpop\b",
        ),
        "electronic": (
            r"\belectronic\b",
            r"\bdigital\b",
        ),
        "synth": (
            r"\bsynth\b",
            r"\bsynths\b",
            r"\bsynthesizer\b",
        ),
    }


def _style_text(value: object) -> str:
    text = str(value).strip().lower()
    text = re.sub(r"[_-]+", " ", text)
    text = re.sub(r"[^a-z0-9\s]+", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def create_daily_router(
    *,
    daily_store: DailyStore,
    song_store: SongStore,
    auth_store: AuthStore,
    require_auth: bool = True,
) -> APIRouter:
    router = APIRouter(prefix="/v1/daily", tags=["daily"])
    current_user = current_user_dependency(auth_store) if require_auth else _anonymous_user

    def require_user(user: AuthUser | None) -> AuthUser:
        if user is None:
            raise HTTPException(status_code=401, detail="Missing bearer token.")
        return user

    @router.get("/today", response_model=DailyTodayResponse)
    def today(
        date_value: str | None = Query(default=None, alias="date"),
        user: AuthUser | None = Depends(current_user),
    ) -> DailyTodayResponse:
        owner = require_user(user)
        target_date = normalize_daily_date(date_value)
        playlist = daily_store.get_daily_playlist(user_id=owner.id, date_value=target_date)
        active_job = daily_store.get_active_job(user_id=owner.id, date_value=target_date)
        if playlist is None:
            return DailyTodayResponse(
                date=target_date,
                status=active_job.stage if active_job else "not_started",
                active_job=daily_job_response(active_job, daily_store=daily_store) if active_job else None,
            )
        return DailyTodayResponse(
            date=target_date,
            status=playlist.status,
            playlist=daily_playlist_detail_response(
                daily_store=daily_store,
                song_store=song_store,
                playlist=playlist,
                user=owner,
            ),
            active_job=daily_job_response(active_job, daily_store=daily_store) if active_job else None,
        )

    @router.post("/today/generate", response_model=GenerateDailyResponse)
    def generate_today(
        request_body: GenerateDailyRequest,
        background_tasks: BackgroundTasks,
        request: Request,
        user: AuthUser | None = Depends(current_user),
    ) -> GenerateDailyResponse:
        owner = require_user(user)
        target_date = normalize_daily_date(request_body.date)
        existing = daily_store.get_daily_playlist(user_id=owner.id, date_value=target_date)
        active_job = daily_store.get_active_job(user_id=owner.id, date_value=target_date)
        generator = request.app.state.daily_generator
        if existing and existing.status == "ready" and not request_body.force:
            return GenerateDailyResponse(
                date=target_date,
                status="ready",
                playlist=daily_playlist_detail_response(
                    daily_store=daily_store,
                    song_store=song_store,
                    playlist=existing,
                    user=owner,
                ),
            )
        if active_job and not request_body.force:
            playlist = daily_store.get_daily_playlist_by_id(
                user_id=owner.id,
                playlist_id=active_job.daily_playlist_id,
            )
            return GenerateDailyResponse(
                date=target_date,
                status=active_job.stage,
                playlist=(
                    daily_playlist_detail_response(
                        daily_store=daily_store,
                        song_store=song_store,
                        playlist=playlist,
                        user=owner,
                    )
                    if playlist
                    else None
                ),
                job=daily_job_response(active_job, daily_store=daily_store),
            )

        should_resume_failed_job = request_body.resume or (
            request_body.force
            and existing is not None
            and existing.status in {"failed", SUNO_CAPTCHA_STATUS}
        )
        if should_resume_failed_job:
            resume_playlist = existing
            preferred_job_id = request_body.job_id or (existing.job_id if existing else None)
            if request_body.job_id:
                try:
                    requested_job = daily_store.get_job(user_id=owner.id, job_id=request_body.job_id)
                except KeyError:
                    requested_job = None
                if requested_job is not None and requested_job.date == target_date:
                    resume_playlist = daily_store.get_daily_playlist_by_id(
                        user_id=owner.id,
                        playlist_id=requested_job.daily_playlist_id,
                    )

            resume_job = (
                daily_store.get_resumable_job(
                    user_id=owner.id,
                    date_value=target_date,
                    daily_playlist_id=resume_playlist.id,
                    preferred_job_id=preferred_job_id,
                    allow_fallback=request_body.job_id is None,
                )
                if resume_playlist is not None
                else None
            )
            if resume_job is None:
                if request_body.resume:
                    if owner.id not in TEMP_PRE_SUNO_RETRY_USER_IDS:
                        raise HTTPException(
                            status_code=409,
                            detail="No resumable daily job found for this user, date, and playlist.",
                        )
                    # Temporary user-level repair: user 37 hit a failed daily
                    # before Suno batches existed, while the installed client
                    # retries failed dailies as resume requests.
                    pass
            else:
                daily_store.mark_job_running(job_id=resume_job.id, stage="suno_queue")
                daily_store.set_playlist_status(
                    playlist_id=resume_playlist.id,
                    status="suno_queue",
                    job_id=resume_job.id,
                    clear_completed=True,
                )
                context = DailyGenerationContext(
                    user=owner,
                    date=target_date,
                    playlist_id=resume_playlist.id,
                    job_id=resume_job.id,
                    daily_store=daily_store,
                    song_store=song_store,
                    auth_store=auth_store,
                    resume=True,
                )
                if request_body.wait:
                    run_daily_generation_job(generator, context)
                else:
                    background_tasks.add_task(run_daily_generation_job, generator, context)

                refreshed_playlist = daily_store.get_daily_playlist_by_id(
                    user_id=owner.id,
                    playlist_id=resume_playlist.id,
                )
                refreshed_job = daily_store.get_job(user_id=owner.id, job_id=resume_job.id)
                return GenerateDailyResponse(
                    date=target_date,
                    status=refreshed_playlist.status if refreshed_playlist else refreshed_job.stage,
                    playlist=(
                        daily_playlist_detail_response(
                            daily_store=daily_store,
                            song_store=song_store,
                            playlist=refreshed_playlist,
                            user=owner,
                        )
                        if refreshed_playlist
                        else None
                    ),
                    job=daily_job_response(refreshed_job, daily_store=daily_store),
                )

        playlist = daily_store.get_or_create_daily_playlist(user_id=owner.id, date_value=target_date)
        job = daily_store.create_job(
            user_id=owner.id,
            date_value=target_date,
            daily_playlist_id=playlist.id,
        )
        context = DailyGenerationContext(
            user=owner,
            date=target_date,
            playlist_id=playlist.id,
            job_id=job.id,
            daily_store=daily_store,
            song_store=song_store,
            auth_store=auth_store,
        )
        if request_body.wait:
            run_daily_generation_job(generator, context)
        else:
            background_tasks.add_task(run_daily_generation_job, generator, context)

        refreshed_playlist = daily_store.get_daily_playlist(user_id=owner.id, date_value=target_date)
        refreshed_job = daily_store.get_job(user_id=owner.id, job_id=job.id)
        return GenerateDailyResponse(
            date=target_date,
            status=refreshed_playlist.status if refreshed_playlist else refreshed_job.stage,
            playlist=(
                daily_playlist_detail_response(
                    daily_store=daily_store,
                    song_store=song_store,
                    playlist=refreshed_playlist,
                    user=owner,
                )
                if refreshed_playlist
                else None
            ),
            job=daily_job_response(refreshed_job, daily_store=daily_store),
        )

    @router.get("/history", response_model=DailyHistoryResponse)
    def history(
        limit: int = Query(default=30, ge=1, le=100),
        offset: int = Query(default=0, ge=0),
        user: AuthUser | None = Depends(current_user),
    ) -> DailyHistoryResponse:
        owner = require_user(user)
        playlists, total = daily_store.list_daily_playlists(
            user_id=owner.id,
            limit=limit,
            offset=offset,
        )
        return DailyHistoryResponse(
            playlists=[daily_playlist_response(playlist) for playlist in playlists],
            total=total,
            limit=limit,
            offset=offset,
        )

    @router.get("/jobs/{job_id}", response_model=DailyJobResponse)
    def get_job(
        job_id: str,
        user: AuthUser | None = Depends(current_user),
    ) -> DailyJobResponse:
        owner = require_user(user)
        try:
            return daily_job_response(
                daily_store.get_job(user_id=owner.id, job_id=job_id),
                daily_store=daily_store,
            )
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="Daily job not found.") from exc

    @router.get("/{date_value}", response_model=DailyPlaylistDetailResponse)
    def get_daily_playlist(
        date_value: str,
        user: AuthUser | None = Depends(current_user),
    ) -> DailyPlaylistDetailResponse:
        owner = require_user(user)
        target_date = normalize_daily_date(date_value)
        playlist = daily_store.get_daily_playlist(user_id=owner.id, date_value=target_date)
        if playlist is None:
            raise HTTPException(status_code=404, detail="Daily playlist not found.")
        return daily_playlist_detail_response(
            daily_store=daily_store,
            song_store=song_store,
            playlist=playlist,
            user=owner,
        )

    return router


def run_daily_generation_job(generator: DailyGenerator, context: DailyGenerationContext) -> None:
    try:
        generator.run(context)
    except Exception as exc:
        message = str(exc) or exc.__class__.__name__
        playlist_status = SUNO_CAPTCHA_STATUS if is_suno_captcha_required_error(message) else "failed"
        context.daily_store.mark_job_failed(
            job_id=context.job_id,
            error=message,
            stage=playlist_status,
        )
        context.daily_store.set_playlist_status(
            playlist_id=context.playlist_id,
            status=playlist_status,
            job_id=context.job_id,
            error=message,
            completed=True,
        )


def daily_playlist_detail_response(
    *,
    daily_store: DailyStore,
    song_store: SongStore,
    playlist: StoredDailyPlaylist,
    user: AuthUser,
) -> DailyPlaylistDetailResponse:
    entries = daily_store.list_daily_songs(daily_playlist_id=playlist.id)
    songs_by_id: dict[str, StoredSong] = {}
    for entry in entries:
        try:
            songs_by_id[entry.song_id] = song_store.get_song(entry.song_id)
        except KeyError:
            continue
    liked_at_by_song_id = song_store.liked_at_for_songs(user.id, list(songs_by_id))
    return DailyPlaylistDetailResponse(
        **daily_playlist_response(playlist).model_dump(),
        prompt_seed=playlist.prompt_seed,
        songs=[
            DailySongResponse(
                position=entry.position,
                tags=entry.tags,
                generation_status=entry.generation_status,
                prompt_file=entry.prompt_file,
                suno_url=entry.suno_url,
                metadata=entry.metadata,
                song=song_response(
                    songs_by_id[entry.song_id],
                    liked_at=liked_at_by_song_id.get(entry.song_id),
                ),
            )
            for entry in entries
            if entry.song_id in songs_by_id
        ],
    )


def daily_playlist_response(playlist: StoredDailyPlaylist) -> DailyPlaylistResponse:
    return DailyPlaylistResponse(
        id=playlist.id,
        date=playlist.date,
        title=playlist.title,
        status=playlist.status,
        song_count=playlist.song_count,
        job_id=playlist.job_id,
        error=playlist.error,
        created_at=playlist.created_at,
        updated_at=playlist.updated_at,
        completed_at=playlist.completed_at,
    )


def daily_suno_batch_response(batch: StoredDailySunoBatch) -> DailySunoBatchResponse:
    return DailySunoBatchResponse(
        id=batch.id,
        daily_job_id=batch.daily_job_id,
        batch_index=batch.batch_index,
        position_start=batch.position_start,
        position_end=batch.position_end,
        status=batch.status,
        stage=batch.stage,
        error=batch.error,
        prompt_files=batch.prompt_files,
        state_path=batch.state_path,
        result=batch.result,
        created_at=batch.created_at,
        updated_at=batch.updated_at,
        started_at=batch.started_at,
        completed_at=batch.completed_at,
    )


def daily_job_response(
    job: StoredDailyJob,
    *,
    daily_store: DailyStore | None = None,
) -> DailyJobResponse:
    batches = daily_store.list_suno_batches(daily_job_id=job.id) if daily_store else []
    return DailyJobResponse(
        id=job.id,
        date=job.date,
        daily_playlist_id=job.daily_playlist_id,
        status=job.status,
        stage=job.stage,
        error=job.error,
        result=job.result,
        created_at=job.created_at,
        updated_at=job.updated_at,
        started_at=job.started_at,
        completed_at=job.completed_at,
        batches=[daily_suno_batch_response(batch) for batch in batches],
    )


def daily_playlist_from_row(row: sqlite3.Row) -> StoredDailyPlaylist:
    return StoredDailyPlaylist(
        id=row["id"],
        user_id=int(row["user_id"]),
        date=row["date"],
        title=row["title"],
        status=row["status"],
        song_count=int(row["song_count"]),
        job_id=row["job_id"],
        error=row["error"],
        prompt_seed=_json_loads(row["prompt_seed_json"], {}),
        created_at=row["created_at"],
        updated_at=row["updated_at"],
        completed_at=row["completed_at"],
    )


def daily_song_from_row(row: sqlite3.Row) -> StoredDailySong:
    return StoredDailySong(
        daily_playlist_id=row["daily_playlist_id"],
        song_id=row["song_id"],
        position=int(row["position"]),
        tags=_clean_tags(_json_loads(row["tags_json"], [])),
        prompt_file=row["prompt_file"],
        suno_url=row["suno_url"],
        generation_status=row["generation_status"],
        metadata=_json_loads(row["metadata_json"], {}),
        added_at=row["added_at"],
    )


def daily_job_from_row(row: sqlite3.Row) -> StoredDailyJob:
    return StoredDailyJob(
        id=row["id"],
        user_id=int(row["user_id"]),
        date=row["date"],
        daily_playlist_id=row["daily_playlist_id"],
        status=row["status"],
        stage=row["stage"],
        error=row["error"],
        result=_json_loads(row["result_json"], {}),
        created_at=row["created_at"],
        updated_at=row["updated_at"],
        started_at=row["started_at"],
        completed_at=row["completed_at"],
    )


def daily_suno_batch_from_row(row: sqlite3.Row) -> StoredDailySunoBatch:
    return StoredDailySunoBatch(
        id=row["id"],
        daily_job_id=row["daily_job_id"],
        user_id=int(row["user_id"]),
        date=row["date"],
        daily_playlist_id=row["daily_playlist_id"],
        batch_index=int(row["batch_index"]),
        position_start=int(row["position_start"]),
        position_end=int(row["position_end"]),
        status=row["status"],
        stage=row["stage"],
        error=row["error"],
        prompt_files=[str(path) for path in _json_loads(row["prompt_files_json"], [])],
        state_path=row["state_path"],
        result=_json_loads(row["result_json"], {}),
        created_at=row["created_at"],
        updated_at=row["updated_at"],
        started_at=row["started_at"],
        completed_at=row["completed_at"],
    )


def normalize_daily_date(value: str | None = None) -> str:
    if value is None or not value.strip():
        return datetime.now(UTC).date().isoformat()
    try:
        return date.fromisoformat(value[:10]).isoformat()
    except ValueError as exc:
        raise HTTPException(status_code=422, detail="Invalid date. Use YYYY-MM-DD.") from exc


def _json_dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True)


def _json_loads(value: str, default: Any) -> Any:
    try:
        return json.loads(value)
    except (TypeError, json.JSONDecodeError):
        return default


def _clean_tags(tags: str | list[str]) -> list[str]:
    return list(dict.fromkeys(parse_style_tags(tags)))


def _markdown_section(markdown: str, heading: str) -> str:
    match = re.search(rf"^##\s+{re.escape(heading)}\s*$", markdown, flags=re.MULTILINE)
    if match is None:
        return ""
    start = match.end()
    next_match = re.search(r"^##\s+", markdown[start:], flags=re.MULTILINE)
    end = start + next_match.start() if next_match is not None else len(markdown)
    return markdown[start:end].strip()


def _append_suno_submit_section(
    markdown: str,
    *,
    lyrics_mode: str,
    reason: str,
    probability_percent: int,
) -> str:
    return "\n".join(
        [
            markdown.rstrip(),
            "",
            "## Suno Submit",
            "",
            f"lyrics_mode: {lyrics_mode}",
            f"reason: {reason}",
            f"probability_percent: {probability_percent}",
            "",
        ]
    )


def _key_value_section(value: str) -> dict[str, str]:
    result: dict[str, str] = {}
    for line in str(value or "").splitlines():
        match = re.match(r"\s*([A-Za-z0-9_-]+)\s*:\s*(.*?)\s*$", line)
        if not match:
            continue
        result[match.group(1).lower().replace("-", "_")] = match.group(2)
    return result


def _lyrics_mode(value: Any, *, has_lyrics: bool) -> str:
    if str(value or "").strip().lower() == "suno":
        return "suno"
    return "llm" if has_lyrics else "suno"


def _json_code_block(markdown: str) -> dict[str, Any]:
    match = re.search(r"```(?:json)?\s*(.*?)```", markdown, flags=re.DOTALL)
    source = match.group(1) if match is not None else markdown
    try:
        parsed = json.loads(source.strip())
    except (TypeError, json.JSONDecodeError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _anonymous_user() -> None:
    return None
