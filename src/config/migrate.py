"""CLI for the versioned migration runner.

    python -m config.migrate status
    python -m config.migrate upgrade [--target N] [--dry-run] [--allow-out-of-order]
    python -m config.migrate downgrade --to N
    python -m config.migrate baseline --version N
    python -m config.migrate repair [--mark-applied | --mark-reverted]

Reads .env like the other config scripts (a variable already in the environment
wins), connects with MONGODB_URI handed to the driver verbatim — as the backend
does, so an already-escaped password is not encoded twice — and MONGODB_DATABASE;
prints the runner's report as JSON and exits 1 on any MigrationError.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import sys

from motor.motor_asyncio import AsyncIOMotorClient

from config.migration_registry import MigrationError
from config.migration_runner import Migrator


def _parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--database", default=os.getenv("MONGODB_DATABASE", "synaps"))
    p.add_argument("--wait", type=float, default=0.0, help="seconds to wait for the lock (default 0)")
    sub = p.add_subparsers(dest="command", required=True)
    sub.add_parser("status")
    up = sub.add_parser("upgrade")
    up.add_argument("--target", type=int)
    up.add_argument("--dry-run", action="store_true")
    up.add_argument("--allow-out-of-order", action="store_true")
    down = sub.add_parser("downgrade")
    down.add_argument("--to", type=int, required=True)
    base = sub.add_parser("baseline")
    base.add_argument("--version", type=int, required=True)
    rep = sub.add_parser("repair")
    rep.add_argument("--mark-applied", action="store_true")
    rep.add_argument("--mark-reverted", action="store_true")
    return p


async def _run(args: argparse.Namespace) -> int:
    client = AsyncIOMotorClient(os.environ["MONGODB_URI"], serverSelectionTimeoutMS=30000)
    try:
        await client.admin.command("ping")
        m = Migrator(client[args.database], sha=os.getenv("BUILD_SHA"))
        if args.command == "status":
            report = await m.status()
        elif args.command == "upgrade":
            report = await m.upgrade(target=args.target, dry_run=args.dry_run,
                                     allow_out_of_order=args.allow_out_of_order, wait_for_lock=args.wait)
        elif args.command == "downgrade":
            report = await m.downgrade(to_version=args.to, wait_for_lock=args.wait)
        elif args.command == "baseline":
            report = await m.baseline(version=args.version, wait_for_lock=args.wait)
        else:
            report = await m.repair(mark_applied=args.mark_applied, mark_reverted=args.mark_reverted,
                                    wait_for_lock=args.wait)
    except MigrationError as e:
        print(json.dumps({"error": type(e).__name__, "message": str(e), "detail": e.detail}, default=str, indent=2))
        return 1
    finally:
        client.close()
    print(json.dumps(report, default=str, indent=2))
    return 0


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    try:
        from dotenv import load_dotenv

        load_dotenv()
    except ImportError:
        pass
    sys.exit(asyncio.run(_run(_parser().parse_args())))


if __name__ == "__main__":
    main()
