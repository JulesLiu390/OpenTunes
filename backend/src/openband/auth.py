from __future__ import annotations

import hashlib
import io
import secrets
import sqlite3
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Annotated, Any, Callable
from urllib.parse import urlencode, urlparse

import qrcode
from fastapi import APIRouter, Depends, Header, HTTPException, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, Field
from qrcode.image.svg import SvgPathImage

from music_taste_rec.style_model import canonicalize_tag


ACCESS_TOKEN_PREFIX = "ob_at_"
REFRESH_TOKEN_PREFIX = "ob_rt_"
INVITE_KEY_PREFIX = "ob_key_"
ACCESS_TOKEN_TTL = timedelta(hours=24)
REFRESH_TOKEN_TTL = timedelta(days=90)
DEFAULT_AUTH_DB_PATH = Path("runtime/openband.sqlite3")

bearer_scheme = HTTPBearer(auto_error=False)


class AuthError(Exception):
    pass


@dataclass(frozen=True)
class AuthUser:
    id: int
    label: str
    created_at: str


class CreateInviteKeyRequest(BaseModel):
    label: str = Field(min_length=1, max_length=120)
    note: str = Field(default="", max_length=500)
    expires_at: str | None = None
    base_url: str | None = Field(default=None, max_length=500)


class InviteKeyResponse(BaseModel):
    id: int
    label: str
    key: str
    qr_payload: str
    qr_svg: str
    expires_at: str | None


class LoginRequest(BaseModel):
    key: str = Field(min_length=16)
    device_name: str = Field(default="", max_length=120)


class RefreshRequest(BaseModel):
    refresh_token: str = Field(min_length=16)


class TokenResponse(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"
    expires_in: int
    refresh_expires_in: int
    user: dict[str, Any]


class LogoutRequest(BaseModel):
    refresh_token: str | None = None


class UpdateMeRequest(BaseModel):
    label: str = Field(min_length=1, max_length=120)


class MusicTagsRequest(BaseModel):
    tags: list[str] = Field(default_factory=list, max_length=200)


class MusicTagsResponse(BaseModel):
    tags: list[str]
    updated_at: str | None = None


class MusicTagCatalogResponse(BaseModel):
    tags: list[str]
    total: int


class AuthStore:
    def __init__(self, db_path: Path = DEFAULT_AUTH_DB_PATH):
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._initialize()

    def create_invite_key(
        self,
        *,
        label: str,
        note: str = "",
        expires_at: str | None = None,
        base_url: str,
    ) -> dict[str, Any]:
        key = _new_secret(INVITE_KEY_PREFIX)
        now = utc_now()
        with self._connect() as conn:
            cursor = conn.execute(
                """
                INSERT INTO invite_keys (label, key_hash, note, created_at, expires_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (label.strip(), hash_secret(key, "invite"), note.strip(), now, expires_at),
            )
            invite_id = int(cursor.lastrowid)
        qr_payload = invite_qr_payload(key=key, base_url=base_url)
        return {
            "id": invite_id,
            "label": label.strip(),
            "key": key,
            "qr_payload": qr_payload,
            "qr_svg": qr_svg(qr_payload),
            "expires_at": expires_at,
        }

    def login_with_invite_key(self, key: str, device_name: str = "") -> dict[str, Any]:
        now = utc_now()
        key_hash = hash_secret(key, "invite")
        with self._connect() as conn:
            invite = conn.execute(
                """
                SELECT * FROM invite_keys
                WHERE key_hash = ?
                """,
                (key_hash,),
            ).fetchone()
            if invite is None:
                raise AuthError("Invalid invite key.")
            if invite["revoked_at"]:
                raise AuthError("Invite key has been revoked.")
            if invite["claimed_at"]:
                raise AuthError("Invite key has already been used.")
            if invite["expires_at"] and invite["expires_at"] <= now:
                raise AuthError("Invite key has expired.")

            bound_user_id = int(invite["claimed_by_user_id"]) if invite["claimed_by_user_id"] else None
            if bound_user_id is not None:
                user_id = bound_user_id
                user = self._get_user(conn, user_id)
                if user is None:
                    raise AuthError("Bound user not found.")
            else:
                cursor = conn.execute(
                    """
                    INSERT INTO users (label, invite_key_id, created_at)
                    VALUES (?, ?, ?)
                    """,
                    (invite["label"], invite["id"], now),
                )
                user_id = int(cursor.lastrowid)
                user = self._get_user(conn, user_id)
            conn.execute(
                """
                UPDATE invite_keys
                SET claimed_at = ?, claimed_by_user_id = ?
                WHERE id = ?
                """,
                (now, user_id, invite["id"]),
            )
            return self._issue_token_pair(conn, user, device_name=device_name)

    def refresh_token(self, refresh_token: str) -> dict[str, Any]:
        now = utc_now()
        token_hash = hash_secret(refresh_token, "refresh")
        with self._connect() as conn:
            row = conn.execute(
                """
                SELECT * FROM refresh_tokens
                WHERE token_hash = ?
                """,
                (token_hash,),
            ).fetchone()
            if row is None or row["revoked_at"]:
                raise AuthError("Invalid refresh token.")
            if row["expires_at"] <= now:
                raise AuthError("Refresh token has expired.")
            user = self._get_user(conn, int(row["user_id"]))
            if user is None:
                raise AuthError("User not found.")
            conn.execute(
                "UPDATE refresh_tokens SET revoked_at = ? WHERE id = ?",
                (now, row["id"]),
            )
            result = self._issue_token_pair(conn, user, device_name=row["device_name"] or "")
            conn.execute(
                "UPDATE refresh_tokens SET replaced_by_id = ? WHERE id = ?",
                (result["refresh_token_id"], row["id"]),
            )
            return result

    def authenticate_access_token(self, access_token: str) -> AuthUser:
        now = utc_now()
        token_hash = hash_secret(access_token, "access")
        with self._connect() as conn:
            row = conn.execute(
                """
                SELECT * FROM access_tokens
                WHERE token_hash = ?
                """,
                (token_hash,),
            ).fetchone()
            if row is None or row["revoked_at"] or row["expires_at"] <= now:
                raise AuthError("Invalid access token.")
            user = self._get_user(conn, int(row["user_id"]))
            if user is None:
                raise AuthError("User not found.")
            conn.execute(
                "UPDATE users SET last_seen_at = ? WHERE id = ?",
                (now, user.id),
            )
            return user

    def revoke_refresh_token(self, refresh_token: str) -> None:
        with self._connect() as conn:
            conn.execute(
                """
                UPDATE refresh_tokens
                SET revoked_at = COALESCE(revoked_at, ?)
                WHERE token_hash = ?
                """,
                (utc_now(), hash_secret(refresh_token, "refresh")),
            )

    def update_user_label(self, user_id: int, label: str) -> AuthUser:
        clean_label = label.strip()
        if not clean_label:
            raise ValueError("Profile name is required.")
        with self._connect() as conn:
            conn.execute(
                """
                UPDATE users
                SET label = ?
                WHERE id = ? AND disabled_at IS NULL
                """,
                (clean_label, user_id),
            )
            user = self._get_user(conn, user_id)
        if user is None:
            raise AuthError("User not found.")
        return user

    def get_music_tags(self, user_id: int) -> MusicTagsResponse:
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT tag, updated_at
                FROM user_music_tag_preferences
                WHERE user_id = ?
                ORDER BY position ASC, tag ASC
                """,
                (user_id,),
            ).fetchall()
        updated_at = rows[0]["updated_at"] if rows else None
        return MusicTagsResponse(tags=[row["tag"] for row in rows], updated_at=updated_at)

    def get_user(self, user_id: int) -> AuthUser | None:
        with self._connect() as conn:
            return self._get_user(conn, user_id)

    def set_music_tags(self, user_id: int, tags: list[str]) -> MusicTagsResponse:
        clean_tags = _clean_tags(tags)
        now = utc_now()
        with self._connect() as conn:
            conn.execute(
                "DELETE FROM user_music_tag_preferences WHERE user_id = ?",
                (user_id,),
            )
            conn.executemany(
                """
                INSERT INTO user_music_tag_preferences (user_id, tag, position, updated_at)
                VALUES (?, ?, ?, ?)
                """,
                [(user_id, tag, index, now) for index, tag in enumerate(clean_tags)],
            )
        return MusicTagsResponse(tags=clean_tags, updated_at=now)

    def _issue_token_pair(
        self,
        conn: sqlite3.Connection,
        user: AuthUser,
        *,
        device_name: str = "",
    ) -> dict[str, Any]:
        now = utc_now()
        access_token = _new_secret(ACCESS_TOKEN_PREFIX)
        refresh_token = _new_secret(REFRESH_TOKEN_PREFIX)
        access_expires_at = format_utc(datetime.now(UTC) + ACCESS_TOKEN_TTL)
        refresh_expires_at = format_utc(datetime.now(UTC) + REFRESH_TOKEN_TTL)
        access_cursor = conn.execute(
            """
            INSERT INTO access_tokens (user_id, token_hash, created_at, expires_at)
            VALUES (?, ?, ?, ?)
            """,
            (user.id, hash_secret(access_token, "access"), now, access_expires_at),
        )
        refresh_cursor = conn.execute(
            """
            INSERT INTO refresh_tokens (user_id, token_hash, device_name, created_at, expires_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (
                user.id,
                hash_secret(refresh_token, "refresh"),
                device_name.strip(),
                now,
                refresh_expires_at,
            ),
        )
        return {
            "access_token": access_token,
            "refresh_token": refresh_token,
            "access_token_id": int(access_cursor.lastrowid),
            "refresh_token_id": int(refresh_cursor.lastrowid),
            "token_type": "bearer",
            "expires_in": int(ACCESS_TOKEN_TTL.total_seconds()),
            "refresh_expires_in": int(REFRESH_TOKEN_TTL.total_seconds()),
            "user": auth_user_dict(user),
        }

    def _get_user(self, conn: sqlite3.Connection, user_id: int) -> AuthUser | None:
        row = conn.execute(
            """
            SELECT * FROM users
            WHERE id = ? AND disabled_at IS NULL
            """,
            (user_id,),
        ).fetchone()
        if row is None:
            return None
        return AuthUser(id=int(row["id"]), label=row["label"], created_at=row["created_at"])

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        return conn

    def _initialize(self) -> None:
        with self._connect() as conn:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS invite_keys (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    label TEXT NOT NULL,
                    key_hash TEXT NOT NULL UNIQUE,
                    note TEXT NOT NULL DEFAULT '',
                    created_at TEXT NOT NULL,
                    expires_at TEXT,
                    revoked_at TEXT,
                    claimed_at TEXT,
                    claimed_by_user_id INTEGER
                );

                CREATE TABLE IF NOT EXISTS users (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    label TEXT NOT NULL,
                    invite_key_id INTEGER,
                    created_at TEXT NOT NULL,
                    last_seen_at TEXT,
                    disabled_at TEXT,
                    FOREIGN KEY(invite_key_id) REFERENCES invite_keys(id)
                );

                CREATE TABLE IF NOT EXISTS access_tokens (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL,
                    token_hash TEXT NOT NULL UNIQUE,
                    created_at TEXT NOT NULL,
                    expires_at TEXT NOT NULL,
                    revoked_at TEXT,
                    FOREIGN KEY(user_id) REFERENCES users(id)
                );

                CREATE TABLE IF NOT EXISTS refresh_tokens (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL,
                    token_hash TEXT NOT NULL UNIQUE,
                    device_name TEXT NOT NULL DEFAULT '',
                    created_at TEXT NOT NULL,
                    expires_at TEXT NOT NULL,
                    revoked_at TEXT,
                    replaced_by_id INTEGER,
                    FOREIGN KEY(user_id) REFERENCES users(id),
                    FOREIGN KEY(replaced_by_id) REFERENCES refresh_tokens(id)
                );

                CREATE TABLE IF NOT EXISTS user_music_tag_preferences (
                    user_id INTEGER NOT NULL,
                    tag TEXT NOT NULL,
                    position INTEGER NOT NULL DEFAULT 0,
                    updated_at TEXT NOT NULL,
                    PRIMARY KEY(user_id, tag),
                    FOREIGN KEY(user_id) REFERENCES users(id)
                );
                """
            )


def create_auth_router(
    store: AuthStore,
    admin_key: str | None = None,
    public_base_url: str | None = None,
) -> APIRouter:
    router = APIRouter(prefix="/v1/auth", tags=["auth"])

    def require_admin(x_admin_key: Annotated[str | None, Header()] = None) -> None:
        if not admin_key:
            raise HTTPException(status_code=503, detail="Admin key is not configured.")
        if not x_admin_key or not secrets.compare_digest(x_admin_key, admin_key):
            raise HTTPException(status_code=403, detail="Invalid admin key.")

    @router.post("/invite-keys", response_model=InviteKeyResponse, dependencies=[Depends(require_admin)])
    def create_invite_key(request_body: CreateInviteKeyRequest, request: Request) -> dict[str, Any]:
        base_url = request_body.base_url or public_base_url or str(request.base_url)
        try:
            normalized_base_url = normalize_api_base_url(base_url)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        return store.create_invite_key(
            label=request_body.label,
            note=request_body.note,
            expires_at=request_body.expires_at,
            base_url=normalized_base_url,
        )

    @router.post("/login", response_model=TokenResponse)
    def login(request: LoginRequest) -> dict[str, Any]:
        try:
            return _token_response(store.login_with_invite_key(request.key, request.device_name))
        except AuthError as exc:
            raise HTTPException(status_code=401, detail=str(exc)) from exc

    @router.post("/refresh", response_model=TokenResponse)
    def refresh(request: RefreshRequest) -> dict[str, Any]:
        try:
            return _token_response(store.refresh_token(request.refresh_token))
        except AuthError as exc:
            raise HTTPException(status_code=401, detail=str(exc)) from exc

    return router


def create_me_router(
    store: AuthStore,
    load_model: Callable[[], Any] | None = None,
) -> APIRouter:
    router = APIRouter(prefix="/v1/me", tags=["me"])
    current_user = current_user_dependency(store)

    @router.get("")
    def me(user: AuthUser = Depends(current_user)) -> dict[str, Any]:
        return {"user": auth_user_dict(user)}

    @router.patch("")
    def update_me(request: UpdateMeRequest, user: AuthUser = Depends(current_user)) -> dict[str, Any]:
        try:
            updated_user = store.update_user_label(user.id, request.label)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        except AuthError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        return {"user": auth_user_dict(updated_user)}

    @router.post("/logout")
    def logout(request: LogoutRequest, _user: AuthUser = Depends(current_user)) -> dict[str, str]:
        if request.refresh_token:
            store.revoke_refresh_token(request.refresh_token)
        return {"status": "ok"}

    @router.get("/music-tags", response_model=MusicTagsResponse)
    def get_music_tags(user: AuthUser = Depends(current_user)) -> MusicTagsResponse:
        return store.get_music_tags(user.id)

    @router.put("/music-tags", response_model=MusicTagsResponse)
    def set_music_tags(
        request: MusicTagsRequest,
        user: AuthUser = Depends(current_user),
    ) -> MusicTagsResponse:
        return store.set_music_tags(user.id, request.tags)

    @router.get("/music-tags/catalog", response_model=MusicTagCatalogResponse)
    def get_music_tag_catalog(_user: AuthUser = Depends(current_user)) -> MusicTagCatalogResponse:
        if load_model is None:
            raise HTTPException(status_code=503, detail="Music tag model is not configured.")
        model = load_model()
        tags = sorted(model.tags)
        return MusicTagCatalogResponse(tags=tags, total=len(tags))

    return router


def current_user_dependency(store: AuthStore):
    def current_user(
        credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer_scheme)],
    ) -> AuthUser:
        if credentials is None or credentials.scheme.lower() != "bearer":
            raise HTTPException(status_code=401, detail="Missing bearer token.")
        try:
            return store.authenticate_access_token(credentials.credentials)
        except AuthError as exc:
            raise HTTPException(status_code=401, detail=str(exc)) from exc

    return current_user


def auth_user_dict(user: AuthUser) -> dict[str, Any]:
    return {"id": user.id, "label": user.label, "created_at": user.created_at}


def hash_secret(value: str, purpose: str) -> str:
    return hashlib.sha256(f"{purpose}:{value}".encode("utf-8")).hexdigest()


def utc_now() -> str:
    return format_utc(datetime.now(UTC))


def format_utc(value: datetime) -> str:
    return value.astimezone(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")


def _new_secret(prefix: str) -> str:
    return f"{prefix}{secrets.token_urlsafe(32)}"


def invite_qr_payload(*, key: str, base_url: str) -> str:
    params = {
        "key": key,
        "base_url": normalize_api_base_url(base_url),
    }
    return f"openband://login?{urlencode(params)}"


def normalize_api_base_url(value: str) -> str:
    clean_value = value.strip().rstrip("/")
    if not clean_value:
        raise ValueError("API base URL must be configured before creating invite QR codes.")
    parsed = urlparse(clean_value)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError("API base URL must start with http:// or https://.")
    return clean_value


def qr_svg(payload: str) -> str:
    image = qrcode.make(payload, image_factory=SvgPathImage)
    buffer = io.BytesIO()
    image.save(buffer)
    return buffer.getvalue().decode("utf-8")


def _clean_tags(tags: list[str]) -> list[str]:
    result: list[str] = []
    for tag in tags:
        clean = canonicalize_tag(tag)
        if clean and clean not in result:
            result.append(clean)
    return result


def _token_response(result: dict[str, Any]) -> dict[str, Any]:
    return {
        "access_token": result["access_token"],
        "refresh_token": result["refresh_token"],
        "token_type": result["token_type"],
        "expires_in": result["expires_in"],
        "refresh_expires_in": result["refresh_expires_in"],
        "user": result["user"],
    }
