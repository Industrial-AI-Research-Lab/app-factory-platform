"""
Backfill `checkpoint_sequence=0` for legacy file_artifacts that pre-date the
stamp-on-write fix in ArtifactStore.save_file. Sets a preservable sentinel
on every doc where the field is absent or null — `0` survives any
positive-target revert (`$gt: target` never matches), so existing artifacts
written before the fix won't be swept by future reverts.

Idempotent: skips docs that already have a non-null checkpoint_sequence
(including `0`). Safe to re-run.

By default, runs in dry-run mode and prints how many artifacts would be
updated. Use --apply to execute the write.

Usage:
    python -m scripts.backfill_artifact_checkpoint_sequence
    python -m scripts.backfill_artifact_checkpoint_sequence --apply
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
        description="Backfill checkpoint_sequence=0 sentinel for legacy file_artifacts.",
    )
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Apply changes. If omitted, script runs in dry-run mode.",
    )
    return parser.parse_args()


async def main() -> None:
    load_dotenv()
    args = _parse_args()

    mongodb_uri = os.getenv("MONGODB_URI", "mongodb://localhost:27017")
    database_name = os.getenv("MONGODB_DATABASE", "synaps")
    client = AsyncIOMotorClient(mongodb_uri, serverSelectionTimeoutMS=5000)
    file_artifacts = client[database_name]["file_artifacts"]

    # Match both missing and explicit-null. Excludes `0` so a re-run is a no-op.
    missing_query = {
        "$or": [
            {"checkpoint_sequence": {"$exists": False}},
            {"checkpoint_sequence": None},
        ]
    }
    mode = "APPLY" if args.apply else "DRY-RUN"

    try:
        total = await file_artifacts.count_documents(missing_query)
        print(f"[BACKFILL_ARTIFACT_SEQ] mode={mode} db={database_name} missing={total}")

        if total == 0:
            print("[BACKFILL_ARTIFACT_SEQ] Nothing to backfill.")
            return

        if not args.apply:
            print(
                "[BACKFILL_ARTIFACT_SEQ] No changes written. "
                "Run with --apply to execute the backfill."
            )
            return

        result = await file_artifacts.update_many(
            missing_query,
            {"$set": {"checkpoint_sequence": 0}},
        )
        print(
            f"[BACKFILL_ARTIFACT_SEQ] done matched={result.matched_count} "
            f"modified={result.modified_count}"
        )
    except ServerSelectionTimeoutError:
        print("[BACKFILL_ARTIFACT_SEQ] MongoDB is unreachable. Check MONGODB_URI/network/VPN.")
        raise
    except OperationFailure:
        print("[BACKFILL_ARTIFACT_SEQ] MongoDB authorization failed. Check username/password/roles in MONGODB_URI.")
        raise
    finally:
        client.close()


if __name__ == "__main__":
    asyncio.run(main())
