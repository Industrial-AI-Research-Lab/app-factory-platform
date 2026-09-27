"""
Backfill tenant_id for legacy projects that do not have this field.

By default, runs in dry-run mode and prints how many projects would be updated.
Use --apply to execute update_many.

Usage:
    python -m scripts.backfill_project_tenant_id
    python -m scripts.backfill_project_tenant_id --apply
    python -m scripts.backfill_project_tenant_id --apply --tenant-id "__default__"
"""

from __future__ import annotations

import argparse
import asyncio
import os

from dotenv import load_dotenv
from motor.motor_asyncio import AsyncIOMotorClient
from pymongo.errors import OperationFailure, ServerSelectionTimeoutError


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Backfill tenant_id for legacy projects missing this field.",
    )
    parser.add_argument(
        "--tenant-id",
        default="__default__",
        help="Tenant ID to set on legacy projects (default: __default__)",
    )
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Apply changes. If omitted, script runs in dry-run mode.",
    )
    return parser.parse_args()


async def main() -> None:
    # Keep behavior consistent with backend startup: load variables from .env.
    load_dotenv()

    args = _parse_args()

    mongodb_uri = os.getenv("MONGODB_URI", "mongodb://localhost:27017")
    database_name = os.getenv("MONGODB_DATABASE", "synaps")
    client = AsyncIOMotorClient(mongodb_uri, serverSelectionTimeoutMS=5000)
    projects = client[database_name]["projects"]

    missing_query = {"tenant_id": {"$exists": False}}
    null_query = {"$and": [{"tenant_id": None}, {"tenant_id": {"$exists": True}}]}
    empty_query = {"tenant_id": ""}
    query = {"$or": [missing_query, null_query, empty_query]}
    update = {"$set": {"tenant_id": args.tenant_id}}

    try:
        missing_count = await projects.count_documents(missing_query)
        null_count = await projects.count_documents(null_query)
        empty_count = await projects.count_documents(empty_query)
        total_legacy = await projects.count_documents(query)
        mode = "APPLY" if args.apply else "DRY-RUN"
        print(
            "[BACKFILL_PROJECT_TENANT] "
            f"mode={mode} db={database_name} "
            f"missing={missing_count} null={null_count} empty={empty_count} "
            f"total_legacy={total_legacy}"
        )

        if not args.apply:
            print(
                "[BACKFILL_PROJECT_TENANT] No changes written. "
                "Run with --apply to execute update_many."
            )
            return

        result = await projects.update_many(query, update)
        print(
            "[BACKFILL_PROJECT_TENANT] updated "
            f"matched={result.matched_count} modified={result.modified_count} "
            f"tenant_id={args.tenant_id}"
        )
    except ServerSelectionTimeoutError as e:
        print("[BACKFILL_PROJECT_TENANT] MongoDB is unreachable. Check MONGODB_URI/network/VPN.")
        raise
    except OperationFailure as e:
        print("[BACKFILL_PROJECT_TENANT] MongoDB authorization failed. Check username/password/roles in MONGODB_URI.")
        raise
    finally:
        client.close()


if __name__ == "__main__":
    asyncio.run(main())
