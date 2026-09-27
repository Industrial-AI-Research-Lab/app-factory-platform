"""Shared controls for seed-gated startup writes."""

from __future__ import annotations

from datetime import datetime
import logging
import os

logger = logging.getLogger(__name__)


def seed_writes_enabled() -> bool:
    """Return True when seed/system bootstrap writes are explicitly enabled."""
    return os.getenv("SEED_ENABLED", "false").strip().lower() == "true"


async def maybe_write_backend_version(
    storage,
    *,
    build_run: str,
    build_sha: str,
    build_version: str,
    hostname: str,
) -> bool:
    """Persist backend version metadata only when seed-controlled writes are enabled."""
    if not seed_writes_enabled():
        logger.info(
            "[BOOT] writes_enabled=false build_sha=%s build_run=%s "
            "— skipping system_info.backend_version write",
            build_sha,
            build_run,
        )
        return False

    await storage.db.system_info.update_one(
        {"_id": "backend_version"},
        {"$set": {
            "build_run": build_run,
            "build_sha": build_sha,
            "build_version": build_version,
            "started_at": datetime.utcnow(),
            "hostname": hostname,
        }},
        upsert=True,
    )
    logger.info(
        "[BOOT] writes_enabled=true build_sha=%s build_run=%s "
        "— wrote system_info.backend_version",
        build_sha,
        build_run,
    )
    return True
