"""One global lock document serialising migration runners across processes.

Acquire is a single atomic upsert: the filter admits a free lock, one whose
holder never beat, or one whose heartbeat is older than ``stale_after``. When the
document exists but the filter rejects it, the upsert collides on ``_id`` and
the acquire loses. A held lock is kept alive by a heartbeat task, so a crashed
runner's lock goes stale instead of blocking forever — and a holder whose
heartbeat stops matching, or goes unconfirmed for the whole stale window, may
already have been taken over: it cancels the running step and raises LockLost
instead of writing anything more.
"""
from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager, suppress
from datetime import datetime, timedelta, timezone
from typing import Any, Awaitable, Callable, Dict, Optional

from pymongo import ReturnDocument
from pymongo.errors import DuplicateKeyError

from config.migration_registry import LockBusy, LockLost

logger = logging.getLogger(__name__)

LOCK_ID = "lock"
DEFAULT_LOCK_STALE_AFTER = timedelta(seconds=120)
DEFAULT_HEARTBEAT_INTERVAL = 10.0
DEFAULT_LOCK_POLL_INTERVAL = 2.0


class MigrationLock:
    def __init__(
        self, control, *, holder: str,
        now_fn: Callable[[], datetime],
        sleep_fn: Callable[[float], Awaitable[None]],
        stale_after: timedelta = DEFAULT_LOCK_STALE_AFTER,
        heartbeat_interval: float = DEFAULT_HEARTBEAT_INTERVAL,
        poll_interval: float = DEFAULT_LOCK_POLL_INTERVAL,
    ):
        self.control = control
        self.holder = holder
        self._now = now_fn
        self._sleep = sleep_fn
        self._stale_after = stale_after
        self._heartbeat_interval = heartbeat_interval
        self._poll = poll_interval
        self._lost: Optional[str] = None
        self._step: Optional[asyncio.Task] = None
        self._confirmed_at: Optional[datetime] = None

    async def current(self) -> Optional[Dict[str, Any]]:
        return await self.control.find_one({"_id": LOCK_ID})

    def view(self, lock: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
        if not lock or not lock.get("holder"):
            return None
        heartbeat = lock.get("heartbeat_at")
        stale = heartbeat is None or _as_utc(heartbeat) < self._now() - self._stale_after
        return {"holder": lock["holder"], "acquired_at": lock.get("acquired_at"),
                "heartbeat_at": heartbeat, "stale": stale}

    async def try_acquire(self) -> bool:
        now = self._now()
        try:
            doc = await self.control.find_one_and_update(
                {"_id": LOCK_ID, "$or": [
                    {"holder": None},
                    {"heartbeat_at": None},  # a held lock that never beat is not alive
                    {"heartbeat_at": {"$lt": now - self._stale_after}},
                ]},
                {"$set": {"holder": self.holder, "acquired_at": now, "heartbeat_at": now}},
                upsert=True, return_document=ReturnDocument.AFTER,
            )
        except DuplicateKeyError:
            # Filter matched nothing (held, fresh) and the upsert collided on _id.
            return False
        if not doc or doc.get("holder") != self.holder:
            return False
        self._lost, self._confirmed_at = None, now
        return True

    async def acquire(self, wait: float) -> None:
        deadline = self._now() + timedelta(seconds=max(wait, 0.0))
        while True:
            if await self.try_acquire():
                return
            if self._now() >= deadline:
                raise LockBusy("another migration runner holds the lock",
                               lock=self.view(await self.current()), waited_seconds=wait)
            await self._sleep(self._poll)

    async def release(self) -> None:
        await self.control.update_one(
            {"_id": LOCK_ID, "holder": self.holder},
            {"$set": {"holder": None, "released_at": self._now()}},
        )

    async def verify_held(self) -> None:
        """Read the lock back; call before any write that must come from the holder."""
        if self._lost is None:
            doc = await self.current()
            if doc and doc.get("holder") == self.holder:
                self._confirmed_at = self._now()
                return
            self._mark_lost(f"the lock is held by {doc.get('holder') if doc else None!r}, not this runner")
        raise LockLost(f"lock lost: {self._lost}; this runner stopped and wrote nothing more", holder=self.holder)

    async def run_step(self, fn, *args):
        """Run a migration step as a task the heartbeat can cancel once the lock is lost."""
        await self.verify_held()
        self._step = asyncio.create_task(fn(*args))
        try:
            return await self._step
        except asyncio.CancelledError:
            if self._lost is None:
                raise
            raise LockLost(f"lock lost: {self._lost}; the step was cancelled and nothing was written",
                           holder=self.holder) from None
        finally:
            self._step = None

    def _mark_lost(self, why: str) -> None:
        self._lost = why
        logger.error("[MIGRATE] lock holder=%s lost: %s — stopping this runner", self.holder, why)
        if self._step is not None and not self._step.done():
            self._step.cancel()

    async def _heartbeat_loop(self) -> None:
        while True:
            await self._sleep(self._heartbeat_interval)
            try:
                result = await self.control.update_one(
                    {"_id": LOCK_ID, "holder": self.holder},
                    {"$set": {"heartbeat_at": self._now()}},
                )
            except Exception as e:  # the watchdog enforces the lease if beats keep failing or hang
                logger.warning("[MIGRATE] lock heartbeat failed: %s", e)
                continue
            if result.matched_count == 0:
                self._mark_lost("the lock document no longer names this runner as holder")
                return
            self._confirmed_at = self._now()

    async def _lease_watchdog(self) -> None:
        # Runs beside the heartbeat so a heartbeat write that hangs — a Motor call with no
        # socketTimeoutMS during a partition — cannot keep the step writing under a lease that
        # has already elapsed: this watches the clock, not the DB, so it fires even mid-write.
        while self._lost is None:
            await self._sleep(self._poll)
            if self._now() - self._confirmed_at >= self._stale_after:
                self._mark_lost("no heartbeat was confirmed for the whole stale window, "
                                "so another runner may have taken the lock")
                return

    @asynccontextmanager
    async def held(self, wait: float):
        await self.acquire(wait)
        tasks = [asyncio.create_task(self._heartbeat_loop()),
                 asyncio.create_task(self._lease_watchdog())]
        try:
            yield
        finally:
            for task in tasks:
                task.cancel()
            for task in tasks:
                with suppress(asyncio.CancelledError):
                    await task
            await self.release()


def _as_utc(value: datetime) -> datetime:
    # PyMongo hands dates back naive unless the client is tz_aware; what it stored is UTC.
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value
