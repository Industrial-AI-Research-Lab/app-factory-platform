"""What a migration module declares, how the package is discovered, and the
pure plan of what ``upgrade`` would do. No I/O beyond importing the modules."""
from __future__ import annotations

import hashlib
import importlib
import inspect
import logging
import pkgutil
import re
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Dict, List, Optional

MIGRATIONS_PACKAGE = "config.migrations"
MODULE_NAME_RE = re.compile(r"^m(\d{4})_[a-z0-9_]+$")


class MigrationError(Exception):
    """Base for every failure the runner reports; ``detail`` is JSON-serialisable."""

    def __init__(self, message: str, **detail: Any):
        super().__init__(message)
        self.detail = detail


class RegistryError(MigrationError):
    """The migrations package is malformed (duplicate/mismatched versions, bad module)."""


class LockBusy(MigrationError):
    """Another runner holds the lock and it did not free up within the wait."""


class LockLost(MigrationError):
    """The lock passed to another runner mid-run; the step was cancelled and nothing more was written."""


class DirtyDatabase(MigrationError):
    """A previous migration failed; ``repair`` is required before anything runs."""


class ValidationFailed(MigrationError):
    """An applied migration's source no longer matches the checksum recorded at apply time."""


class OutOfOrder(MigrationError):
    """A pending version is lower than the current version."""


class MigrationFailed(MigrationError):
    """A migration step or its history write failed; inspect the dirty marker before retrying."""


class IrreversibleMigration(MigrationError):
    """``downgrade`` would cross a migration without ``down``."""


@dataclass
class MigrationContext:
    db: Any
    version: int
    name: str
    sha: Optional[str]
    logger: logging.Logger


UpFn = Callable[[MigrationContext], Awaitable[Optional[Dict[str, Any]]]]


@dataclass(frozen=True)
class MigrationSpec:
    version: int
    name: str
    up: UpFn
    down: Optional[UpFn]
    fatal: bool
    checksum: str
    module: str


def _checksum(module, includes) -> str:
    digest = hashlib.sha256(inspect.getsource(module).encode("utf-8"))
    for included in includes:
        digest.update(inspect.getsource(included).encode("utf-8"))
    return digest.hexdigest()


def load_registry(package: Optional[str] = None) -> List[MigrationSpec]:
    """Import every migration module in ``package`` and return them sorted by version.

    Strict on purpose: a module that does not fit the naming rule or whose VERSION
    disagrees with its filename is an error, not a silent skip — a skipped
    migration is a lost migration.
    """
    if package is None:
        package = MIGRATIONS_PACKAGE
    try:
        pkg = importlib.import_module(package)
    except Exception as e:
        raise RegistryError(
            f"{package}: package import failed: {type(e).__name__}: {e}", package=package,
        ) from e
    if not hasattr(pkg, "__path__"):
        raise RegistryError(f"{package} is a module, not a package", package=package)
    specs: List[MigrationSpec] = []
    for info in pkgutil.iter_modules(pkg.__path__):
        match = MODULE_NAME_RE.match(info.name)
        if not match:
            raise RegistryError(
                f"{package}.{info.name}: migration modules must be named m<NNNN>_<slug>",
                module=info.name,
            )
        try:
            module = importlib.import_module(f"{package}.{info.name}")
        except Exception as e:
            raise RegistryError(
                f"{package}.{info.name}: import failed: {type(e).__name__}: {e}", module=info.name,
            ) from e
        version = getattr(module, "VERSION", None)
        if not isinstance(version, int) or isinstance(version, bool) or version < 1:
            raise RegistryError(f"{module.__name__}: VERSION must be a positive int", module=info.name)
        if version != int(match.group(1)):
            raise RegistryError(
                f"{module.__name__}: VERSION={version} but filename says {int(match.group(1))}",
                module=info.name,
            )
        name = getattr(module, "NAME", None)
        if not isinstance(name, str) or not name:
            raise RegistryError(f"{module.__name__}: NAME must be a non-empty str", module=info.name)
        up = getattr(module, "up", None)
        if not inspect.iscoroutinefunction(up):
            raise RegistryError(f"{module.__name__}: up must be `async def up(ctx)`", module=info.name)
        down = getattr(module, "down", None)
        if down is not None and not inspect.iscoroutinefunction(down):
            raise RegistryError(f"{module.__name__}: down must be `async def down(ctx)`", module=info.name)
        includes = getattr(module, "CHECKSUM_INCLUDES", ())
        if not isinstance(includes, (tuple, list)) or not all(inspect.ismodule(dep) for dep in includes):
            raise RegistryError(
                f"{module.__name__}: CHECKSUM_INCLUDES must be a tuple of imported modules", module=info.name,
            )
        try:
            checksum = _checksum(module, includes)
        except (OSError, TypeError) as e:
            raise RegistryError(
                f"{module.__name__}: cannot read source for the checksum: {e}", module=info.name,
            ) from e
        specs.append(MigrationSpec(
            version=version, name=name, up=up, down=down,
            fatal=bool(getattr(module, "FATAL", False)),
            checksum=checksum, module=module.__name__,
        ))
    specs.sort(key=lambda s: s.version)
    seen_versions: Dict[int, str] = {}
    seen_names: Dict[str, int] = {}
    for spec in specs:
        if spec.version in seen_versions:
            raise RegistryError(
                f"duplicate VERSION {spec.version}: {seen_versions[spec.version]} and {spec.module}",
                version=spec.version,
            )
        if spec.name in seen_names:
            raise RegistryError(f"duplicate NAME {spec.name!r}", name=spec.name)
        seen_versions[spec.version] = spec.module
        seen_names[spec.name] = spec.version
    return specs


@dataclass
class Plan:
    current: int
    head: int
    applied: List[int]
    pending: List[MigrationSpec]
    out_of_order: List[int]
    checksum_mismatches: List[Dict[str, Any]] = field(default_factory=list)
    unknown_applied: List[int] = field(default_factory=list)


def is_version_id(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def plan_upgrade(
    registry: List[MigrationSpec], history: List[Dict[str, Any]], *, target: Optional[int] = None,
) -> Plan:
    """Pure: what ``upgrade`` would do given the registry and the history rows.

    Rows whose ``_id`` is not an int were not written by this runner and are
    ignored here; ``status`` lists them as foreign.
    """
    applied_rows = {row["_id"]: row for row in history if is_version_id(row.get("_id"))}
    applied = sorted(applied_rows)
    current = applied[-1] if applied else 0
    by_version = {s.version: s for s in registry}
    head = registry[-1].version if registry else 0

    mismatches = []
    for version, row in applied_rows.items():
        spec = by_version.get(version)
        stored = row.get("checksum")
        if spec is not None and stored and stored != spec.checksum:
            mismatches.append({"version": version, "name": spec.name,
                               "applied": stored, "current": spec.checksum})

    pending = [
        s for s in registry
        if s.version not in applied_rows and (target is None or s.version <= target)
    ]
    return Plan(
        current=current, head=head, applied=applied, pending=pending,
        out_of_order=[s.version for s in pending if s.version < current],
        checksum_mismatches=sorted(mismatches, key=lambda m: m["version"]),
        unknown_applied=[v for v in applied if v not in by_version],
    )
