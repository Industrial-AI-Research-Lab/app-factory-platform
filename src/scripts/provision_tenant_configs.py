"""One-time tenant provisioning from __system__ templates.

Usage:
    python -m scripts.provision_tenant_configs --tenant-id "__root__" --apply
"""

from __future__ import annotations

import argparse
import asyncio
import os

from dotenv import load_dotenv

from api.auth.tenant_provisioning import provision_tenant
from storage.mongo_backend import MongoStorageBackend


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Clone __system__ configs into tenant namespace.",
    )
    parser.add_argument(
        "--tenant-id",
        default="__root__",
        help="Target tenant id (default: __root__)",
    )
    parser.add_argument(
        "--actor-id",
        default="__system__",
        help="Audit actor id for created clones (default: __system__)",
    )
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Apply changes. If omitted, script exits without writes.",
    )
    return parser.parse_args()


async def main() -> None:
    load_dotenv()
    args = _parse_args()

    if not args.apply:
        print(
            "[TENANT_PROVISION] mode=DRY-RUN no writes performed. "
            "Re-run with --apply to execute provisioning."
        )
        return

    storage = MongoStorageBackend(
        connection_string=os.getenv("MONGODB_URI", "mongodb://localhost:27017"),
        database=os.getenv("MONGODB_DATABASE", "AppFactory"),
        enable_transactions=os.getenv("MONGODB_ENABLE_TRANSACTIONS", "true").lower() == "true",
    )

    try:
        await storage.initialize()
        counts = await provision_tenant(
            storage=storage,
            tenant_id=args.tenant_id,
            actor_id=args.actor_id,
        )
        print(
            "[TENANT_PROVISION] tenant_id=%s agents=%d workflows=%d run_configs=%d tools=%d"
            % (
                args.tenant_id,
                counts.get("agents", 0),
                counts.get("workflows", 0),
                counts.get("run_configs", 0),
                counts.get("tools", 0),
            )
        )
    finally:
        await storage.close()


if __name__ == "__main__":
    asyncio.run(main())
