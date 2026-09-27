#!/usr/bin/env python3
"""Backfill user_message snapshots' meta.conversation_index with the real
message-store sequence.

Older snapshots recorded conversation_index from the deprecated, always-empty
SharedContext conversation_history cache, so it collapsed to 0 (pre-migration
snapshots may instead hold a stale conversation *list index*). revert-to-user
feeds that value to truncate_conversation as a message *sequence* (delete
sequence > it), so a stored 0 deleted the whole run — including the initial
prompt. The producer appends the user/approval message, records get_latest_sequence()
(that message's own sequence), creates the snapshot, and only then appends the
approval_result receipt — so the anchor is always a type="user" message and the
receipt is a later, higher sequence. This backfills existing snapshots to the
same coordinate: the highest user-message sequence at or before snapshot time.

Only user messages are candidates. On a run whose history was already wiped by
this very bug, the user anchors are deleted and only orphan approval_result
receipts survive; picking any message would repair the snapshot to a receipt's
sequence — a plausible-looking but wrong coordinate. Such a legacy-0 snapshot
with no surviving user anchor is reported unrepairable and left untouched, not
silently counted as already-correct.

sequence is a project-global counter (one message_sequences doc per project),
so the target is computed project-wide by created_at, not per run. Any stored
index below the anchor is repaired upward — both the index-0 (empty cache) and
the stale list-index eras; an index at or above the anchor is left alone, so
re-runs are no-ops. Dry-run is the default; --apply writes.
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import os
import re
from dataclasses import dataclass
from typing import Any, Optional
from urllib.parse import quote_plus

from motor.motor_asyncio import AsyncIOMotorClient
from pymongo.errors import ServerSelectionTimeoutError

from storage.snapshot_anchor import compute_target_sequence, snapshot_boundary

logger = logging.getLogger(__name__)


def _uri() -> str:
    raw = os.environ["MONGODB_URI"]
    m = re.match(r"mongodb://([^:]+):([^@]+)@(.+)", raw)
    if m:
        return f"mongodb://{m.group(1)}:{quote_plus(m.group(2))}@{m.group(3)}"
    return raw


def classify(current: int, target: Optional[int]) -> str:
    """Action for one snapshot: skip_no_timestamp | already_ok | unrepairable | repair.

    target is the real anchor sequence (0 when no user anchor survives). A
    stored index below it is broken and repaired upward, which covers both eras
    of the bug: the always-empty cache (index 0) and the earlier stale
    conversation *list index* (a small len(conv)-1 value — e.g. 4 where the
    anchor is at sequence 21 — which revert truncates on just as destructively).
    An index at or above the anchor is left alone: equal is already correct,
    higher is never lowered (a post-fix value or a prior run — re-runs stay
    idempotent). target 0 means the anchor was deleted (a wiped run):
    unrepairable, never rewritten to a stray receipt's sequence.
    """
    if target is None:
        return "skip_no_timestamp"
    if target == 0:
        return "unrepairable"
    if current < target:
        return "repair"
    return "already_ok"


@dataclass
class _Stats:
    scanned: int = 0
    already_ok: int = 0
    to_fix: int = 0
    updated: int = 0
    unrepairable: int = 0
    skipped_no_timestamp: int = 0
    projects: int = 0


async def apply_to_db(db, *, apply: bool, project: Optional[str] = None) -> _Stats:
    """Already repaired snapshots are left unchanged; the caller owns the connection."""
    stats = _Stats()
    snap_query: dict[str, Any] = {"type": "user_message"}
    if project:
        snap_query["project_id"] = project
    snaps = await db.snapshots.find(
        snap_query,
        {"_id": 1, "project_id": 1, "created_at": 1, "meta": 1, "label": 1},
    ).to_list(length=None)

    by_project: dict[str, list[dict]] = {}
    for snap in snaps:
        by_project.setdefault(snap.get("project_id"), []).append(snap)
    stats.projects = len(by_project)

    for project_id, project_snaps in by_project.items():
        messages = await db.messages.find(
            {"project_id": project_id},
            {"_id": 0, "sequence": 1, "created_at": 1, "type": 1},
        ).to_list(length=None)

        for snap in project_snaps:
            stats.scanned += 1
            current = int((snap.get("meta") or {}).get("conversation_index", 0) or 0)
            target = compute_target_sequence(snapshot_boundary(snap), messages)
            outcome = classify(current, target)
            if outcome == "skip_no_timestamp":
                stats.skipped_no_timestamp += 1
                logger.warning(
                    "[MIGRATE] snapshot %s (project %s) has no parseable "
                    "created_at — skipping",
                    snap.get("_id"), project_id,
                )
                continue
            if outcome == "already_ok":
                stats.already_ok += 1
                continue
            if outcome == "unrepairable":
                stats.unrepairable += 1
                logger.warning(
                    "[MIGRATE] project=%s snapshot=%s label=%r conversation_index=%d "
                    "but no user message survives before it — the anchor was deleted "
                    "(a wiped run); leaving as-is, NOT rewriting to a stray sequence.",
                    project_id, snap.get("_id"), snap.get("label"), current,
                )
                continue
            stats.to_fix += 1
            logger.info(
                "[MIGRATE] project=%s snapshot=%s label=%r conversation_index %d -> %d",
                project_id, snap.get("_id"), snap.get("label"), current, target,
            )
            if apply:
                await db.snapshots.update_one(
                    {"_id": snap.get("_id")},
                    {"$set": {"meta.conversation_index": target}},
                )
                stats.updated += 1

    logger.info(
        "[MIGRATE] done: projects=%d scanned=%d already_ok=%d to_fix=%d "
        "updated=%d unrepairable=%d skipped_no_timestamp=%d",
        stats.projects, stats.scanned, stats.already_ok, stats.to_fix,
        stats.updated, stats.unrepairable, stats.skipped_no_timestamp,
    )
    if not apply and stats.to_fix:
        logger.info("[MIGRATE] dry-run — re-run with --apply to write %d fix(es).", stats.to_fix)
    if stats.unrepairable:
        logger.warning(
            "[MIGRATE] %d snapshot(s) are unrepairable (anchor deleted by the wipe) "
            "and were left unchanged.", stats.unrepairable,
        )
    return stats


async def run(*, apply: bool, database: str, project: Optional[str] = None) -> int:
    client = AsyncIOMotorClient(_uri(), serverSelectionTimeoutMS=30000)
    db = client[database]
    try:
        await client.admin.command("ping")
        logger.info(
            "[MIGRATE] mode=%s db=%s scope=%s",
            "APPLY" if apply else "DRY-RUN",
            database,
            project or "all-projects",
        )
        await apply_to_db(db, apply=apply, project=project)
        return 0
    finally:
        client.close()


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    try:
        from dotenv import load_dotenv

        load_dotenv()
    except ImportError:
        pass
    parser = argparse.ArgumentParser(
        description="Backfill user_message snapshot conversation_index to the real message sequence.",
    )
    parser.add_argument(
        "--apply", action="store_true", help="Apply changes. Default is dry-run.",
    )
    parser.add_argument(
        "--database",
        default=os.getenv("MONGODB_DATABASE", "synaps"),
        help="Mongo database name (default: $MONGODB_DATABASE or 'synaps').",
    )
    parser.add_argument(
        "--project",
        default=None,
        help="Limit to a single project_id (default: all projects).",
    )
    args = parser.parse_args()
    try:
        raise SystemExit(
            asyncio.run(run(apply=args.apply, database=args.database, project=args.project))
        )
    except ServerSelectionTimeoutError as exc:
        logger.error("[MIGRATE] MongoDB unavailable: %s", exc)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
