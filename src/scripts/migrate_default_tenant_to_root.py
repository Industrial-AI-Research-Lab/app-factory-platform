"""Migrate tenant namespace from __default__ to __root__.

Usage:
    python -m scripts.migrate_default_tenant_to_root
    python -m scripts.migrate_default_tenant_to_root --apply
"""

from __future__ import annotations

import argparse
import asyncio
import os
from typing import Any

from dotenv import load_dotenv
from motor.motor_asyncio import AsyncIOMotorClient
from pymongo.errors import OperationFailure, ServerSelectionTimeoutError

OLD_TENANT_ID = "__default__"
NEW_TENANT_ID = "__root__"


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Rename tenant '__default__' to '__root__' and update references.",
    )
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Apply changes. If omitted, script runs in dry-run mode.",
    )
    return parser.parse_args()


async def _rename_document_id(collection, old_id: str, new_id: str, apply: bool) -> dict[str, Any]:
    old_doc = await collection.find_one({"_id": old_id})
    new_doc = await collection.find_one({"_id": new_id})

    if not old_doc:
        return {"action": "skip_missing_old", "inserted": 0, "deleted": 0}
    if new_doc:
        return {"action": "skip_new_exists", "inserted": 0, "deleted": 0}
    if not apply:
        return {"action": "would_rename", "inserted": 0, "deleted": 0}

    old_doc["_id"] = new_id
    await collection.insert_one(old_doc)
    deleted = await collection.delete_one({"_id": old_id})
    return {"action": "renamed", "inserted": 1, "deleted": deleted.deleted_count}


async def main() -> None:
    load_dotenv()
    args = _parse_args()

    mongodb_uri = os.getenv("MONGODB_URI", "mongodb://localhost:27017")
    database_name = os.getenv("MONGODB_DATABASE", "AppFactory")
    client = AsyncIOMotorClient(mongodb_uri, serverSelectionTimeoutMS=5000)
    db = client[database_name]

    mode = "APPLY" if args.apply else "DRY-RUN"
    print(f"[MIGRATION] mode={mode} db={database_name} old={OLD_TENANT_ID} new={NEW_TENANT_ID}")

    try:
        tenant_result = await _rename_document_id(
            db["tenants"],
            OLD_TENANT_ID,
            NEW_TENANT_ID,
            args.apply,
        )
        settings_result = await _rename_document_id(
            db["tenant_settings"],
            OLD_TENANT_ID,
            NEW_TENANT_ID,
            args.apply,
        )

        print(f"[MIGRATION] tenants action={tenant_result['action']}")
        print(f"[MIGRATION] tenant_settings action={settings_result['action']}")

        updates = (
            "users",
            "agent_configurations",
            "workflow_definitions",
            "run_configurations",
            "projects",
            "tool_configurations",
        )
        for collection_name in updates:
            query = {"tenant_id": OLD_TENANT_ID}
            update = {"$set": {"tenant_id": NEW_TENANT_ID}}
            if not args.apply:
                count = await db[collection_name].count_documents(query)
                print(
                    f"[MIGRATION] collection={collection_name} action=would_update matched={count}"
                )
                continue

            result = await db[collection_name].update_many(query, update)
            print(
                f"[MIGRATION] collection={collection_name} action=updated "
                f"matched={result.matched_count} modified={result.modified_count}"
            )

        if not args.apply:
            print("[MIGRATION] Dry-run complete. Re-run with --apply to persist changes.")
    except ServerSelectionTimeoutError:
        print("[MIGRATION] MongoDB is unreachable. Check MONGODB_URI/network/VPN.")
        raise
    except OperationFailure:
        print("[MIGRATION] MongoDB authorization failed. Check credentials/roles.")
        raise
    finally:
        client.close()


if __name__ == "__main__":
    asyncio.run(main())
