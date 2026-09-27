"""
Backfill `data.gate_node_id` on legacy PENDING approvals that pre-date the
post-restart FSM-rehydration architecture.

Why this exists
---------------
`Orchestrator.ensure_workflow_running` (orchestration/orchestrator.py:213) is
the only path that spawns the WorkflowEngine after a backend restart. It
short-circuits at :261-266 when the pending approval's `data.gate_node_id` is
missing — no FSM is parked on `wait_for_approval`, so a subsequent
approve()/reject() flips the approval status but the workflow never walks the
next edge. Project stalls; the UI shows "approved" but nothing happens.

Approvals minted by the post-PR `request_approval` carry
`data.gate_node_id = node["id"]` from the workflow node itself (see
workflow_engine.py:544 and :653). Pre-PR approvals were written with
subtype-only data and would all become un-rehydratable on first PR-version
backend startup. This backfill maps `subtype → gate_node_id` per the default
workflow definition (config/workflows.json) and sets the field on every
legacy PENDING row so the rehydration path works.

Idempotent: skips docs that already have a non-empty `data.gate_node_id`.
Safe to re-run after partial completion.

By default, runs in dry-run mode and prints what would be updated. Use
`--apply` to execute the write.

Usage:
    python -m scripts.backfill_approval_gate_node_id
    python -m scripts.backfill_approval_gate_node_id --apply
"""

from __future__ import annotations

import argparse
import asyncio
import os

from dotenv import load_dotenv
from motor.motor_asyncio import AsyncIOMotorClient
from pymongo.errors import OperationFailure, ServerSelectionTimeoutError


# Maps the legacy `subtype` field on approval message rows to the matching
# `node["id"]` in the default build workflow (config/workflows.json). Adding a
# new workflow with a different gate naming scheme means adding rows here AND
# re-running the backfill against legacy data minted before that workflow's
# rollout. Workflows that don't share these exact subtype strings need their
# own mapping or row exclusion.
SUBTYPE_TO_GATE = {
    "requirements": "gate_req",
    "plan": "gate_plan",
    "output": "gate_output",
    "deploy": "deploy",
}


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Backfill data.gate_node_id on legacy PENDING approvals.",
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


async def main() -> None:
    load_dotenv()
    args = _parse_args()

    mongodb_uri = os.getenv("MONGODB_URI", "mongodb://localhost:27017")
    database_name = os.getenv("MONGODB_DATABASE", "synaps")
    client = AsyncIOMotorClient(mongodb_uri, serverSelectionTimeoutMS=5000)
    messages = client[database_name]["messages"]

    missing_query = {
        "type": "approval",
        "status": "pending",
        "$or": [
            {"data.gate_node_id": {"$exists": False}},
            {"data.gate_node_id": None},
            {"data.gate_node_id": ""},
        ],
    }
    mode = "APPLY" if args.apply else "DRY-RUN"

    try:
        total = await messages.count_documents(missing_query)
        print(f"[BACKFILL_GATE_NODE_ID] mode={mode} db={database_name} missing={total}")

        if total == 0:
            print("[BACKFILL_GATE_NODE_ID] Nothing to backfill.")
            return

        # Surface the per-subtype breakdown so the operator sees what's about
        # to be touched and which rows will be skipped for unmapped subtypes.
        subtype_counts: dict = {}
        unmapped: list = []
        cursor = messages.find(missing_query, projection={"_id": 1, "subtype": 1})
        async for doc in cursor:
            subtype = doc.get("subtype")
            subtype_counts[subtype] = subtype_counts.get(subtype, 0) + 1
            if subtype not in SUBTYPE_TO_GATE:
                unmapped.append(doc["_id"])

        print("[BACKFILL_GATE_NODE_ID] by subtype:")
        for subtype, count in sorted(subtype_counts.items(), key=lambda kv: (kv[0] or "")):
            gate = SUBTYPE_TO_GATE.get(subtype, "(SKIPPED — no mapping)")
            print(f"  {subtype}: {count} → {gate}")
        if unmapped:
            print(
                f"[BACKFILL_GATE_NODE_ID] {len(unmapped)} row(s) have no subtype mapping "
                f"and will be skipped. Add the subtype to SUBTYPE_TO_GATE if these belong "
                f"to a non-default workflow."
            )

        if not args.apply:
            print(
                "[BACKFILL_GATE_NODE_ID] No changes written. "
                "Run with --apply to execute the backfill."
            )
            return

        updated = 0
        skipped = 0
        cursor = messages.find(missing_query, projection={"_id": 1, "subtype": 1})
        batch: list = []

        async for doc in cursor:
            subtype = doc.get("subtype")
            gate = SUBTYPE_TO_GATE.get(subtype)
            if not gate:
                skipped += 1
                continue
            batch.append((doc["_id"], gate))

            if len(batch) >= args.batch_size:
                await _flush(messages, batch)
                updated += len(batch)
                batch.clear()
                print(
                    f"[BACKFILL_GATE_NODE_ID] progress updated={updated}/{total} "
                    f"skipped={skipped}"
                )

        if batch:
            await _flush(messages, batch)
            updated += len(batch)

        print(
            f"[BACKFILL_GATE_NODE_ID] done updated={updated} skipped={skipped} "
            f"total_seen={updated + skipped}"
        )
    except ServerSelectionTimeoutError:
        print("[BACKFILL_GATE_NODE_ID] MongoDB is unreachable. Check MONGODB_URI/network/VPN.")
        raise
    except OperationFailure:
        print(
            "[BACKFILL_GATE_NODE_ID] MongoDB authorization failed. "
            "Check username/password/roles in MONGODB_URI."
        )
        raise
    finally:
        client.close()


async def _flush(messages, batch: list) -> None:
    """Apply a batch of (doc_id, gate_node_id) updates via $set on data.gate_node_id."""
    from pymongo import UpdateOne
    ops = [
        UpdateOne({"_id": _id}, {"$set": {"data.gate_node_id": gate}})
        for _id, gate in batch
    ]
    await messages.bulk_write(ops, ordered=False)


if __name__ == "__main__":
    asyncio.run(main())
