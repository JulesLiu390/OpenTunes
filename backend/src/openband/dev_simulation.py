from __future__ import annotations

import json
import math
import os
import re
import secrets
import shutil
import struct
import zlib
from pathlib import Path
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Header, HTTPException
from mutagen.id3 import APIC, ID3
from pydantic import BaseModel, Field

from music_taste_rec.style_model import parse_style_tags
from openband.auth import AuthStore, AuthUser
from openband.daily import (
    DAILY_RUNTIME_ROOT_ENV,
    DEFAULT_SUNO_BATCH_SIZE,
    DailyGenerationContext,
    DailyJobResponse,
    DailyPlaylistDetailResponse,
    DailyStore,
    daily_job_response,
    daily_playlist_detail_response,
    normalize_daily_date,
)
from openband.prompt_generation import cli as prompt_cli
from openband.songs import SongResponse, SongStore, song_response, utc_now


DEFAULT_SIMULATION_TAGS = [
    "alternative rock",
    "electronic",
    "synthpop",
    "j pop",
    "anime",
    "energetic",
    "catchy",
    "melodic",
    "atmospheric",
    "guitar",
    "bass",
    "male vocalists",
]

SIMULATION_TITLE_WORDS = [
    "Neon",
    "Static",
    "Velvet",
    "Chrome",
    "Signal",
    "Glass",
    "Midnight",
    "Circuit",
    "Skyline",
    "Afterglow",
]

SIMULATION_TITLE_NOUNS = [
    "Pulse",
    "Engine",
    "Weather",
    "Parade",
    "Transmission",
    "Halo",
    "Run",
    "Bloom",
    "Operator",
    "Protocol",
]


class SimulateDailyRequest(BaseModel):
    user_id: int = Field(ge=1)
    date: str | None = None
    count: int = Field(default=10, ge=1, le=50)
    force: bool = True
    mode: Literal["ready", "prompt_only"] = "ready"
    tags: list[str] = Field(default_factory=list, max_length=200)
    title_prefix: str = Field(default="Simulated", min_length=1, max_length=80)
    duration_seconds: int = Field(default=45, ge=1, le=600)
    with_covers: bool = True
    source_song_id: str | None = Field(default=None, max_length=120)


class SimulateDailyResponse(BaseModel):
    date: str
    status: str
    runtime_dir: str
    mode: Literal["ready", "prompt_only"] = "ready"
    prompt_files: list[str] = Field(default_factory=list)
    playlist: DailyPlaylistDetailResponse | None = None
    job: DailyJobResponse | None = None


class SimulateSongRequest(BaseModel):
    title: str = Field(default="Simulated Single", min_length=1, max_length=180)
    mode: Literal["ready", "prompt_only"] = "ready"
    tags: list[str] = Field(default_factory=list, max_length=200)
    duration_seconds: int = Field(default=45, ge=1, le=600)
    with_cover: bool = True
    source_song_id: str | None = Field(default=None, max_length=120)


class SimulateSongResponse(BaseModel):
    status: str
    mode: Literal["ready", "prompt_only"]
    runtime_dir: str
    prompt_file: str
    style_prompt: str
    lyrics: str
    song: SongResponse | None = None


class SimulatedDailyGenerator:
    def __init__(
        self,
        *,
        runtime_root: Path,
        count: int,
        mode: Literal["ready", "prompt_only"],
        tags: list[str],
        title_prefix: str,
        duration_seconds: int,
        with_covers: bool,
        source_song_id: str | None = None,
    ):
        self.runtime_root = Path(runtime_root)
        self.count = count
        self.mode = mode
        self.tags = tags
        self.title_prefix = title_prefix.strip() or "Simulated"
        self.duration_seconds = duration_seconds
        self.with_covers = with_covers
        self.source_song_id = source_song_id

    def run(self, context: DailyGenerationContext) -> None:
        job_dir = self.runtime_root / str(context.user.id) / context.date / context.job_id
        prompt_dir = job_dir / "prompts"
        download_dir = job_dir / "downloads"
        screenshot_dir = job_dir / "screenshots"
        prompt_dir.mkdir(parents=True, exist_ok=True)
        download_dir.mkdir(parents=True, exist_ok=True)
        screenshot_dir.mkdir(parents=True, exist_ok=True)

        seed_tags = self._seed_tags(context)
        song_seeds = [
            {
                "index": index,
                "tags": _tags_for_index(seed_tags, index),
                "simulation": True,
            }
            for index in range(1, self.count + 1)
        ]
        prompt_seed: dict[str, Any] = {
            "date": context.date,
            "simulated": True,
            "user_tags": seed_tags,
            "songs": song_seeds,
            "constraints": {
                "total": self.count,
                "tags_per_song": min(6, len(seed_tags)),
                "batch_size": DEFAULT_SUNO_BATCH_SIZE,
            },
        }

        context.daily_store.mark_job_running(job_id=context.job_id, stage="simulating_prompts")
        context.daily_store.set_playlist_status(
            playlist_id=context.playlist_id,
            status="simulating_prompts",
            job_id=context.job_id,
            prompt_seed=prompt_seed,
            clear_completed=True,
        )

        prompt_manifest = self._write_prompt_files(
            prompt_dir=prompt_dir,
            date_value=context.date,
            song_seeds=song_seeds,
        )
        prompt_seed = {
            **prompt_seed,
            "playlist_prompt": _simulation_playlist_prompt(prompt_manifest),
            "runtime_dir": str(job_dir),
            "prompt_files": [str(item["prompt_file"]) for item in prompt_manifest],
        }

        if self.mode == "prompt_only":
            context.daily_store.replace_daily_songs(
                daily_playlist_id=context.playlist_id,
                songs=[],
            )
            context.daily_store.set_playlist_status(
                playlist_id=context.playlist_id,
                status="prompt_ready",
                job_id=context.job_id,
                prompt_seed={**prompt_seed, "mode": "prompt_only"},
                completed=True,
            )
            context.daily_store.mark_job_succeeded(
                job_id=context.job_id,
                result={
                    "daily_playlist_id": context.playlist_id,
                    "song_count": 0,
                    "prompt_count": len(prompt_manifest),
                    "date": context.date,
                    "simulated": True,
                    "mode": "prompt_only",
                    "runtime_dir": str(job_dir),
                    "prompt_files": [str(item["prompt_file"]) for item in prompt_manifest],
                },
            )
            return

        context.daily_store.mark_job_stage(job_id=context.job_id, stage="simulating_suno")
        context.daily_store.set_playlist_status(
            playlist_id=context.playlist_id,
            status="simulating_suno",
            prompt_seed=prompt_seed,
        )

        batches = self._queue_batches(
            context=context,
            prompt_manifest=prompt_manifest,
            job_dir=job_dir,
        )
        batch_data_list = self._write_batch_states(
            context=context,
            batches=batches,
            prompt_manifest=prompt_manifest,
            download_dir=download_dir,
            screenshot_dir=screenshot_dir,
        )

        context.daily_store.mark_job_stage(job_id=context.job_id, stage="simulating_import")
        context.daily_store.set_playlist_status(
            playlist_id=context.playlist_id,
            status="simulating_import",
        )
        daily_songs = self._import_simulated_songs(
            context=context,
            prompt_manifest=prompt_manifest,
            download_dir=download_dir,
        )

        context.daily_store.replace_daily_songs(
            daily_playlist_id=context.playlist_id,
            songs=daily_songs,
        )
        context.daily_store.set_playlist_status(
            playlist_id=context.playlist_id,
            status="ready",
            job_id=context.job_id,
            prompt_seed={
                **prompt_seed,
                "mode": "ready",
                "runtime_dir": str(job_dir),
                "suno_batches": [
                    {
                        "batch_name": batch_data.get("batchName"),
                        "download_dir": batch_data.get("downloadDir"),
                        "screenshot_dir": batch_data.get("screenshotDir"),
                        "state_path": batch_data.get("statePath"),
                        "song_count": len(batch_data.get("results", [])),
                        "simulated": True,
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
                "song_count": len(daily_songs),
                "prompt_count": len(prompt_manifest),
                "date": context.date,
                "simulated": True,
                "mode": "ready",
                "runtime_dir": str(job_dir),
                "prompt_files": [str(item["prompt_file"]) for item in prompt_manifest],
                "suno_batch_count": len(batch_data_list),
            },
        )

    def _seed_tags(self, context: DailyGenerationContext) -> list[str]:
        request_tags = parse_style_tags(self.tags)
        if request_tags:
            return request_tags
        profile_tags = context.auth_store.get_music_tags(context.user.id).tags
        if profile_tags:
            return parse_style_tags(profile_tags)
        return DEFAULT_SIMULATION_TAGS

    def _write_prompt_files(
        self,
        *,
        prompt_dir: Path,
        date_value: str,
        song_seeds: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        manifest: list[dict[str, Any]] = []
        for seed in song_seeds:
            index = int(seed["index"])
            tags = [str(tag) for tag in seed.get("tags", [])]
            title = _simulated_title(self.title_prefix, index)
            selected_brief = {
                "title_seed": title,
                "concept": f"Development simulation track for Daily {date_value}, song {index}.",
                "sound_direction": f"Blend {', '.join(tags[:4])} into a compact test arrangement.",
                "performance_direction": "Synthetic test performance with clear intro, hook, and outro markers.",
                "lyric_angle": "Short generated placeholder lyrics for local development only.",
                "arrangement_hook": "A repeating metronomic pulse makes playback state easy to inspect.",
            }
            style_prompt = _style_prompt(tags, index)
            content = _prompt_markdown(
                tags=tags,
                selected_brief=selected_brief,
                style_prompt=style_prompt,
                lyrics=_lyrics(title, index),
            )
            prompt_file = prompt_dir / f"{index:02d}-{_safe_slug(title)}.md"
            prompt_file.write_text(content, encoding="utf-8")
            manifest.append(
                {
                    "index": index,
                    "title": title,
                    "tags": tags,
                    "style_prompt": style_prompt,
                    "prompt_file": prompt_file,
                    "selected_brief_index": 1,
                    "selected_brief": selected_brief,
                    "song_metrics": {
                        "simulation": True,
                    },
                }
            )
        return manifest

    def _queue_batches(
        self,
        *,
        context: DailyGenerationContext,
        prompt_manifest: list[dict[str, Any]],
        job_dir: Path,
    ):
        batches = []
        for offset in range(0, len(prompt_manifest), DEFAULT_SUNO_BATCH_SIZE):
            batch_index = (offset // DEFAULT_SUNO_BATCH_SIZE) + 1
            batch_manifest = prompt_manifest[offset : offset + DEFAULT_SUNO_BATCH_SIZE]
            indexes = [int(item["index"]) for item in batch_manifest]
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

    def _write_batch_states(
        self,
        *,
        context: DailyGenerationContext,
        batches: list[Any],
        prompt_manifest: list[dict[str, Any]],
        download_dir: Path,
        screenshot_dir: Path,
    ) -> list[dict[str, Any]]:
        manifest_by_index = {int(item["index"]): item for item in prompt_manifest}
        batch_data_list: list[dict[str, Any]] = []
        for batch in batches:
            context.daily_store.mark_suno_batch_running(
                batch_id=batch.id,
                stage="simulated_submit",
            )
            batch_name = f"sim-daily-{context.user.id}-{context.date}-{context.job_id}-batch-{batch.batch_index:02d}"
            results = []
            tasks: dict[str, Any] = {}
            for index in range(batch.position_start, batch.position_end + 1):
                meta = manifest_by_index[index]
                target_path = download_dir / f"{index:02d}-{_safe_slug(meta['title'])}.mp3"
                results.append(
                    {
                        "file": str(meta["prompt_file"]),
                        "title": meta["title"],
                        "songUrl": f"https://suno.example/openband-sim/{context.job_id}/{index}",
                        "targetPath": str(target_path),
                        "selectedDuration": _format_duration(self.duration_seconds),
                        "selectedSeconds": self.duration_seconds,
                        "suggestedFilename": target_path.name,
                        "simulated": True,
                    }
                )
                tasks[_safe_slug(meta["title"])] = {
                    "title": meta["title"],
                    "file": str(meta["prompt_file"]),
                    "status": "downloaded",
                    "songUrl": f"https://suno.example/openband-sim/{context.job_id}/{index}",
                    "targetPath": str(target_path),
                    "selectedDuration": _format_duration(self.duration_seconds),
                    "selectedSeconds": self.duration_seconds,
                    "simulated": True,
                }
            state = {
                "version": 1,
                "phase": "complete",
                "batchName": batch_name,
                "downloadDir": str(download_dir),
                "screenshotDir": str(screenshot_dir),
                "statePath": batch.state_path,
                "updatedAt": utc_now(),
                "simulated": True,
                "tasks": tasks,
            }
            Path(batch.state_path).write_text(
                json.dumps(state, ensure_ascii=False, indent=2, sort_keys=True),
                encoding="utf-8",
            )
            batch_data = {
                "batchName": batch_name,
                "downloadDir": str(download_dir),
                "screenshotDir": str(screenshot_dir),
                "statePath": batch.state_path,
                "results": results,
                "simulated": True,
            }
            context.daily_store.mark_suno_batch_succeeded(
                batch_id=batch.id,
                result=batch_data,
                stage="simulated_downloaded",
            )
            batch_data_list.append(batch_data)
        return batch_data_list

    def _import_simulated_songs(
        self,
        *,
        context: DailyGenerationContext,
        prompt_manifest: list[dict[str, Any]],
        download_dir: Path,
    ) -> list[dict[str, Any]]:
        source_audio = _source_audio_path(context.song_store, self.source_song_id)
        daily_songs: list[dict[str, Any]] = []
        for meta in prompt_manifest:
            index = int(meta["index"])
            title = str(meta["title"])
            target_path = download_dir / f"{index:02d}-{_safe_slug(title)}.mp3"
            if source_audio is not None:
                shutil.copyfile(source_audio, target_path)
            else:
                _write_simulated_mp3(
                    target_path,
                    duration_seconds=self.duration_seconds,
                    cover_png=(_cover_png(index) if self.with_covers else None),
                )
            song = context.song_store.create_song_from_file(
                source_path=target_path,
                title=title,
                artist="OpenTunes Simulator",
                album=f"Daily {context.date}",
                tags=meta.get("tags", []),
                duration_seconds=self.duration_seconds,
                source="simulated-daily",
                offload_to_object_storage=False,
            )
            daily_songs.append(
                {
                    "song_id": song.id,
                    "position": index - 1,
                    "tags": meta.get("tags", []),
                    "prompt_file": str(meta["prompt_file"]),
                    "suno_url": f"https://suno.example/openband-sim/{context.job_id}/{index}",
                    "generation_status": "ready",
                    "metadata": {
                        "simulated": True,
                        "selected_brief_index": meta.get("selected_brief_index"),
                        "selected_brief": meta.get("selected_brief", {}),
                        "style_prompt_tags": meta.get("tags", []),
                        "song_metrics": meta.get("song_metrics", {}),
                        "selected_duration": _format_duration(self.duration_seconds),
                        "suggested_filename": target_path.name,
                    },
                }
            )
        return daily_songs


def create_dev_simulation_router(
    *,
    auth_store: AuthStore,
    daily_store: DailyStore,
    song_store: SongStore,
    admin_key: str | None = None,
    runtime_root: Path | None = None,
) -> APIRouter:
    router = APIRouter(prefix="/v1/dev", tags=["dev"])
    configured_runtime_root = _runtime_root(runtime_root)

    def require_admin(x_admin_key: Annotated[str | None, Header()] = None) -> None:
        if not admin_key:
            raise HTTPException(status_code=503, detail="Admin key is not configured.")
        if not x_admin_key or not secrets.compare_digest(x_admin_key, admin_key):
            raise HTTPException(status_code=403, detail="Invalid admin key.")

    @router.post(
        "/daily/simulate",
        response_model=SimulateDailyResponse,
        dependencies=[Depends(require_admin)],
    )
    def simulate_daily(request_body: SimulateDailyRequest) -> SimulateDailyResponse:
        target_date = normalize_daily_date(request_body.date)
        user = auth_store.get_user(request_body.user_id)
        if user is None:
            raise HTTPException(status_code=404, detail="User not found.")

        playlist = daily_store.get_or_create_daily_playlist(
            user_id=user.id,
            date_value=target_date,
        )
        runtime_dir = configured_runtime_root / str(user.id) / target_date
        if playlist.status in {"ready", "prompt_ready"} and not request_body.force:
            return SimulateDailyResponse(
                date=target_date,
                status=playlist.status,
                runtime_dir=str(runtime_dir / (playlist.job_id or "")),
                mode=(
                    "prompt_only"
                    if playlist.prompt_seed.get("mode") == "prompt_only"
                    or playlist.status == "prompt_ready"
                    else "ready"
                ),
                prompt_files=[str(path) for path in playlist.prompt_seed.get("prompt_files", [])],
                playlist=daily_playlist_detail_response(
                    daily_store=daily_store,
                    song_store=song_store,
                    playlist=playlist,
                    user=user,
                ),
            )

        job = daily_store.create_job(
            user_id=user.id,
            date_value=target_date,
            daily_playlist_id=playlist.id,
        )
        generator = SimulatedDailyGenerator(
            runtime_root=configured_runtime_root,
            count=request_body.count,
            mode=request_body.mode,
            tags=request_body.tags,
            title_prefix=request_body.title_prefix,
            duration_seconds=request_body.duration_seconds,
            with_covers=request_body.with_covers,
            source_song_id=request_body.source_song_id,
        )
        context = DailyGenerationContext(
            user=user,
            date=target_date,
            playlist_id=playlist.id,
            job_id=job.id,
            daily_store=daily_store,
            song_store=song_store,
            auth_store=auth_store,
        )
        try:
            generator.run(context)
        except Exception as exc:
            message = str(exc)[:4000]
            daily_store.mark_job_failed(job_id=job.id, error=message, stage="simulation_failed")
            daily_store.set_playlist_status(
                playlist_id=playlist.id,
                status="failed",
                job_id=job.id,
                error=message,
                completed=True,
            )
            raise

        updated_playlist = daily_store.get_daily_playlist_by_id(
            user_id=user.id,
            playlist_id=playlist.id,
        )
        updated_job = daily_store.get_job(user_id=user.id, job_id=job.id)
        return SimulateDailyResponse(
            date=target_date,
            status=updated_playlist.status if updated_playlist else "ready",
            runtime_dir=str(configured_runtime_root / str(user.id) / target_date / job.id),
            mode=request_body.mode,
            prompt_files=(
                [str(path) for path in updated_playlist.prompt_seed.get("prompt_files", [])]
                if updated_playlist
                else []
            ),
            playlist=(
                daily_playlist_detail_response(
                    daily_store=daily_store,
                    song_store=song_store,
                    playlist=updated_playlist,
                    user=user,
                )
                if updated_playlist
                else None
            ),
            job=daily_job_response(updated_job, daily_store=daily_store),
        )

    @router.post(
        "/songs/simulate",
        response_model=SimulateSongResponse,
        dependencies=[Depends(require_admin)],
    )
    def simulate_song(request_body: SimulateSongRequest) -> SimulateSongResponse:
        run_id = f"song_sim_{secrets.token_urlsafe(8).replace('-', '').replace('_', '')}"
        runtime_dir = configured_runtime_root / "_dev" / "songs" / run_id
        runtime_dir.mkdir(parents=True, exist_ok=True)

        tags = parse_style_tags(request_body.tags) or DEFAULT_SIMULATION_TAGS[:6]
        title = request_body.title.strip()
        selected_brief = {
            "title_seed": title,
            "concept": "Single-song development simulation.",
            "sound_direction": f"Blend {', '.join(tags[:4])} into one compact test track.",
            "performance_direction": "Synthetic local test performance with obvious playback markers.",
            "lyric_angle": "Short generated placeholder lyrics for local development only.",
            "arrangement_hook": "A repeating pulse makes seek and playback testing easy.",
        }
        style_prompt = _style_prompt(tags, 1)
        lyrics = _lyrics(title, 1)
        prompt_file = runtime_dir / f"01-{_safe_slug(title)}.md"
        prompt_file.write_text(
            _prompt_markdown(
                tags=tags,
                selected_brief=selected_brief,
                style_prompt=style_prompt,
                lyrics=lyrics,
            ),
            encoding="utf-8",
        )

        if request_body.mode == "prompt_only":
            return SimulateSongResponse(
                status="prompt_ready",
                mode="prompt_only",
                runtime_dir=str(runtime_dir),
                prompt_file=str(prompt_file),
                style_prompt=style_prompt,
                lyrics=lyrics,
            )

        audio_path = runtime_dir / f"01-{_safe_slug(title)}.mp3"
        source_audio = _source_audio_path(song_store, request_body.source_song_id)
        if source_audio is not None:
            shutil.copyfile(source_audio, audio_path)
        else:
            _write_simulated_mp3(
                audio_path,
                duration_seconds=request_body.duration_seconds,
                cover_png=(_cover_png(1) if request_body.with_cover else None),
            )
        song = song_store.create_song_from_file(
            source_path=audio_path,
            title=title,
            artist="OpenTunes Simulator",
            album="Dev Simulation",
            tags=tags,
            duration_seconds=request_body.duration_seconds,
            source="simulated-single",
            offload_to_object_storage=False,
        )
        return SimulateSongResponse(
            status="ready",
            mode="ready",
            runtime_dir=str(runtime_dir),
            prompt_file=str(prompt_file),
            style_prompt=style_prompt,
            lyrics=lyrics,
            song=song_response(song),
        )

    return router


def _runtime_root(runtime_root: Path | None) -> Path:
    root = Path(
        runtime_root
        or os.getenv(DAILY_RUNTIME_ROOT_ENV)
        or prompt_cli.BACKEND_ROOT / "runtime" / "daily"
    )
    if not root.is_absolute():
        root = prompt_cli.BACKEND_ROOT / root
    return root.resolve()


def _tags_for_index(seed_tags: list[str], index: int) -> list[str]:
    if not seed_tags:
        return []
    count = min(6, len(seed_tags))
    start = (index - 1) % len(seed_tags)
    return [seed_tags[(start + offset) % len(seed_tags)] for offset in range(count)]


def _simulated_title(prefix: str, index: int) -> str:
    word = SIMULATION_TITLE_WORDS[(index - 1) % len(SIMULATION_TITLE_WORDS)]
    noun = SIMULATION_TITLE_NOUNS[(index * 3 - 1) % len(SIMULATION_TITLE_NOUNS)]
    return f"{prefix} {word} {noun}"


def _style_prompt(tags: list[str], index: int) -> str:
    bpm = 96 + (index % 7) * 8
    tag_text = ", ".join(tags) if tags else "test pop, synthetic pulse"
    return (
        f"{bpm} BPM, development simulation track, {tag_text}, clear intro marker, "
        "steady synthetic pulse, compact chorus lift, simple outro tail, no artist imitation."
    )


def _lyrics(title: str, index: int) -> str:
    return (
        "[Verse]\n"
        f"Test signal {index} wakes in the wire\n"
        "Every small light keeps the timing clear\n\n"
        "[Chorus]\n"
        f"{title}\n"
        "Run the loop and let the meters glow\n\n"
        "[Outro]\n"
        "End marker, fade marker, ready to go\n"
    )


def _prompt_markdown(
    *,
    tags: list[str],
    selected_brief: dict[str, Any],
    style_prompt: str,
    lyrics: str,
) -> str:
    selected_json = json.dumps(selected_brief, ensure_ascii=False, indent=2)
    return (
        "# Song Brief Result\n\n"
        "- Generated By: OpenTunes dev simulation\n"
        "- Selected: 1\n\n"
        "## Song Tags\n\n"
        f"{', '.join(tags)}\n\n"
        "## Brief Candidates\n\n"
        "```json\n"
        f"[{selected_json}]\n"
        "```\n\n"
        "## Selected Brief\n\n"
        "```json\n"
        f"{selected_json}\n"
        "```\n\n"
        "## Generated Output\n\n"
        "# Suno Prompt Result\n\n"
        "## Request\n\n"
        "Simulated local development generation.\n\n"
        "## Style Prompt\n\n"
        f"{style_prompt}\n\n"
        "## Lyrics\n\n"
        f"{lyrics}"
    )


def _simulation_playlist_prompt(prompt_manifest: list[dict[str, Any]]) -> str:
    parts = []
    for item in prompt_manifest:
        parts.append(
            f"## Song {item['index']} - {item['title']}\n"
            f"Tags: {', '.join(item.get('tags', []))}\n"
            "Prompt: Simulated local development prompt."
        )
    return "\n\n".join(parts)


def _write_simulated_mp3(
    path: Path,
    *,
    duration_seconds: int,
    cover_png: bytes | None,
) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.unlink(missing_ok=True)
    if cover_png is not None:
        tags = ID3()
        tags.add(
            APIC(
                encoding=3,
                mime="image/png",
                type=3,
                desc="OpenTunes simulation cover",
                data=cover_png,
            )
        )
        tags.save(path)

    frame_duration = 1152 / 44_100
    frame_count = max(4, int(math.ceil(duration_seconds / frame_duration)))
    # MPEG-1 Layer III, 128 kbps, 44.1 kHz joint stereo frame filled with silence.
    frame = bytes([0xFF, 0xFB, 0x90, 0x64]) + bytes(413)
    with path.open("ab") as output:
        output.write(frame * frame_count)


def _cover_png(index: int) -> bytes:
    palettes = [
        ((245, 63, 81), (255, 211, 67)),
        ((93, 95, 239), (111, 205, 245)),
        ((22, 163, 74), (250, 204, 21)),
        ((236, 72, 153), (56, 189, 248)),
        ((249, 115, 22), (168, 85, 247)),
    ]
    primary, secondary = palettes[(index - 1) % len(palettes)]
    return _striped_png(256, 256, primary, secondary)


def _striped_png(
    width: int,
    height: int,
    primary: tuple[int, int, int],
    secondary: tuple[int, int, int],
) -> bytes:
    rows = []
    for y in range(height):
        row = bytearray([0])
        for x in range(width):
            use_secondary = ((x + y * 2) // 42) % 3 == 1
            color = secondary if use_secondary else primary
            row.extend(color)
        rows.append(bytes(row))
    raw = b"".join(rows)
    return (
        b"\x89PNG\r\n\x1a\n"
        + _png_chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
        + _png_chunk(b"IDAT", zlib.compress(raw, level=9))
        + _png_chunk(b"IEND", b"")
    )


def _png_chunk(kind: bytes, data: bytes) -> bytes:
    return (
        struct.pack(">I", len(data))
        + kind
        + data
        + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)
    )


def _source_audio_path(song_store: SongStore, song_id: str | None) -> Path | None:
    if not song_id:
        return None
    try:
        song = song_store.get_song(song_id)
    except KeyError as exc:
        raise ValueError(f"Source song not found: {song_id}") from exc
    return song_store.local_audio_path(song)


def _format_duration(seconds: int) -> str:
    minutes, remainder = divmod(int(seconds), 60)
    return f"{minutes}:{remainder:02d}"


def _safe_slug(value: str) -> str:
    slug = re.sub(r"[^a-zA-Z0-9]+", "-", value.strip().lower()).strip("-")
    return slug or "simulated-song"
