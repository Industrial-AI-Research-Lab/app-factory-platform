"""
Backfill `event_id` (UUID v7) for legacy events that pre-date the watermark
redesign. Synthesizes a v7 from each doc's existing `timestamp` so the
backfilled IDs sort in the same chronological order as the live IDs minted at
emit time.

Idempotent: skips docs that already have `event_id`. Safe to re-run.

By default, runs in dry-run mode and prints how many events would be updated.
Use --apply to execute the write.

Usage:
    python -m scripts.backfill_event_id
    python -m scripts.backfill_event_id --apply
"""

from __future__ import annotations

import argparse
import asyncio
import os
import uuid
from datetime import timezone

from dotenv import load_dotenv
from motor.motor_asyncio import AsyncIOMotorClient
from pymongo.errors import OperationFailure, ServerSelectionTimeoutError


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Backfill UUID v7 event_id for legacy events.",
    )
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Apply changes. If omitted, script runs in dry-run mode.",
    )
    parser.add_argument(
        "--batch-size",
        type=int,
        default=500,
        help="How many docs to update per bulk write (default: 500)",
    )
    return parser.parse_args()


def _v7_from_timestamp_ms(ms: int) -> str:
    """Mint a UUID v7 whose embedded timestamp matches `ms`.

    Layout per RFC 9562:
        48 bits unix_ts_ms | 4 bits ver (7) | 12 bits rand_a | 2 bits var (0b10) | 62 bits rand_b
    """
    ms = int(ms) & 0xFFFFFFFFFFFF
    rand_a = int.from_bytes(os.urandom(2), "big") & 0x0FFF
    rand_b = int.from_bytes(os.urandom(8), "big") & 0x3FFFFFFFFFFFFFFF
    val = (ms << 80) | (0x7 << 76) | (rand_a << 64) | (0b10 << 62) | rand_b
    return str(uuid.UUID(int=val))


async def main() -> None:
    load_dotenv()
    args = _parse_args()

    mongodb_uri = os.getenv("MONGODB_URI", "mongodb://localhost:27017")
    database_name = os.getenv("MONGODB_DATABASE", "synaps")
    client = AsyncIOMotorClient(mongodb_uri, serverSelectionTimeoutMS=5000)
    events = client[database_name]["events"]

    missing_query = {"event_id": {"$exists": False}}
    mode = "APPLY" if args.apply else "DRY-RUN"

    try:
        total = await events.count_documents(missing_query)
        print(f"[BACKFILL_EVENT_ID] mode={mode} db={database_name} missing={total}")

        if total == 0:
            print("[BACKFILL_EVENT_ID] Nothing to backfill.")
            return

        if not args.apply:
            print(
                "[BACKFILL_EVENT_ID] No changes written. "
                "Run with --apply to execute the backfill."
            )
            return

        updated = 0
        skipped = 0
        cursor = events.find(missing_query, projection={"_id": 1, "timestamp": 1})
        batch: list = []

        async for doc in cursor:
            ts = doc.get("timestamp")
            if ts is None:
                skipped += 1
                continue
            # `timestamp` is stored as datetime by Motor when the writer uses
            # datetime.utcnow(); older callers occasionally wrote ISO strings.
            if hasattr(ts, "timestamp"):
                # Naive datetimes from Motor must be stamped UTC before
                # .timestamp() — otherwise Python interprets them in the
                # operator's local timezone and the embedded UUID v7
                # timestamps drift by the operator's UTC offset.
                if ts.tzinfo is None:
                    ts = ts.replace(tzinfo=timezone.utc)
                ms = int(ts.timestamp() * 1000)
            else:
                # ISO string fallback
                from datetime import datetime
                try:
                    parsed = datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
                    if parsed.tzinfo is None:
                        parsed = parsed.replace(tzinfo=timezone.utc)
                    ms = int(parsed.timestamp() * 1000)
                except Exception:
                    skipped += 1
                    continue

            event_id = _v7_from_timestamp_ms(ms)
            batch.append((doc["_id"], event_id))

            if len(batch) >= args.batch_size:
                await _flush(events, batch)
                updated += len(batch)
                batch.clear()
                print(f"[BACKFILL_EVENT_ID] progress updated={updated}/{total} skipped={skipped}")

        if batch:
            await _flush(events, batch)
            updated += len(batch)

        print(
            f"[BACKFILL_EVENT_ID] done updated={updated} skipped={skipped} "
            f"total_seen={updated + skipped}"
        )
    except ServerSelectionTimeoutError:
        print("[BACKFILL_EVENT_ID] MongoDB is unreachable. Check MONGODB_URI/network/VPN.")
        raise
    except OperationFailure:
        print("[BACKFILL_EVENT_ID] MongoDB authorization failed. Check username/password/roles in MONGODB_URI.")
        raise
    finally:
        client.close()


async def _flush(events, batch: list) -> None:
    """Apply a batch of (doc_id, event_id) updates."""
    from pymongo import UpdateOne
    ops = [UpdateOne({"_id": _id}, {"$set": {"event_id": eid}}) for _id, eid in batch]
    await events.bulk_write(ops, ordered=False)


if __name__ == "__main__":
    asyncio.run(main())
