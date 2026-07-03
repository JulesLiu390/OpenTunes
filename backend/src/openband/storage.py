"""Object storage abstraction for song audio and cover assets.

The backend keeps a short-lived local cache of recently ingested MP3s (see
``OPENBAND_LOCAL_CACHE_DAYS``) while Cloudflare R2 holds the authoritative copy.
Audio is served local-first when the cache still has the file, otherwise the
``/audio`` route redirects to a short-lived presigned R2 URL.

When R2 is not configured the backend falls back to pure local storage, which
keeps tests and local development working without any cloud credentials.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Protocol


DEFAULT_LOCAL_CACHE_DAYS = 7
DEFAULT_URL_TTL_SECONDS = 3600

R2_ACCOUNT_ID_ENV = "OPENBAND_R2_ACCOUNT_ID"
R2_ACCESS_KEY_ID_ENV = "OPENBAND_R2_ACCESS_KEY_ID"
R2_SECRET_ACCESS_KEY_ENV = "OPENBAND_R2_SECRET_ACCESS_KEY"
R2_BUCKET_ENV = "OPENBAND_R2_BUCKET"
R2_ENDPOINT_ENV = "OPENBAND_R2_ENDPOINT"
LOCAL_CACHE_DAYS_ENV = "OPENBAND_LOCAL_CACHE_DAYS"
URL_TTL_ENV = "OPENBAND_R2_URL_TTL"


class ObjectStorage(Protocol):
    """Authoritative blob store for audio and cover objects."""

    def upload_file(self, key: str, source: Path, content_type: str) -> None: ...

    def upload_bytes(self, key: str, data: bytes, content_type: str) -> None: ...

    def exists(self, key: str) -> bool: ...

    def delete(self, key: str) -> None: ...

    def presigned_get_url(
        self,
        key: str,
        *,
        expires_in: int = DEFAULT_URL_TTL_SECONDS,
        download_filename: str | None = None,
        content_type: str | None = None,
    ) -> str: ...


class R2Storage:
    """Cloudflare R2 (S3-compatible) object storage backed by boto3."""

    def __init__(
        self,
        *,
        account_id: str,
        access_key_id: str,
        secret_access_key: str,
        bucket: str,
        endpoint_url: str | None = None,
    ) -> None:
        # Imported lazily so the module loads without boto3 when R2 is unused.
        import boto3
        from botocore.config import Config

        self.bucket = bucket
        self._endpoint = endpoint_url or f"https://{account_id}.r2.cloudflarestorage.com"
        self._client = boto3.client(
            "s3",
            endpoint_url=self._endpoint,
            aws_access_key_id=access_key_id,
            aws_secret_access_key=secret_access_key,
            region_name="auto",
            config=Config(signature_version="s3v4", retries={"max_attempts": 3, "mode": "standard"}),
        )

    def upload_file(self, key: str, source: Path, content_type: str) -> None:
        self._client.upload_file(
            str(source),
            self.bucket,
            key,
            ExtraArgs={"ContentType": content_type},
        )

    def upload_bytes(self, key: str, data: bytes, content_type: str) -> None:
        self._client.put_object(Bucket=self.bucket, Key=key, Body=data, ContentType=content_type)

    def exists(self, key: str) -> bool:
        from botocore.exceptions import ClientError

        try:
            self._client.head_object(Bucket=self.bucket, Key=key)
            return True
        except ClientError as exc:
            error_code = exc.response.get("Error", {}).get("Code", "")
            if error_code in {"404", "NoSuchKey", "NotFound"}:
                return False
            raise

    def delete(self, key: str) -> None:
        self._client.delete_object(Bucket=self.bucket, Key=key)

    def presigned_get_url(
        self,
        key: str,
        *,
        expires_in: int = DEFAULT_URL_TTL_SECONDS,
        download_filename: str | None = None,
        content_type: str | None = None,
    ) -> str:
        params: dict[str, str] = {"Bucket": self.bucket, "Key": key}
        if content_type:
            params["ResponseContentType"] = content_type
        if download_filename:
            params["ResponseContentDisposition"] = f'inline; filename="{download_filename}"'
        return self._client.generate_presigned_url(
            "get_object",
            Params=params,
            ExpiresIn=expires_in,
        )


def local_cache_days() -> int:
    raw = os.getenv(LOCAL_CACHE_DAYS_ENV)
    if not raw:
        return DEFAULT_LOCAL_CACHE_DAYS
    try:
        value = int(raw)
    except ValueError:
        return DEFAULT_LOCAL_CACHE_DAYS
    return value if value >= 0 else DEFAULT_LOCAL_CACHE_DAYS


def presigned_url_ttl() -> int:
    raw = os.getenv(URL_TTL_ENV)
    if not raw:
        return DEFAULT_URL_TTL_SECONDS
    try:
        value = int(raw)
    except ValueError:
        return DEFAULT_URL_TTL_SECONDS
    return value if value > 0 else DEFAULT_URL_TTL_SECONDS


def r2_storage_from_env() -> R2Storage | None:
    """Build an R2 client from environment, or ``None`` when not configured."""
    account_id = os.getenv(R2_ACCOUNT_ID_ENV)
    access_key_id = os.getenv(R2_ACCESS_KEY_ID_ENV)
    secret_access_key = os.getenv(R2_SECRET_ACCESS_KEY_ENV)
    bucket = os.getenv(R2_BUCKET_ENV)
    if not (account_id and access_key_id and secret_access_key and bucket):
        return None
    return R2Storage(
        account_id=account_id,
        access_key_id=access_key_id,
        secret_access_key=secret_access_key,
        bucket=bucket,
        endpoint_url=os.getenv(R2_ENDPOINT_ENV),
    )
