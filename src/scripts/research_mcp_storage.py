from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import sys
from collections.abc import Callable
from typing import TextIO
from urllib.parse import urlsplit

_MEDIA_TYPE_PATTERN = re.compile(
    r"^[!#$%&'*+\-.^_`|~0-9A-Za-z]+/[!#$%&'*+\-.^_`|~0-9A-Za-z]+$"
)


def _object_key(value: str) -> str:
    parts = value.split("/")
    if (
        len(parts) < 3
        or parts[0] != "research-mcp"
        or any(part in {"", ".", ".."} for part in parts)
        or "\\" in value
        or any(ord(character) < 32 for character in value)
        or len(value.encode("utf-8")) > 1024
    ):
        raise argparse.ArgumentTypeError(
            "object key must be a normalized path under research-mcp/<run-id>/"
        )
    return value


def _ttl(value: str) -> int:
    try:
        ttl = int(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("TTL must be an integer") from exc
    if not 60 <= ttl <= 3600:
        raise argparse.ArgumentTypeError("TTL must be between 60 and 3600 seconds")
    return ttl


def _endpoint(value: str) -> str:
    try:
        parsed = urlsplit(value)
        port = parsed.port
    except ValueError as exc:
        raise argparse.ArgumentTypeError(
            "endpoint must be a valid HTTP origin"
        ) from exc
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path
        or parsed.query
        or parsed.fragment
        or port == 0
    ):
        raise argparse.ArgumentTypeError("endpoint must be a valid HTTP origin")
    return value


def _content_type(value: str) -> str:
    content_type = value.strip()
    if not _MEDIA_TYPE_PATTERN.fullmatch(content_type) or len(content_type) > 255:
        raise argparse.ArgumentTypeError("content type must be a valid media type")
    return content_type


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Issue local Research MCP object-storage URLs and inspect objects."
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    put_parser = subparsers.add_parser("presign-put")
    put_parser.add_argument("object_key", type=_object_key)
    put_parser.add_argument("--content-type", required=True, type=_content_type)
    put_parser.add_argument("--ttl", type=_ttl, default=900)
    put_parser.add_argument("--endpoint", type=_endpoint)

    get_parser = subparsers.add_parser("presign-get")
    get_parser.add_argument("object_key", type=_object_key)
    get_parser.add_argument("--ttl", type=_ttl, default=900)
    get_parser.add_argument("--endpoint", type=_endpoint)

    head_parser = subparsers.add_parser("head")
    head_parser.add_argument("object_key", type=_object_key)

    return parser.parse_args(argv)


async def run_command(args, store, stdout: TextIO) -> int:
    if args.command == "presign-put":
        url = await store.presign_put(
            args.object_key,
            args.ttl,
            content_type=args.content_type,
        )
    elif args.command == "presign-get":
        url = await store.presign_get(args.object_key, args.ttl)
    elif args.command == "head":
        metadata = await store.head_blob(args.object_key)
        if metadata is None:
            raise ValueError(f"object not found: {args.object_key}")
        last_modified = metadata.get("LastModified")
        stdout.write(
            json.dumps(
                {
                    "content_type": metadata.get("ContentType"),
                    "etag": str(metadata.get("ETag") or "").strip('"'),
                    "last_modified": (
                        last_modified.isoformat()
                        if hasattr(last_modified, "isoformat")
                        else None
                    ),
                    "object_key": args.object_key,
                    "size_bytes": metadata.get("ContentLength"),
                },
                ensure_ascii=False,
                sort_keys=True,
            )
            + "\n"
        )
        return 0
    else:
        raise ValueError(f"unsupported command: {args.command}")

    stdout.write(f"{url}\n")
    return 0


def _store_from_env():
    from storage.file_blob_store import FileBlobStore

    return FileBlobStore.from_env()


def main(
    argv: list[str] | None = None,
    *,
    store_factory: Callable | None = None,
    stdout: TextIO | None = None,
    stderr: TextIO | None = None,
) -> int:
    args = parse_args(argv)
    output = stdout or sys.stdout
    errors = stderr or sys.stderr
    factory = store_factory or _store_from_env
    endpoint = getattr(args, "endpoint", None)
    original_endpoint = os.environ.get("ARCHIVE_S3_ENDPOINT")

    if endpoint is not None:
        os.environ["ARCHIVE_S3_ENDPOINT"] = endpoint
    try:
        store = factory()
    finally:
        if endpoint is not None:
            if original_endpoint is None:
                os.environ.pop("ARCHIVE_S3_ENDPOINT", None)
            else:
                os.environ["ARCHIVE_S3_ENDPOINT"] = original_endpoint

    if not store.is_configured():
        errors.write("object storage is not configured\n")
        return 2

    try:
        return asyncio.run(run_command(args, store, output))
    except Exception as exc:
        errors.write(f"storage command failed: {exc}\n")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
