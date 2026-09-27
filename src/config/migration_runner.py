"""Versioned, ordered database migrations; the model and its rules are recorded
in docs/adr/0017-versioned-database-migrations.md.

``up``/``down`` must tolerate retries after partial data writes.

Discovery and planning live in ``migration_registry``; the lock in ``migration_lock``.
"""
from __future__ import annotations

import asyncio
import logging
import os
import socket
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Awaitable, Callable, Dict, List, Optional

from pymongo.errors import DuplicateKeyError

from config.migration_lock import (
    DEFAULT_HEARTBEAT_INTERVAL,
    DEFAULT_LOCK_POLL_INTERVAL,
    DEFAULT_LOCK_STALE_AFTER,
    MigrationLock,
)
from config.migration_registry import (
    DirtyDatabase,
    IrreversibleMigration,
    LockLost,
    MigrationContext,
    MigrationError,
    MigrationFailed,
    MigrationSpec,
    OutOfOrder,
    Plan,
    RegistryError,
    ValidationFailed,
    is_version_id,
    load_registry,
    plan_upgrade,
)

logger = logging.getLogger(__name__)

HISTORY_COLLECTION = "schema_migrations"
CONTROL_COLLECTION = "schema_migrations_control"
DIRTY_ID = "dirty"


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Migrator:
    """All operations take the global lock except ``status`` and dry-run ``upgrade``."""

    def __init__(
        self, db, *, registry: Optional[List[MigrationSpec]] = None,
        sha: Optional[str] = None, runner_id: Optional[str] = None,
        now_fn: Callable[[], datetime] = _utcnow,
        sleep_fn: Callable[[float], Awaitable[None]] = asyncio.sleep,
        lock_stale_after: timedelta = DEFAULT_LOCK_STALE_AFTER,
        heartbeat_interval: float = DEFAULT_HEARTBEAT_INTERVAL,
        lock_poll_interval: float = DEFAULT_LOCK_POLL_INTERVAL,
    ):
        self.db = db
        self.registry = registry if registry is not None else load_registry()
        self.sha = sha
        self.runner_id = runner_id or f"{socket.gethostname()}:{os.getpid()}:{uuid.uuid4().hex[:8]}"
        self._now = now_fn
        self.history = db[HISTORY_COLLECTION]
        self.control = db[CONTROL_COLLECTION]
        self.lock = MigrationLock(
            self.control, holder=self.runner_id, now_fn=now_fn, sleep_fn=sleep_fn,
            stale_after=lock_stale_after, heartbeat_interval=heartbeat_interval,
            poll_interval=lock_poll_interval,
        )

    async def _all_history_rows(self) -> List[Dict[str, Any]]:
        return await self.history.find({}).sort("_id", 1).to_list(length=None)

    async def _history_rows(self) -> List[Dict[str, Any]]:
        return [r for r in await self._all_history_rows() if is_version_id(r.get("_id"))]

    async def _plan(self, target: Optional[int] = None) -> Plan:
        return plan_upgrade(self.registry, await self._history_rows(), target=target)

    async def _dirty(self) -> Optional[Dict[str, Any]]:
        return await self.control.find_one({"_id": DIRTY_ID})

    async def status(self) -> Dict[str, Any]:
        all_rows = await self._all_history_rows()
        plan = plan_upgrade(self.registry, all_rows)
        dirty = await self._dirty()
        lock = await self.lock.current()
        rows = {r["_id"]: r for r in all_rows if is_version_id(r.get("_id"))}
        by_version = {s.version: s for s in self.registry}
        return {
            "current_version": plan.current,
            "head_version": plan.head,
            "dirty": _public(dirty),
            "lock": self.lock.view(lock),
            "applied": [_history_view(rows[v], by_version.get(v)) for v in plan.applied],
            "pending": [_spec_view(s) for s in plan.pending],
            "out_of_order": plan.out_of_order,
            "checksum_mismatches": plan.checksum_mismatches,
            "unknown_applied": plan.unknown_applied,
            "foreign_history_ids": [str(r.get("_id")) for r in all_rows if not is_version_id(r.get("_id"))],
        }

    async def fatal_pending(self) -> List[int]:
        plan = await self._plan()
        return [s.version for s in plan.pending if s.fatal]

    async def _write_dirty(self, spec: MigrationSpec, direction: str, error: str) -> None:
        await self.lock.verify_held()
        await self.control.update_one(
            {"_id": DIRTY_ID},
            {"$set": {"version": spec.version, "name": spec.name, "direction": direction,
                      "error": error[:4000], "at": self._now(), "sha": self.sha, "runner": self.runner_id}},
            upsert=True,
        )

    async def _mark_dirty(self, spec: MigrationSpec, error: BaseException, direction: str) -> None:
        try:
            await self._write_dirty(spec, direction, f"{type(error).__name__}: {error}")
        except LockLost:
            raise
        except Exception:
            logger.exception("[MIGRATE] %s %d %s failed and the dirty marker could not be written",
                             direction, spec.version, spec.name)

    def _require_clean(self, dirty: Optional[Dict[str, Any]]) -> None:
        if dirty:
            raise DirtyDatabase(
                f"database is dirty at version {dirty.get('version')} ({dirty.get('name')}): "
                f"{dirty.get('error')} — run repair first",
                dirty=_public(dirty),
            )

    async def upgrade(
        self, *, target: Optional[int] = None, dry_run: bool = False,
        allow_out_of_order: bool = False, wait_for_lock: float = 0.0,
    ) -> Dict[str, Any]:
        if dry_run:
            plan = await self._plan(target)
            return self._report(plan, applied_now=[], dirty=await self._dirty(), dry_run=True)

        async with self.lock.held(wait_for_lock):
            plan = await self._plan(target)
            self._require_clean(await self._dirty())
            if plan.checksum_mismatches:
                raise ValidationFailed(
                    "applied migration source changed since it was applied — "
                    "revert the edit or run repair to re-stamp checksums",
                    mismatches=plan.checksum_mismatches,
                )
            if plan.out_of_order and not allow_out_of_order:
                raise OutOfOrder(
                    f"pending versions {plan.out_of_order} are below the current version "
                    f"{plan.current}; pass allow_out_of_order to apply them",
                    versions=plan.out_of_order, current=plan.current,
                )
            applied_now: List[Dict[str, Any]] = []
            for spec in plan.pending:
                applied_now.append(await self._apply(spec))
            return self._report(await self._plan(target), applied_now=applied_now, dirty=None, dry_run=False)

    async def _apply(self, spec: MigrationSpec) -> Dict[str, Any]:
        ctx = MigrationContext(db=self.db, version=spec.version, name=spec.name, sha=self.sha, logger=logger)
        logger.info("[MIGRATE] up %d %s", spec.version, spec.name)
        started = self._now()
        try:
            stats = await self.lock.run_step(spec.up, ctx)
            duration_ms = int((self._now() - started).total_seconds() * 1000)
            await self.lock.verify_held()
            try:
                await self.history.insert_one({
                    "_id": spec.version, "name": spec.name, "applied_at": self._now(),
                    "duration_ms": duration_ms, "checksum": spec.checksum, "sha": self.sha,
                    "stats": stats or {}, "baselined": False, "repaired": False,
                })
            except DuplicateKeyError:
                # Another runner took the lock over after the re-read above and recorded this
                # version first. Both ran up, so the version is applied, not damaged.
                logger.warning("[MIGRATE] up %d %s: history row already written by another runner",
                               spec.version, spec.name)
        except LockLost:
            raise
        except Exception as e:
            await self._mark_dirty(spec, e, "up")
            logger.exception("[MIGRATE] up %d %s FAILED", spec.version, spec.name)
            raise MigrationFailed(
                f"migration {spec.version} ({spec.name}) failed: {type(e).__name__}: {e}",
                version=spec.version, name=spec.name, cause=str(e),
            ) from e
        logger.info("[MIGRATE] up %d %s done in %dms stats=%s", spec.version, spec.name, duration_ms, stats)
        return {"version": spec.version, "name": spec.name, "duration_ms": duration_ms, "stats": stats or {}}

    async def downgrade(self, *, to_version: int, wait_for_lock: float = 0.0) -> Dict[str, Any]:
        if to_version < 0:
            raise MigrationError("to_version must be >= 0", to_version=to_version)
        async with self.lock.held(wait_for_lock):
            self._require_clean(await self._dirty())
            rows = [r for r in await self._history_rows() if int(r["_id"]) > to_version]
            rows.sort(key=lambda r: int(r["_id"]), reverse=True)
            by_version = {s.version: s for s in self.registry}
            blocked = [int(r["_id"]) for r in rows
                       if by_version.get(int(r["_id"])) is None or by_version[int(r["_id"])].down is None]
            if blocked:
                raise IrreversibleMigration(
                    f"cannot downgrade past versions without down(): {blocked}", versions=blocked,
                )
            reverted: List[Dict[str, Any]] = []
            for row in rows:
                spec = by_version[int(row["_id"])]
                ctx = MigrationContext(db=self.db, version=spec.version, name=spec.name, sha=self.sha, logger=logger)
                logger.info("[MIGRATE] down %d %s", spec.version, spec.name)
                # Written before down runs: a crash or cancellation mid-way leaves the history
                # row in place, and only this marker stops the next upgrade from reading the
                # half-reverted version as applied.
                await self._write_dirty(spec, "down", "downgrade did not finish")
                try:
                    await self.lock.run_step(spec.down, ctx)  # type: ignore[arg-type]
                    await self.lock.verify_held()
                    await self.history.delete_one({"_id": spec.version})
                    await self.lock.verify_held()
                    # Runner-scoped as well: never remove a marker this runner did not write.
                    await self.control.delete_one({"_id": DIRTY_ID, "runner": self.runner_id})
                except LockLost:
                    raise
                except Exception as e:
                    await self._mark_dirty(spec, e, "down")
                    logger.exception("[MIGRATE] down %d %s FAILED", spec.version, spec.name)
                    raise MigrationFailed(
                        f"downgrade of {spec.version} ({spec.name}) failed: {type(e).__name__}: {e}",
                        version=spec.version, name=spec.name, cause=str(e),
                    ) from e
                reverted.append({"version": spec.version, "name": spec.name})
            plan = await self._plan()
            return {"current_version": plan.current, "reverted": reverted}

    async def baseline(self, *, version: int, wait_for_lock: float = 0.0) -> Dict[str, Any]:
        """Record every registry version <= ``version`` as applied without running it.

        For environments whose data already carries the effect of those migrations
        (they were run by hand before this runner existed).
        """
        async with self.lock.held(wait_for_lock):
            self._require_clean(await self._dirty())
            applied = {int(r["_id"]) for r in await self._history_rows()}
            marked: List[int] = []
            for spec in self.registry:
                if spec.version <= version and spec.version not in applied:
                    # Re-read before each row, not once above: a takeover between two
                    # inserts must stop the rest, and only the heartbeat cancels a step.
                    await self.lock.verify_held()
                    await self.history.insert_one({
                        "_id": spec.version, "name": spec.name, "applied_at": self._now(),
                        "duration_ms": 0, "checksum": spec.checksum, "sha": self.sha,
                        "stats": None, "baselined": True, "repaired": False,
                    })
                    marked.append(spec.version)
            plan = await self._plan()
            return {"current_version": plan.current, "baselined": marked}

    async def repair(
        self, *, mark_applied: bool = False, mark_reverted: bool = False, wait_for_lock: float = 0.0,
    ) -> Dict[str, Any]:
        """Clear the dirty flag and re-stamp drifted checksums.

        The flags are for work the operator finished by hand: ``mark_applied``
        records an interrupted upgrade's version as applied, ``mark_reverted``
        drops an interrupted downgrade's version from history; each is refused
        for the other direction. Without a flag the version stays as it stands —
        pending after an upgrade, still applied after a downgrade — and
        re-running that operation finishes it.
        """
        if mark_applied and mark_reverted:
            raise MigrationError("mark_applied and mark_reverted are mutually exclusive")
        async with self.lock.held(wait_for_lock):
            dirty = await self._dirty()
            marked_applied: Optional[int] = None
            marked_reverted: Optional[int] = None
            if dirty:
                if mark_applied:
                    spec = self._dirty_spec(dirty, "mark applied")
                    if dirty.get("direction") == "down":
                        raise MigrationError(
                            f"the dirty marker records an interrupted downgrade of {spec.version}; "
                            "re-run downgrade to finish it, or pass mark_reverted if it was finished by hand",
                            version=spec.version, direction="down",
                        )
                    if await self.history.find_one({"_id": spec.version}) is None:
                        await self.lock.verify_held()
                        await self.history.insert_one({
                            "_id": spec.version, "name": spec.name, "applied_at": self._now(),
                            "duration_ms": 0, "checksum": spec.checksum, "sha": self.sha,
                            "stats": None, "baselined": False, "repaired": True,
                        })
                    marked_applied = spec.version
                elif mark_reverted:
                    spec = self._dirty_spec(dirty, "mark reverted")
                    if dirty.get("direction") != "down":
                        raise MigrationError(
                            f"the dirty marker records an interrupted upgrade of {spec.version}; "
                            "re-run upgrade to finish it, or pass mark_applied if it was finished by hand",
                            version=spec.version, direction=dirty.get("direction"),
                        )
                    await self.lock.verify_held()
                    await self.history.delete_one({"_id": spec.version})
                    marked_reverted = spec.version
                await self.lock.verify_held()
                await self.control.delete_one({"_id": DIRTY_ID})
            plan = await self._plan()
            restamped: List[int] = []
            for mismatch in plan.checksum_mismatches:
                await self.lock.verify_held()
                await self.history.update_one(
                    {"_id": mismatch["version"]}, {"$set": {"checksum": mismatch["current"]}},
                )
                restamped.append(mismatch["version"])
            return {"dirty_cleared": bool(dirty), "marked_applied": marked_applied,
                    "marked_reverted": marked_reverted, "checksums_restamped": restamped,
                    "current_version": plan.current}

    def _dirty_spec(self, dirty: Dict[str, Any], action: str) -> MigrationSpec:
        version = dirty.get("version")
        spec = {s.version: s for s in self.registry}.get(version) if is_version_id(version) else None
        if spec is None:
            raise MigrationError(
                f"dirty version {version!r} is not in the registry; cannot {action}", version=version,
            )
        return spec

    def _report(
        self, plan: Plan, *, applied_now: List[Dict[str, Any]],
        dirty: Optional[Dict[str, Any]], dry_run: bool,
    ) -> Dict[str, Any]:
        return {
            "dry_run": dry_run,
            "current_version": plan.current,
            "head_version": plan.head,
            "applied": applied_now,
            "pending": [_spec_view(s) for s in plan.pending],
            "out_of_order": plan.out_of_order,
            "checksum_mismatches": plan.checksum_mismatches,
            "dirty": _public(dirty),
        }


def _public(doc: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    if not doc:
        return None
    return {k: v for k, v in doc.items() if k != "_id"}


def _spec_view(spec: MigrationSpec) -> Dict[str, Any]:
    return {"version": spec.version, "name": spec.name, "fatal": spec.fatal,
            "reversible": spec.down is not None, "module": spec.module}


def _history_view(row: Dict[str, Any], spec: Optional[MigrationSpec]) -> Dict[str, Any]:
    return {
        "version": int(row["_id"]), "name": row.get("name"), "applied_at": row.get("applied_at"),
        "duration_ms": row.get("duration_ms"), "sha": row.get("sha"), "stats": row.get("stats"),
        "baselined": bool(row.get("baselined")), "repaired": bool(row.get("repaired")),
        "in_registry": spec is not None,
    }


async def run_startup_migrations(
    storage, *, sha: Optional[str] = None, registry: Optional[List[MigrationSpec]] = None,
    migrator: Optional[Migrator] = None,
) -> Optional[Dict[str, Any]]:
    """Boot hook. Upgrades to head, waiting for a concurrent runner.

    Never raises for an ordinary problem — a failed backfill, a dirty database,
    a lock that stayed busy, a migrations package that does not load, a database
    error in the runner's own reads and writes — those are logged at ERROR and
    surfaced by GET /api/admin/migrations. It re-raises only when a FATAL
    migration is known to be pending; a package that does not load or a history
    that cannot be read leaves that unknown (``fatal_pending`` is None, not an
    empty list). An empty environment value counts as unset.
    """
    if (os.getenv("RUN_MIGRATIONS_ON_START") or "true").strip().lower() != "true":
        logger.info("[MIGRATE] startup migrations disabled (RUN_MIGRATIONS_ON_START)")
        return None
    try:
        migrator = migrator or Migrator(storage.db, sha=sha, registry=registry)
    except RegistryError as e:
        logger.exception("[MIGRATE] migrations package did not load; startup migrations skipped: %s detail=%s",
                         e, e.detail)
        return {"error": str(e), "detail": e.detail, "fatal_pending": None}
    raw_wait = os.getenv("MIGRATIONS_LOCK_WAIT_SECONDS") or "300"
    try:
        wait = float(raw_wait)
    except ValueError:
        logger.warning("[MIGRATE] MIGRATIONS_LOCK_WAIT_SECONDS=%r is not a number; using 300", raw_wait)
        wait = 300.0
    try:
        report = await migrator.upgrade(wait_for_lock=wait)
    except Exception as e:
        detail = e.detail if isinstance(e, MigrationError) else {"type": type(e).__name__}
        logger.error("[MIGRATE] startup migrations did not complete: %s detail=%s", e, detail,
                     exc_info=not isinstance(e, MigrationError))
        fatal = await _fatal_pending_or_unknown(migrator)
        if fatal:
            logger.error("[MIGRATE] FATAL migration(s) %s pending — refusing to start", fatal)
            raise
        return {"error": str(e), "detail": detail, "fatal_pending": fatal}
    if report["applied"]:
        logger.info("[MIGRATE] applied %s → version %d",
                    [a["version"] for a in report["applied"]], report["current_version"])
    return report


async def _fatal_pending_or_unknown(migrator: Migrator) -> Optional[List[int]]:
    try:
        return await migrator.fatal_pending()
    except Exception:
        logger.exception("[MIGRATE] migration history unreadable; whether a FATAL migration is pending is unknown")
        return None
