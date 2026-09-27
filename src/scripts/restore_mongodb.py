"""Restore MongoDB database from an archive dump.

Usage:
    python -m scripts.restore_mongodb
    python -m scripts.restore_mongodb --drop
    python -m scripts.restore_mongodb --archive backups/mongodb/prod/mongodb_01012026.gz
    python -m scripts.restore_mongodb --backup-path D:/backups/mongo/prod --dry-run
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import tempfile
from datetime import datetime
from pathlib import Path
from typing import Optional
from urllib.parse import parse_qsl, quote, urlencode, urlsplit, urlunsplit

from dotenv import load_dotenv
from pymongo.uri_parser import parse_uri


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Restore MongoDB database from mongodump archive via mongorestore.",
    )
    parser.add_argument(
        "--archive",
        default=None,
        help="Optional archive file path override. If omitted, latest mongodb_DDMMYYYY.gz is selected from backup path.",
    )
    parser.add_argument(
        "--backup-path",
        default=os.getenv("BACKUP_PATH_PROD_MONGO"),
        help="Directory with Mongo backups. Defaults to BACKUP_PATH_PROD_MONGO from environment.",
    )
    parser.add_argument(
        "--uri",
        default=os.getenv("MONGODB_URI"),
        help="MongoDB connection string. Defaults to MONGODB_URI from environment.",
    )
    parser.add_argument(
        "--database",
        default=os.getenv("MONGODB_DATABASE"),
        help="Database name to restore. Defaults to MONGODB_DATABASE from environment.",
    )
    parser.add_argument(
        "--mongorestore-bin",
        default="mongorestore",
        help="Path to mongorestore executable (default: mongorestore from PATH).",
    )
    parser.add_argument(
        "--drop",
        action="store_true",
        help="Drop collections before restore (only those present in dump).",
    )
    parser.add_argument(
        "--gzip",
        action="store_true",
        help="Force gzip mode even if archive name does not end with .gz.",
    )
    parser.add_argument(
        "--no-gzip",
        action="store_true",
        help="Disable gzip mode even if archive name ends with .gz.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print command and resolved settings without running restore.",
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
    if explicit_database:
        return explicit_database

    parsed = parse_uri(uri)
    db_name = parsed.get("database")
    if db_name:
        return db_name

    raise ValueError(
        "Database is not set. Provide --database or set MONGODB_DATABASE, "
        "or include database name in URI path.",
    )


def _resolve_gzip_mode(archive_path: Path, force_gzip: bool, no_gzip: bool) -> bool:
    if force_gzip and no_gzip:
        raise ValueError("Use only one of --gzip or --no-gzip.")
    if force_gzip:
        return True
    if no_gzip:
        return False
    return archive_path.name.endswith(".gz")


def _parse_backup_date_from_name(file_name: str) -> Optional[datetime]:
    match = re.fullmatch(r"mongodb_(\d{8})\.gz", file_name)
    if not match:
        return None
    return datetime.strptime(match.group(1), "%d%m%Y")


def _select_latest_archive(backup_path: Path) -> Path:
    if not backup_path.exists():
        raise FileNotFoundError(f"Backup path not found: {backup_path}")
    if not backup_path.is_dir():
        raise ValueError(f"Backup path is not a directory: {backup_path}")

    candidates: list[tuple[datetime, Path]] = []
    for entry in backup_path.iterdir():
        if not entry.is_file():
            continue
        parsed_date = _parse_backup_date_from_name(entry.name)
        if parsed_date is None:
            continue
        candidates.append((parsed_date, entry))

    if not candidates:
        raise FileNotFoundError(
            f"No backup files found in {backup_path}. Expected pattern: mongodb_DDMMYYYY.gz",
        )

    candidates.sort(key=lambda item: (item[0], item[1].name))
    return candidates[-1][1].resolve()


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

    if args.archive:
        archive_path = Path(args.archive).resolve()
    else:
        if not args.backup_path:
            raise ValueError(
                "Backup path is required when --archive is not provided. "
                "Set BACKUP_PATH_PROD_MONGO or pass --backup-path.",
            )
        backup_path = Path(args.backup_path).resolve()
        archive_path = _select_latest_archive(backup_path)

    if not archive_path.exists() and not args.dry_run:
        raise FileNotFoundError(f"Archive file not found: {archive_path}")

    database = _resolve_database(args.uri, args.database)
    use_gzip = _resolve_gzip_mode(archive_path, args.gzip, args.no_gzip)

    mongorestore_path = shutil.which(args.mongorestore_bin)
    if mongorestore_path is None:
        if args.dry_run:
            mongorestore_path = args.mongorestore_bin
        else:
            raise FileNotFoundError(
                f"mongorestore executable not found: '{args.mongorestore_bin}'. "
                "Install MongoDB Database Tools or pass --mongorestore-bin with full path.",
            )

    base_command = [
        mongorestore_path,
        f"--archive={archive_path}",
        f"--nsInclude={database}.*",
    ]
    if use_gzip:
        base_command.append("--gzip")
    if args.drop:
        base_command.append("--drop")

    print(f"[MONGO_RESTORE] db={database} archive={archive_path} drop={args.drop} gzip={use_gzip}")
    print(f"[MONGO_RESTORE] uri={_redact_uri(args.uri)}")
    if not archive_path.exists():
        print(f"[MONGO_RESTORE] warning archive file does not exist yet: {archive_path}")

    if args.dry_run:
        preview = " ".join([base_command[0], "--config=<tempfile>", *base_command[1:]])
        print(f"[MONGO_RESTORE] command={preview}")
        print("[MONGO_RESTORE] dry-run enabled, restore was not executed.")
        return

    config_path: Optional[Path] = None
    try:
        config_path = _write_mongo_tools_config(args.uri)
        command = [mongorestore_path, f"--config={config_path}", *base_command[1:]]
        print(f"[MONGO_RESTORE] command={' '.join(command)}")

        result = subprocess.run(command, check=False)
        if result.returncode != 0:
            raise RuntimeError(f"mongorestore failed with exit code {result.returncode}")

        print("[MONGO_RESTORE] restore completed successfully.")
    finally:
        if config_path is not None:
            try:
                config_path.unlink(missing_ok=True)
            except OSError:
                pass


if __name__ == "__main__":
    main()
