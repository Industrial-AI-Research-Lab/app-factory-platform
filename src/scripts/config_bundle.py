"""Configuration Bundle CLI — export/import tenant configs as JSON.

Usage:
    python -m scripts.config_bundle export  --tenant TENANT --out FILE
    python -m scripts.config_bundle dry-run --bundle FILE  --tenant TENANT
    python -m scripts.config_bundle apply   --bundle FILE  --tenant TENANT [--yes]

Connects to MongoDB via env vars (MONGODB_URI, MONGODB_DATABASE,
MONGODB_ENABLE_TRANSACTIONS). For CI/scripted use, pass --yes to skip the
interactive confirmation gate of `apply`.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import sys
from typing import Any, Dict

from dotenv import load_dotenv

from config.bundle_service import (
    KINDS,
    BundleError,
    apply_import,
    dry_run_import,
    export_bundle,
)
from storage.mongo_backend import MongoStorageBackend

logger = logging.getLogger(__name__)


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Export/import tenant configurations as JSON bundles.",
    )
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_export = sub.add_parser(
        "export", help="Dump tenant configs into a JSON bundle file",
    )
    p_export.add_argument("--tenant", required=True, help="Source tenant id")
    p_export.add_argument(
        "--out", required=True,
        help="Output file path (e.g. urban-bundle.json)",
    )

    p_dryrun = sub.add_parser(
        "dry-run",
        help="Validate bundle and show per-item action without writes",
    )
    p_dryrun.add_argument(
        "--bundle", required=True, help="Path to bundle JSON file",
    )
    p_dryrun.add_argument("--tenant", required=True, help="Target tenant id")
    p_dryrun.add_argument(
        "--json", action="store_true",
        help="Emit raw JSON result to stdout (default: human summary)",
    )

    p_apply = sub.add_parser(
        "apply",
        help="Commit bundle to target tenant (with confirmation gate)",
    )
    p_apply.add_argument(
        "--bundle", required=True, help="Path to bundle JSON file",
    )
    p_apply.add_argument("--tenant", required=True, help="Target tenant id")
    p_apply.add_argument(
        "--actor-id", default="cli",
        help="Audit actor id for created/updated docs (default: cli)",
    )
    p_apply.add_argument(
        "--yes", action="store_true",
        help="Skip interactive confirmation (required for non-interactive use)",
    )
    p_apply.add_argument(
        "--json", action="store_true",
        help="Emit raw JSON result to stdout (default: human summary)",
    )

    return parser.parse_args()


def _make_storage() -> MongoStorageBackend:
    return MongoStorageBackend(
        connection_string=os.getenv("MONGODB_URI", "mongodb://localhost:27017"),
        database=os.getenv("MONGODB_DATABASE", "AppFactory"),
        enable_transactions=os.getenv(
            "MONGODB_ENABLE_TRANSACTIONS", "true",
        ).lower() == "true",
    )


def _load_bundle(path: str) -> Dict[str, Any]:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def _print_summary(label: str, result: Dict[str, Any]) -> None:
    summary = result.get("summary", {})
    print(f"[BUNDLE] {label} target={result.get('target_tenant_id')}")
    for kind in KINDS:
        counts = summary.get(kind, {})
        if not counts.get("total", 0):
            continue
        print(
            f"  {kind:22s} total={counts.get('total', 0)} "
            f"insert={counts.get('insert', 0)} "
            f"update={counts.get('update', 0)} "
            f"skip={counts.get('skip', 0)} "
            f"error={counts.get('error', 0)}"
        )

    errors = [
        (kind, item)
        for kind, items in result.get("items", {}).items()
        for item in items
        if item.get("action") == "error"
    ]
    if errors:
        print(f"[BUNDLE] errors: {len(errors)}")
        for kind, item in errors[:10]:
            print(f"  - {kind}/{item.get('_id')}: {item.get('error')}")
        if len(errors) > 10:
            print(f"  ... and {len(errors) - 10} more")


def _has_errors(result: Dict[str, Any]) -> bool:
    for items in result.get("items", {}).values():
        if any(item.get("action") == "error" for item in items):
            return True
    return False


async def _cmd_export(args: argparse.Namespace, storage) -> int:
    try:
        bundle = await export_bundle(storage, args.tenant)
    except BundleError as exc:
        print(f"[BUNDLE] export failed: {exc}", file=sys.stderr)
        return 2
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(bundle, f, indent=2, default=str)
    items = bundle.get("items", {})
    counts = " ".join(f"{kind}={len(items.get(kind, []))}" for kind in KINDS)
    print(f"[BUNDLE] exported tenant={args.tenant} to {args.out} {counts}")
    return 0


async def _cmd_dry_run(args: argparse.Namespace, storage) -> int:
    try:
        bundle = _load_bundle(args.bundle)
    except (OSError, json.JSONDecodeError) as exc:
        print(f"[BUNDLE] failed to load bundle: {exc}", file=sys.stderr)
        return 2
    try:
        result = await dry_run_import(storage, bundle, args.tenant)
    except BundleError as exc:
        print(f"[BUNDLE] dry-run failed: {exc}", file=sys.stderr)
        return 2
    if args.json:
        json.dump(result, sys.stdout, indent=2, default=str)
        print()
    else:
        _print_summary("dry-run", result)
    return 1 if _has_errors(result) else 0


async def _cmd_apply(args: argparse.Namespace, storage) -> int:
    try:
        bundle = _load_bundle(args.bundle)
    except (OSError, json.JSONDecodeError) as exc:
        print(f"[BUNDLE] failed to load bundle: {exc}", file=sys.stderr)
        return 2

    try:
        preview = await dry_run_import(storage, bundle, args.tenant)
    except BundleError as exc:
        print(f"[BUNDLE] preview failed: {exc}", file=sys.stderr)
        return 2

    _print_summary("preview", preview)

    if not args.yes:
        if not sys.stdin.isatty():
            print(
                "[BUNDLE] non-interactive run requires --yes to apply",
                file=sys.stderr,
            )
            return 1
        prompt = f"Apply bundle to tenant '{args.tenant}'? type YES: "
        try:
            if input(prompt).strip() != "YES":
                print("[BUNDLE] aborted by user")
                return 1
        except (KeyboardInterrupt, EOFError):
            print("\n[BUNDLE] aborted")
            return 130

    try:
        result = await apply_import(
            storage, bundle, args.tenant, actor_id=args.actor_id,
        )
    except BundleError as exc:
        print(f"[BUNDLE] apply failed: {exc}", file=sys.stderr)
        return 2

    if args.json:
        json.dump(result, sys.stdout, indent=2, default=str)
        print()
    else:
        _print_summary("apply", result)
    return 1 if _has_errors(result) else 0


async def main() -> int:
    load_dotenv()
    args = _parse_args()
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
    )

    storage = _make_storage()
    try:
        await storage.initialize()
        if args.cmd == "export":
            return await _cmd_export(args, storage)
        if args.cmd == "dry-run":
            return await _cmd_dry_run(args, storage)
        if args.cmd == "apply":
            return await _cmd_apply(args, storage)
        print(f"unknown command: {args.cmd}", file=sys.stderr)
        return 2
    finally:
        if hasattr(storage, "close"):
            try:
                await storage.close()
            except Exception:
                pass


if __name__ == "__main__":
    try:
        sys.exit(asyncio.run(main()))
    except KeyboardInterrupt:
        sys.exit(130)
