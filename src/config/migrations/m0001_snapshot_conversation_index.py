"""Backfill ``meta.conversation_index`` on user_message snapshots.

Irreversible: the stored values were wrong, there is nothing to restore.
"""
from dataclasses import asdict

from config import migrate_snapshot_conversation_index as backfill

VERSION = 1
NAME = "snapshot_conversation_index_backfill"
CHECKSUM_INCLUDES = (backfill,)


async def up(ctx):
    stats = await backfill.apply_to_db(ctx.db, apply=True)
    return asdict(stats)
