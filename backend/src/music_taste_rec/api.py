from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
from fastapi import Depends, FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from openband.auth import (
    DEFAULT_AUTH_DB_PATH,
    AuthStore,
    AuthUser,
    create_auth_router,
    create_me_router,
    current_user_dependency,
)
from openband.daily import (
    DailyGenerationService,
    DailyGenerator,
    DailyStore,
    create_daily_router,
)
from openband.dev_simulation import create_dev_simulation_router
from openband.prompt_generation import cli as prompt_cli
from openband.prompt_generation.profile_service import (
    GeneratedMusicProfile,
    generate_music_profile,
)
from openband.songs import (
    DEFAULT_SONG_STORAGE_ROOT,
    SONG_STORAGE_ROOT_ENV,
    SongStore,
    create_playlist_router,
    create_song_router,
)
from openband.storage import (
    local_cache_days,
    presigned_url_ttl,
    r2_storage_from_env,
)
from pydantic import BaseModel, Field

from music_taste_rec.style_model import StyleAssociationModel, parse_style_tags


DEFAULT_MODEL_PATH = Path("models/style_model.joblib")
MODEL_PATH_ENV = "MUSIC_REC_MODEL_PATH"
AUTH_DB_PATH_ENV = "OPENBAND_AUTH_DB_PATH"
ADMIN_KEY_ENV = "OPENBAND_ADMIN_KEY"
PUBLIC_BASE_URL_ENV = "OPENBAND_PUBLIC_BASE_URL"
PROFILE_RESPONSES_URL_ENV = "RESPONSES_URL"
PROFILE_RESPONSES_MODEL_ENV = "RESPONSES_MODEL"
PROFILE_API_KEY_ENV = "OPENAI_API_KEY"
DEFAULT_RESPONSES_URL = "http://127.0.0.1:8080/v1/responses"
DEFAULT_RESPONSES_MODEL = "gpt-5.5"


def _load_local_prompt_settings() -> None:
    """Load local prompt/Suno settings for FastAPI without overriding process env."""
    prompt_cli.load_dotenv(prompt_cli.BACKEND_ROOT / ".env")
    prompt_cli.load_dotenv(prompt_cli.BACKEND_ROOT.parent / ".env")
    prompt_cli.load_dotenv(prompt_cli.BACKEND_ROOT.parent / "suno" / ".env")


class SongInput(BaseModel):
    track_id: str
    name: str = ""
    artist: str = "AI"
    genre: str = ""
    tags: str | list[str] = Field(default_factory=list)


class ProfileRequest(BaseModel):
    user_tags: str | list[str] = Field(default_factory=list)
    liked_songs: list[SongInput] = Field(default_factory=list)
    top_n: int = Field(default=20, ge=1, le=100)
    min_user_count: int = Field(default=0, ge=0)


class ScoreRequest(BaseModel):
    user_tags: str | list[str] = Field(default_factory=list)
    song_tags: str | list[str] = Field(default_factory=list)


class RankRequest(BaseModel):
    user_tags: str | list[str] = Field(default_factory=list)
    songs: list[SongInput] = Field(min_length=1)
    top_n: int = Field(default=20, ge=1, le=500)


class MusicProfileRequest(BaseModel):
    favorite_bands: str = Field(default="", max_length=1000)
    favorite_songs: str = Field(default="", max_length=1000)
    favorite_anime: str = Field(default="", max_length=1000)
    favorite_movies: str = Field(default="", max_length=1000)
    notes: str = Field(default="", max_length=2000)
    profile_input: str = Field(default="", max_length=4000)
    save: bool = True


class MusicProfileTagMeaning(BaseModel):
    tag: str
    meaning: str


class MusicProfileResponse(BaseModel):
    input_text: str
    reference_summary: str
    source_notes: str
    tags: list[str]
    raw_tags: list[str]
    known_tags: list[str]
    corrected_tags: list[dict[str, str]]
    unknown_tags: list[str]
    tag_meanings: list[MusicProfileTagMeaning] = Field(default_factory=list)
    updated_at: str | None = None


def create_app(
    model_path: Path | None = None,
    auth_db_path: Path | None = None,
    song_storage_root: Path | None = None,
    admin_key: str | None = None,
    require_auth: bool = True,
    daily_generator: DailyGenerator | None = None,
) -> FastAPI:
    _load_local_prompt_settings()

    app = FastAPI(
        title="Music Taste Recommendation API",
        version="0.1.0",
        description="Style/tag profile and recommendation API for AI music catalogs.",
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.state.model_path = Path(model_path or os.getenv(MODEL_PATH_ENV, DEFAULT_MODEL_PATH))
    configured_auth_db_path = Path(auth_db_path or os.getenv(AUTH_DB_PATH_ENV, DEFAULT_AUTH_DB_PATH))
    app.state.auth_store = AuthStore(configured_auth_db_path)
    app.state.song_store = SongStore(
        db_path=configured_auth_db_path,
        storage_root=Path(song_storage_root or os.getenv(SONG_STORAGE_ROOT_ENV, DEFAULT_SONG_STORAGE_ROOT)),
        object_storage=r2_storage_from_env(),
        cache_days=local_cache_days(),
        url_ttl=presigned_url_ttl(),
    )
    app.state.daily_store = DailyStore(configured_auth_db_path)
    app.state.daily_generator = daily_generator or DailyGenerationService(
        model_path=app.state.model_path,
        responses_url=os.getenv(PROFILE_RESPONSES_URL_ENV, DEFAULT_RESPONSES_URL),
        responses_model=os.getenv(PROFILE_RESPONSES_MODEL_ENV, DEFAULT_RESPONSES_MODEL),
        api_key_env=PROFILE_API_KEY_ENV,
    )
    app.state.auth_db_path = app.state.auth_store.db_path
    configured_admin_key = admin_key if admin_key is not None else os.getenv(ADMIN_KEY_ENV)

    def load_model_for_app() -> StyleAssociationModel:
        return _load_model(app.state.model_path)

    app.include_router(
        create_auth_router(
            app.state.auth_store,
            configured_admin_key,
            public_base_url=os.getenv(PUBLIC_BASE_URL_ENV),
        )
    )
    app.include_router(create_me_router(app.state.auth_store, load_model=load_model_for_app))
    app.include_router(
        create_song_router(
            store=app.state.song_store,
            auth_store=app.state.auth_store,
            admin_key=configured_admin_key,
            require_auth=require_auth,
        )
    )
    app.include_router(
        create_playlist_router(
            store=app.state.song_store,
            auth_store=app.state.auth_store,
            require_auth=require_auth,
        )
    )
    app.include_router(
        create_daily_router(
            daily_store=app.state.daily_store,
            song_store=app.state.song_store,
            auth_store=app.state.auth_store,
            require_auth=require_auth,
        )
    )
    app.include_router(
        create_dev_simulation_router(
            auth_store=app.state.auth_store,
            daily_store=app.state.daily_store,
            song_store=app.state.song_store,
            admin_key=configured_admin_key,
        )
    )
    current_user = (
        current_user_dependency(app.state.auth_store)
        if require_auth
        else _anonymous_user
    )

    @app.get("/health")
    def health(model: StyleAssociationModel = Depends(load_model_for_app)) -> dict[str, Any]:
        return {
            "status": "ok",
            "model_path": str(app.state.model_path),
            "tags": len(model.tags),
            "embedding_dimensions": int(model.tag_embeddings.shape[1]),
            "model_config": model.config,
        }

    @app.get("/v1/tags/{tag}/similar")
    def similar_tags(
        tag: str,
        top_n: int = Query(default=20, ge=1, le=100),
        min_user_count: int = Query(default=0, ge=0),
        _user: AuthUser | None = Depends(current_user),
        model: StyleAssociationModel = Depends(load_model_for_app),
    ) -> dict[str, Any]:
        try:
            related = model.similar_tags(tag, top_n=top_n, min_user_count=min_user_count)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        return {"tag": tag, "similar_tags": _records(related)}

    @app.post("/v1/profile")
    def profile(
        request: ProfileRequest,
        _user: AuthUser | None = Depends(current_user),
        model: StyleAssociationModel = Depends(load_model_for_app),
    ) -> dict[str, Any]:
        tags = _profile_tags(request)
        known = model.known_tags(tags)
        unknown = model.unknown_tags(tags)
        if not known:
            raise HTTPException(status_code=422, detail="No known user tags in request.")
        expanded = model.expand_tags(
            known,
            top_n=request.top_n,
            min_user_count=request.min_user_count,
        )
        vector = model.embed_tags(known)
        return {
            "known_user_tags": known,
            "unknown_user_tags": unknown,
            "expanded_tags": _records(expanded),
            "embedding_dimensions": int(vector.shape[0]),
        }

    @app.post("/v1/score")
    def score(
        request: ScoreRequest,
        _user: AuthUser | None = Depends(current_user),
        model: StyleAssociationModel = Depends(load_model_for_app),
    ) -> dict[str, Any]:
        result = model.score_tags(user_tags=request.user_tags, song_tags=request.song_tags)
        return _jsonable(result)

    @app.post("/v1/rank")
    def rank(
        request: RankRequest,
        _user: AuthUser | None = Depends(current_user),
        model: StyleAssociationModel = Depends(load_model_for_app),
    ) -> dict[str, Any]:
        if not request.songs:
            raise HTTPException(status_code=422, detail="songs must not be empty.")
        songs = _songs_frame(request.songs)
        try:
            ranked = model.rank_songs(songs=songs, user_tags=request.user_tags, top_n=request.top_n)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        return {
            "ranked_songs": _records(ranked),
            "known_user_tags": model.known_tags(request.user_tags),
            "unknown_user_tags": model.unknown_tags(request.user_tags),
        }

    @app.post("/v1/me/music-tags/profile", response_model=MusicProfileResponse)
    def generate_music_tags_profile(
        request: MusicProfileRequest,
        user: AuthUser = Depends(current_user),
        style_model: StyleAssociationModel = Depends(load_model_for_app),
    ) -> MusicProfileResponse:
        input_text = _music_profile_input(request)
        if not input_text:
            raise HTTPException(status_code=422, detail="At least one favorite field is required.")

        api_key = os.getenv(PROFILE_API_KEY_ENV)
        if not api_key:
            raise HTTPException(status_code=503, detail=f"Missing API key. Set {PROFILE_API_KEY_ENV}.")

        try:
            profile = generate_music_profile(
                input_text=input_text,
                api_key=api_key,
                url=os.getenv(PROFILE_RESPONSES_URL_ENV, DEFAULT_RESPONSES_URL),
                model=os.getenv(PROFILE_RESPONSES_MODEL_ENV, DEFAULT_RESPONSES_MODEL),
                allowed_tags=[str(tag) for tag in style_model.tags],
            )
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        except SystemExit as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc

        updated_at = None
        tags = profile.tags
        if request.save:
            saved = app.state.auth_store.set_music_tags(user.id, tags)
            updated_at = saved.updated_at
            tags = saved.tags
        return _music_profile_response(profile, tags=tags, updated_at=updated_at)

    return app


def get_model() -> StyleAssociationModel:
    model_path = Path(os.getenv(MODEL_PATH_ENV, DEFAULT_MODEL_PATH))
    return _load_model(model_path)


def _anonymous_user() -> None:
    return None


@lru_cache(maxsize=8)
def _load_model(model_path: Path) -> StyleAssociationModel:
    if not model_path.exists():
        raise HTTPException(status_code=503, detail=f"Model not found: {model_path}")
    return StyleAssociationModel.load(model_path)


def _profile_tags(request: ProfileRequest) -> list[str]:
    tags = parse_style_tags(request.user_tags)
    for song in request.liked_songs:
        tags.extend(parse_style_tags(song.tags))
        if song.genre:
            tags.extend(parse_style_tags(song.genre))
    return list(dict.fromkeys(tags))


def _music_profile_input(request: MusicProfileRequest) -> str:
    if request.profile_input.strip():
        return request.profile_input.strip()

    pieces = [
        ("喜欢的乐队或音乐人", request.favorite_bands),
        ("喜欢的歌曲", request.favorite_songs),
        ("喜欢的动漫或动画", request.favorite_anime),
        ("喜欢的电影或影视作品", request.favorite_movies),
        ("补充偏好", request.notes),
    ]
    lines = [f"{label}: {value.strip()}" for label, value in pieces if value.strip()]
    return "\n".join(lines).strip()


def _music_profile_response(
    profile: GeneratedMusicProfile,
    *,
    tags: list[str],
    updated_at: str | None,
) -> MusicProfileResponse:
    return MusicProfileResponse(
        input_text=profile.input_text,
        reference_summary=profile.reference_summary,
        source_notes=profile.source_notes,
        tags=tags,
        raw_tags=profile.raw_tags,
        known_tags=profile.known_tags,
        corrected_tags=profile.corrected_tags,
        unknown_tags=profile.unknown_tags,
        tag_meanings=_profile_tag_meanings(profile, tags),
        updated_at=updated_at,
    )


def _profile_tag_meanings(
    profile: GeneratedMusicProfile,
    tags: list[str],
) -> list[MusicProfileTagMeaning]:
    meanings_by_key = {
        prompt_cli.canonical_tag(item.get("tag", "")): item.get("meaning", "")
        for item in profile.tag_meanings
        if item.get("tag") and item.get("meaning")
    }
    tag_meanings: list[MusicProfileTagMeaning] = []
    for tag in tags:
        key = prompt_cli.canonical_tag(tag)
        meaning = meanings_by_key.get(key)
        if meaning:
            tag_meanings.append(MusicProfileTagMeaning(tag=tag, meaning=meaning))
    return tag_meanings


def _songs_frame(songs: list[SongInput]) -> pd.DataFrame:
    return pd.DataFrame([song.model_dump() for song in songs])


def _records(frame: pd.DataFrame) -> list[dict[str, Any]]:
    return [_jsonable(row) for row in frame.to_dict(orient="records")]


def _jsonable(value: Any) -> Any:
    if isinstance(value, dict):
        return {key: _jsonable(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_jsonable(item) for item in value]
    if isinstance(value, np.generic):
        return value.item()
    if isinstance(value, float) and np.isnan(value):
        return None
    return value


app = create_app()
