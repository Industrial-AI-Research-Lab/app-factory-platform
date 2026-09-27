"""Migrate audit timestamp strings to MongoDB Date values.

Usage:
    python -m scripts.migrate_audit_timestamps_to_dates
    python -m scripts.migrate_audit_timestamps_to_dates --apply
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import os
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Iterable

from motor.motor_asyncio import AsyncIOMotorClient
from pymongo.errors import OperationFailure, ServerSelectionTimeoutError

logger = logging.getLogger(__name__)


TIMESTAMP_FIELDS_BY_COLLECTION: dict[str, tuple[str, ...]] = {
    "agent_configurations": ("created_at", "updated_at"),
    "workflow_definitions": ("created_at", "updated_at"),
    "tool_configurations": ("created_at", "updated_at"),
    "run_configurations": ("created_at", "updated_at"),
    "users": ("created_at", "updated_at"),
    "tenants": ("created_at", "updated_at"),
    "tenant_settings": ("created_at", "updated_at"),
    "projects": ("created_at", "updated_at", "context.created_at", "context.updated_at"),
    "tasks": ("created_at", "updated_at"),
    "snapshots": ("created_at", "updated_at"),
    "container_logs": ("created_at", "updated_at"),
    "deployments": ("created_at", "updated_at"),
    "events": ("created_at", "updated_at"),
    "runs": ("created_at",),
    "file_artifacts": ("created_at", "updated_at"),
}


@dataclass
class TimestampMigrationResult:
    collection_name: str
    matched: int = 0
    convertible: int = 0
    modified: int = 0
    failed: int = 0
    failures: list[dict[str, str]] = field(default_factory=list)


def _load_dotenv_if_available() -> None:
    try:
        from dotenv import load_dotenv
    except ImportError:
        return
    load_dotenv()


def parse_audit_timestamp(value: Any) -> datetime | None:
    """Parse an ISO timestamp into UTC-aware datetime, or None when invalid."""
    if isinstance(value, datetime):
        if value.tzinfo is None:
            return value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc)
    if not isinstance(value, str):
        return None

    raw = value.strip()
    if not raw:
        return None

    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return None

    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _get_dotted(doc: dict[str, Any], path: str) -> Any:
    current: Any = doc
    for part in path.split("."):
        if not isinstance(current, dict) or part not in current:
            return None
        current = current[part]
    return current


def _build_string_type_query(fields: Iterable[str]) -> dict[str, Any]:
    clauses = [{field_name: {"$type": "string"}} for field_name in fields]
    return {"$or": clauses} if clauses else {}


async def _iter_cursor(cursor):
    if hasattr(cursor, "__aiter__"):
        async for doc in cursor:
            yield doc
        return

    docs = await cursor.to_list(length=None)
    for doc in docs:
        yield doc


async def migrate_collection_timestamps(
    *,
    collection,
    collection_name: str,
    fields: tuple[str, ...],
    apply: bool,
) -> TimestampMigrationResult:
    """Convert string timestamp fields in one collection.

    Dry-run mode reports what would be converted and which values cannot be
    parsed. Apply mode updates only parseable fields and leaves bad values for
    manual follow-up.
    """
    result = TimestampMigrationResult(collection_name=collection_name)
    query = _build_string_type_query(fields)

    async for doc in _iter_cursor(collection.find(query)):
        updates: dict[str, datetime] = {}
        doc_had_string = False

        for field_name in fields:
            raw_value = _get_dotted(doc, field_name)
            if not isinstance(raw_value, str):
                continue

            doc_had_string = True
            parsed = parse_audit_timestamp(raw_value)
            if parsed is None:
                result.failed += 1
                result.failures.append(
                    {
                        "_id": str(doc.get("_id")),
                        "field": field_name,
                        "value": raw_value,
                    }
                )
                continue

            updates[field_name] = parsed
            result.convertible += 1

        if not doc_had_string:
            continue

        result.matched += 1
        if not apply or not updates:
            continue

        update_result = await collection.update_one(
            {"_id": doc["_id"]},
            {"$set": updates},
        )
        result.modified += int(getattr(update_result, "modified_count", 0))

    return result


async def migrate_database_timestamps(db, *, apply: bool) -> list[TimestampMigrationResult]:
    results: list[TimestampMigrationResult] = []
    for collection_name, fields in TIMESTAMP_FIELDS_BY_COLLECTION.items():
        result = await migrate_collection_timestamps(
            collection=db[collection_name],
            collection_name=collection_name,
            fields=fields,
            apply=apply,
        )
        results.append(result)
    return results


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Convert audit timestamp strings to MongoDB Date values.",
    )
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Apply changes. If omitted, script runs in dry-run mode.",
    )
    return parser.parse_args()


def _log_result(result: TimestampMigrationResult) -> None:
    logger.info(
        "[TIMESTAMP_MIGRATION] collection=%s matched=%d convertible=%d modified=%d failed=%d",
        result.collection_name,
        result.matched,
        result.convertible,
        result.modified,
        result.failed,
    )
    for failure in result.failures[:20]:
        logger.warning(
            "[TIMESTAMP_MIGRATION] collection=%s _id=%s field=%s value=%r - parse failed",
            result.collection_name,
            failure["_id"],
            failure["field"],
            failure["value"],
        )
    if len(result.failures) > 20:
        logger.warning(
            "[TIMESTAMP_MIGRATION] collection=%s failures_truncated=%d",
            result.collection_name,
            len(result.failures) - 20,
        )


async def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    _load_dotenv_if_available()
    args = _parse_args()

    mongodb_uri = os.getenv("MONGODB_URI", "mongodb://localhost:27017")
    database_name = os.getenv("MONGODB_DATABASE", "AppFactory")
    client = AsyncIOMotorClient(mongodb_uri, serverSelectionTimeoutMS=5000)
    db = client[database_name]
    mode = "APPLY" if args.apply else "DRY-RUN"
    logger.info("[TIMESTAMP_MIGRATION] mode=%s db=%s", mode, database_name)

    try:
        results = await migrate_database_timestamps(db, apply=args.apply)
        for result in results:
            _log_result(result)

        total_convertible = sum(result.convertible for result in results)
        total_modified = sum(result.modified for result in results)
        total_failed = sum(result.failed for result in results)
        logger.info(
            "[TIMESTAMP_MIGRATION] total_convertible=%d total_modified=%d total_failed=%d",
            total_convertible,
            total_modified,
            total_failed,
        )
        if not args.apply:
            logger.info("[TIMESTAMP_MIGRATION] Dry-run complete. Re-run with --apply to persist changes.")
    except ServerSelectionTimeoutError:
        logger.error("[TIMESTAMP_MIGRATION] MongoDB is unreachable. Check MONGODB_URI/network/VPN.")
        raise
    except OperationFailure:
        logger.error("[TIMESTAMP_MIGRATION] MongoDB authorization failed. Check credentials/roles.")
        raise
    finally:
        client.close()


if __name__ == "__main__":
    asyncio.run(main())
