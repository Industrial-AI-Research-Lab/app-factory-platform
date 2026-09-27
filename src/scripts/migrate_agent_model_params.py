"""CLI wrapper for the explicit legacy agent model-parameter migration.

Usage:
    python -m scripts.migrate_agent_model_params
    python -m scripts.migrate_agent_model_params --apply
"""

import argparse
import asyncio
import logging
import os
import re
from urllib.parse import quote_plus

from motor.motor_asyncio import AsyncIOMotorClient
from pymongo.errors import ServerSelectionTimeoutError

from config.migrate_agent_model_params import migrate_agent_model_params

logger = logging.getLogger(__name__)


def _mongodb_uri() -> str:
    return os.environ["MONGODB_URI"]


async def run(*, apply: bool, database: str) -> int:
    client = AsyncIOMotorClient(_mongodb_uri(), serverSelectionTimeoutMS=30000)
    try:
        await client.admin.command("ping")
        logger.info(
            "[MIGRATE_AGENT_MODEL_PARAMS] mode=%s database=%s",
            "apply" if apply else "dry-run",
            database,
        )
        if apply:
            logger.warning(
                "[MIGRATE_AGENT_MODEL_PARAMS] backup_required=true "
                "— verify a current MongoDB backup before applying"
            )
        report = await migrate_agent_model_params(client[database], apply=apply)
        logger.info("[MIGRATE_AGENT_MODEL_PARAMS] report=%s", report.as_dict())
        for issue in report.issues:
            logger.warning(
                "[MIGRATE_AGENT_MODEL_PARAMS] issue agent=%s error=%s",
                issue["agent_id"],
                issue["error"],
            )
        if report.conflicted:
            return 2
        if report.enabled_skipped:
            return 3
        if not apply and report.enabled_normalized:
            logger.error(
                "[MIGRATE_AGENT_MODEL_PARAMS] status=migration_required "
                "enabled_pending=%d",
                report.enabled_normalized,
            )
            return 4
        if apply:
            verification = await migrate_agent_model_params(
                client[database],
                apply=False,
            )
            logger.info(
                "[MIGRATE_AGENT_MODEL_PARAMS] post_apply_report=%s",
                verification.as_dict(),
            )
            for issue in verification.issues:
                logger.warning(
                    "[MIGRATE_AGENT_MODEL_PARAMS] post_apply_issue agent=%s error=%s",
                    issue["agent_id"],
                    issue["error"],
                )
            if verification.enabled_skipped:
                return 3
            if verification.enabled_normalized:
                logger.error(
                    "[MIGRATE_AGENT_MODEL_PARAMS] post_apply_status=incomplete "
                    "enabled_remaining=%d",
                    verification.enabled_normalized,
                )
                return 4
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
        description="Normalize legacy agent model parameters in MongoDB.",
    )
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Apply changes. Default is dry-run.",
    )
    parser.add_argument(
        "--database",
        default=os.getenv("MONGODB_DATABASE", "synaps"),
        help="Mongo database name (default: $MONGODB_DATABASE or 'synaps').",
    )
    args = parser.parse_args()
    try:
        raise SystemExit(asyncio.run(run(apply=args.apply, database=args.database)))
    except ServerSelectionTimeoutError as exc:
        logger.error("[MIGRATE_AGENT_MODEL_PARAMS] MongoDB unavailable: %s", exc)
        raise SystemExit(1) from exc


if __name__ == "__main__":
    main()
