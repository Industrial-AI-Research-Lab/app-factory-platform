"""Create MongoDB backups using a MongoDB connection string.

Usage:
    python -m scripts.backup_mongodb
    python -m scripts.backup_mongodb --database synaps
    python -m scripts.backup_mongodb --uri "mongodb://user:pass@host:27017/synaps?authSource=admin"
    python -m scripts.backup_mongodb --backup-path D:/backups
    python -m scripts.backup_mongodb --dry-run
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import tempfile
from datetime import UTC, datetime
from pathlib import Path
from typing import Optional
from urllib.parse import parse_qsl, quote, urlencode, urlsplit, urlunsplit

from dotenv import load_dotenv
from pymongo.uri_parser import parse_uri


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Backup MongoDB database to an archive file via mongodump.",
    )
    parser.add_argument(
        "--uri",
        default=os.getenv("MONGODB_URI"),
        help="MongoDB connection string. Defaults to MONGODB_URI from environment.",
    )
    parser.add_argument(
        "--database",
        default=os.getenv("MONGODB_DATABASE"),
        help="Database name. Defaults to MONGODB_DATABASE from environment.",
    )
    parser.add_argument(
        "--backup-path",
        default=os.getenv("BACKUP_PATH_PROD_MONGO"),
        help="Base backup path. Defaults to BACKUP_PATH_PROD_MONGO from environment.",
    )
    parser.add_argument(
        "--mongodump-bin",
        default="mongodump",
        help="Path to mongodump executable (default: mongodump from PATH).",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print command and target path without running mongodump.",
    )
    return parser.parse_args()


def _redact_uri(uri: str) -> str:
    parts = urlsplit(uri)
    if "@" not in parts.netloc:
        return uri

    creds, host = parts.netloc.rsplit("@", 1)
    if ":" in creds:
        user, _ = creds.split(":", 1)
        safe_user = quote(user, safe="")
        safe_netloc = f"{safe_user}:***@{host}"
    else:
        safe_netloc = f"{creds}@{host}"

    if parts.query:
        safe_query = urlencode(parse_qsl(parts.query, keep_blank_values=True))
    else:
        safe_query = ""

    return urlunsplit((parts.scheme, safe_netloc, parts.path, safe_query, parts.fragment))


def _resolve_database(uri: str, explicit_database: Optional[str]) -> str:
    parsed = parse_uri(uri)
    uri_database = parsed.get("database")

    if explicit_database and uri_database and explicit_database != uri_database:
        raise ValueError(
            "Database mismatch: URI contains "
            f"'{uri_database}', but --database/MONGODB_DATABASE is '{explicit_database}'. "
            "Use the same database in both places.",
        )

    if explicit_database:
        return explicit_database

    if uri_database:
        return uri_database

    raise ValueError(
        "Database is not set. Provide --database or set MONGODB_DATABASE, "
        "or include database name in URI path.",
    )


def _build_backup_path(backup_root: Path) -> tuple[Path, str]:
    date_value = datetime.now(UTC).strftime("%d%m%Y")
    backup_path = backup_root / f"mongodb_{date_value}.gz"
    return backup_path, date_value


def _write_mongo_tools_config(uri: str) -> Path:
    """Write a temporary MongoDB tools config file with strict permissions."""
    fd, temp_path = tempfile.mkstemp(prefix="mongo-tools-", suffix=".yaml")
    path = Path(temp_path)
    try:
        os.chmod(path, 0o600)
    except OSError:
        # Best-effort on platforms/filesystems where chmod is limited.
        pass
    with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as stream:
        stream.write(f"uri: {json.dumps(uri)}\n")
    return path


def main() -> None:
    load_dotenv()
    load_dotenv(Path(__file__).resolve().parents[1] / ".env")
    args = _parse_args()

    if not args.uri:
        raise ValueError("MongoDB URI is required. Set MONGODB_URI or pass --uri.")

    database = _resolve_database(args.uri, args.database)
    if not args.backup_path:
        raise ValueError("Backup path is required. Set BACKUP_PATH_PROD_MONGO or pass --backup-path.")

    backup_root = Path(args.backup_path).resolve()
    backup_path, date_value = _build_backup_path(backup_root)
    backup_path.parent.mkdir(parents=True, exist_ok=True)

    mongodump_path = shutil.which(args.mongodump_bin)
    if mongodump_path is None:
        if args.dry_run:
            mongodump_path = args.mongodump_bin
        else:
            raise FileNotFoundError(
                f"mongodump executable not found: '{args.mongodump_bin}'. "
                "Install MongoDB Database Tools or pass --mongodump-bin with full path.",
            )

    base_command = [
        mongodump_path,
        f"--db={database}",
        f"--archive={backup_path}",
        "--gzip",
    ]

    print(f"[MONGO_BACKUP] db={database} output={backup_path}")
    print(f"[MONGO_BACKUP] date={date_value} format=DDMMYYYY")
    print(f"[MONGO_BACKUP] uri={_redact_uri(args.uri)}")

    if args.dry_run:
        preview = " ".join([base_command[0], "--config=<tempfile>", *base_command[1:]])
        print(f"[MONGO_BACKUP] command={preview}")
        print("[MONGO_BACKUP] dry-run enabled, backup was not executed.")
        return

    config_path: Optional[Path] = None
    try:
        config_path = _write_mongo_tools_config(args.uri)
        command = [mongodump_path, f"--config={config_path}", *base_command[1:]]
        print(f"[MONGO_BACKUP] command={' '.join(command)}")

        result = subprocess.run(command, check=False)
        if result.returncode != 0:
            raise RuntimeError(f"mongodump failed with exit code {result.returncode}")

        print("[MONGO_BACKUP] backup completed successfully.")
    finally:
        if config_path is not None:
            try:
                config_path.unlink(missing_ok=True)
            except OSError:
                pass


if __name__ == "__main__":
    main()
