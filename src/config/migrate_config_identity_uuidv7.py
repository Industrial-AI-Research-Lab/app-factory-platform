#!/usr/bin/env python3
"""One-shot consolidated migration to opaque-UUIDv7 (tenant_id, name) identity.

Supersedes ``migrate_config_identity``, ``migrate_llm_function_names``,
``migrate_path_a_wire_names`` and ``migrate_storage_ids_to_uuidv7``. Runs a
single ordered pass over the four configuration collections and leaves the data
in the shape the runtime assumes — so the legacy id-deriving/parsing helpers can
be retired afterwards:

  1. normalize  — ``name`` = wire name (+ ``rpc_name`` for MCP), schema bare-form
  2. ref-rewrite — allow-lists / workflow ``agent_type`` to bare wire names
  3. dedup       — collapse provably-identical (tenant, wire) duplicates;
                   FAIL LOUD (exit non-zero, no write) on any divergent collision
  4. re-key      — ``_id`` -> opaque UUIDv7 (insert-before-delete, crash-safe)
  5. verify      — assert one doc per (tenant, wire), all ids opaque, no dups

Idempotent: a second run is a no-op. Dry-run is the default; ``--apply`` writes.
NEVER guesses which duplicate to drop from the ``_id`` shape — a duplicate is
collapsed only when the two documents are byte-identical after normalization.
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import os
import re
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import quote_plus

from motor.motor_asyncio import AsyncIOMotorClient
from pymongo.errors import ServerSelectionTimeoutError

from config.configuration_reference_validation import (
    strip_legacy_tenant_prefixed_value,
)
from config.configuration_resolution import (
    agent_wire_name_from_doc,
    is_opaque_storage_id,
    is_wire_configuration_name,
    mint_configuration_storage_id,
)
from config.tool_configuration_schema import normalize_tool_schema_for_storage
from tools.mcp_internal_docs import (
    MCP_SERVER_INTERNAL_SOURCE,
    is_mcp_internal_tool_name,
)
from tools.mcp_llm_function_names import (
    assign_wire_name_to_mcp_doc,
    resolve_server_abbrs,
)
from tools.mcp_tool_ids import mcp_public_tool_id_from_doc

logger = logging.getLogger(__name__)

AGENTS = "agent_configurations"
WORKFLOWS = "workflow_definitions"
BUILTIN_TOOLS = "tool_configurations"
MCP_TOOLS = "tool_mcp_configurations"

# Kinds whose wire name comes from agent_wire_name_from_doc and whose refs are
# rewritten to bare wire names.
KIND_AGENT = "agent"
KIND_WORKFLOW = "workflow"
KIND_BUILTIN_TOOL = "builtin_tool"
KIND_MCP_TOOL = "mcp_tool"

COLLECTION_KINDS = (
    (AGENTS, KIND_AGENT),
    (WORKFLOWS, KIND_WORKFLOW),
    (BUILTIN_TOOLS, KIND_BUILTIN_TOOL),
    (MCP_TOOLS, KIND_MCP_TOOL),
)

# Fields that do NOT participate in semantic identity — two docs equal on every
# other field are the same configuration and may be collapsed losslessly.
IDENTITY_IGNORE_FIELDS = frozenset({
    "_id",
    "tenant_id",
    "name",
    "display_name",
    "cloned_from",
    "llm_function_name",
    "created_at",
    "created_by",
    "updated_at",
    "updated_by",
})

AGENT_REF_STRIP_FIELDS = ("allowed_tools", "allowed_delegation_targets")
AGENT_MCP_REF_FIELD = "allowed_mcp_tools"


@dataclass
class MigrationReport:
    scanned: int = 0
    names_normalized: int = 0
    schemas_normalized: int = 0
    refs_rewritten: int = 0
    refs_unmapped: int = 0
    collapsed: int = 0
    rekeyed: int = 0
    updated_in_place: int = 0
    conflicts: list[str] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)
    internal_mcp_repairs: list[dict[str, Any]] = field(default_factory=list)

    def as_dict(self) -> dict[str, Any]:
        return {
            "scanned": self.scanned,
            "names_normalized": self.names_normalized,
            "schemas_normalized": self.schemas_normalized,
            "refs_rewritten": self.refs_rewritten,
            "refs_unmapped": self.refs_unmapped,
            "collapsed": self.collapsed,
            "rekeyed": self.rekeyed,
            "updated_in_place": self.updated_in_place,
            "conflicts": list(self.conflicts),
            "errors": list(self.errors),
        }


@dataclass
class DocRecord:
    """A loaded document plus its computed target (normalized) form."""

    collection: str
    kind: str
    old_id: str
    tenant_id: str
    wire: str
    original: dict[str, Any]
    desired: dict[str, Any]


def _uri() -> str:
    raw = os.environ["MONGODB_URI"]
    m = re.match(r"mongodb://([^:]+):([^@]+)@(.+)", raw)
    if m:
        return f"mongodb://{m.group(1)}:{quote_plus(m.group(2))}@{m.group(3)}"
    return raw


def _tenant_of(doc: dict[str, Any]) -> str:
    return str(doc.get("tenant_id") or "").strip()


def _sortable_updated_at(doc: dict[str, Any]) -> str:
    """Best-effort comparable timestamp; ISO-ish strings and datetimes sort fine."""
    value = doc.get("updated_at") or doc.get("created_at")
    if isinstance(value, dict):  # Extended-JSON {"$date": "..."}
        value = value.get("$date")
    return str(value or "")


def _semantic_payload(desired: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in desired.items() if k not in IDENTITY_IGNORE_FIELDS}


def _apply_display_name(desired: dict[str, Any], old_name: str, wire: str) -> None:
    """Preserve a human label in display_name when the old name was not a wire id."""
    if desired.get("display_name"):
        return
    label = str(old_name or "").strip()
    if label and label != wire and not is_wire_configuration_name(label):
        desired["display_name"] = label


def _preserve_wire_names_for_doc(
    doc: dict[str, Any],
    *,
    tenant_id: str,
) -> frozenset[str] | None:
    """Preserve wire ids like ``data__loader``; do not block ``{tenant}__`` stripping."""
    from config.configuration_reference_validation import _LEGACY_TENANT_REF_MARKER
    from config.configuration_resolution import is_wire_configuration_name

    preserve: set[str] = set()
    tenant = str(tenant_id or "").strip()
    prefix = f"{tenant}{_LEGACY_TENANT_REF_MARKER}" if tenant else ""
    for key in ("name", "_id"):
        val = str(doc.get(key) or "").strip()
        if (
            val
            and "__" in val
            and is_wire_configuration_name(val)
            and not (prefix and val.startswith(prefix))
        ):
            preserve.add(val)
    return frozenset(preserve) if preserve else None


def _is_internal_mcp_doc(doc: dict[str, Any]) -> bool:
    name = str(doc.get("name") or "").strip()
    rpc = str(doc.get("rpc_name") or "").strip()
    if is_mcp_internal_tool_name(name) or is_mcp_internal_tool_name(rpc):
        return True
    return doc.get("source") == MCP_SERVER_INTERNAL_SOURCE


def _repair_internal_mcp_doc(doc: dict[str, Any]) -> tuple[dict[str, Any], bool]:
    """Restore ZIP wizard row identity: canonical internal name + separate source."""
    desired = dict(doc)
    changed = False
    rpc = str(desired.get("rpc_name") or "").strip()
    name = str(desired.get("name") or "").strip()

    canonical_name: str | None = None
    if is_mcp_internal_tool_name(rpc):
        canonical_name = rpc
    elif is_mcp_internal_tool_name(name):
        canonical_name = name
        if not rpc:
            desired["rpc_name"] = name
            changed = True

    if canonical_name and name != canonical_name:
        desired["name"] = canonical_name
        changed = True

    if desired.get("source") != MCP_SERVER_INTERNAL_SOURCE:
        desired["source"] = MCP_SERVER_INTERNAL_SOURCE
        changed = True

    return desired, changed


# ── load + normalize ────────────────────────────────────────────────────────

def _migration_agent_wire_name(
    doc: dict[str, Any],
    *,
    tenant_id: str,
    preserve_wire_names: frozenset[str] | None = None,
) -> str | None:
    """Derive wire name during one-shot migration (may strip legacy clone prefixes)."""
    tenant = str(tenant_id or "").strip()
    doc_id = str(doc.get("_id") or "").strip()
    if doc_id and tenant:
        stripped = strip_legacy_tenant_prefixed_value(
            doc_id,
            tenant,
            preserve_wire_names=preserve_wire_names,
        )
        if stripped != doc_id and is_wire_configuration_name(stripped):
            return stripped
    return agent_wire_name_from_doc(doc, runtime_tenant_id=tenant_id)


def _normalize_simple(
    doc: dict[str, Any],
    *,
    kind: str,
    report: MigrationReport,
) -> tuple[str, dict[str, Any]] | None:
    """Normalize an agent / workflow / builtin-tool doc. Returns (wire, desired)."""
    tenant = _tenant_of(doc)
    desired = dict(doc)
    if kind == KIND_BUILTIN_TOOL:
        before = dict(desired)
        normalize_tool_schema_for_storage(desired)
        if desired != before:
            report.schemas_normalized += 1
    wire = _migration_agent_wire_name(
        desired,
        tenant_id=tenant,
        preserve_wire_names=_preserve_wire_names_for_doc(desired, tenant_id=tenant),
    )
    if not wire:
        return None
    old_name = str(doc.get("name") or "").strip()
    _apply_display_name(desired, old_name, wire)
    if old_name != wire:
        report.names_normalized += 1
    desired["name"] = wire
    return wire, desired


def _normalize_mcp_tenant(
    docs: list[dict[str, Any]],
    *,
    report: MigrationReport,
) -> list[tuple[str, dict[str, Any]]]:
    """Normalize one tenant's MCP docs, assigning path-A wire names with dedup."""
    existing_names: set[str] = set()
    server_ids = {
        str(d.get("mcp_server") or "").strip()
        for d in docs
        if str(d.get("mcp_server") or "").strip()
    }
    abbr_map = resolve_server_abbrs(server_ids)
    # Deterministic order so wire-name dedup suffixes are stable across runs.
    ordered = sorted(
        docs,
        key=lambda d: (
            str(d.get("mcp_server") or ""),
            str(d.get("rpc_name") or ""),
            str(d.get("name") or ""),
            str(d.get("_id") or ""),
        ),
    )
    out: list[tuple[str, dict[str, Any]]] = []
    for doc in ordered:
        if _is_internal_mcp_doc(doc):
            continue
        desired = dict(doc)
        old_name = str(doc.get("name") or "").strip()
        assign_wire_name_to_mcp_doc(
            desired,
            existing_names=existing_names,
            server_abbr_map=abbr_map,
            preserve_existing=True,
        )
        wire = str(desired.get("name") or "").strip()
        if not wire:
            report.errors.append(
                f"{MCP_TOOLS}: cannot derive wire name for _id={doc.get('_id')}"
            )
            continue
        _apply_display_name(desired, old_name, wire)
        if old_name != wire:
            report.names_normalized += 1
        out.append((wire, desired))
    return out


async def _load_and_normalize(
    db,
    collection: str,
    kind: str,
    report: MigrationReport,
) -> list[DocRecord]:
    raw = [doc async for doc in db[collection].find({})]
    report.scanned += len(raw)
    records: list[DocRecord] = []

    if kind == KIND_MCP_TOOL:
        by_tenant: dict[str, list[dict[str, Any]]] = {}
        for doc in raw:
            if _is_internal_mcp_doc(doc):
                desired, _ = _repair_internal_mcp_doc(doc)
                if desired != doc:
                    report.internal_mcp_repairs.append(desired)
                continue
            by_tenant.setdefault(_tenant_of(doc) or "__root__", []).append(doc)
        # Index original docs by id to pair desired back to its source.
        for tenant, docs in sorted(by_tenant.items()):
            originals = {str(d.get("_id")): d for d in docs}
            for wire, desired in _normalize_mcp_tenant(docs, report=report):
                old_id = str(desired.get("_id") or "")
                records.append(DocRecord(
                    collection=collection,
                    kind=kind,
                    old_id=old_id,
                    tenant_id=tenant,
                    wire=wire,
                    original=originals.get(old_id, desired),
                    desired=desired,
                ))
        return records

    for doc in raw:
        normalized = _normalize_simple(doc, kind=kind, report=report)
        if normalized is None:
            report.errors.append(
                f"{collection}: cannot derive wire name for _id={doc.get('_id')}"
            )
            continue
        wire, desired = normalized
        records.append(DocRecord(
            collection=collection,
            kind=kind,
            old_id=str(doc.get("_id") or ""),
            tenant_id=_tenant_of(doc),
            wire=wire,
            original=doc,
            desired=desired,
        ))
    return records


# ── reference rewrite ─────────────────────────────────────────────────────────

def _build_mcp_public_to_wire(mcp_records: list[DocRecord]) -> dict[str, str]:
    mapping: dict[str, str] = {}
    for rec in mcp_records:
        wire = rec.wire
        if not wire:
            continue
        for key in (
            mcp_public_tool_id_from_doc(rec.original),
            mcp_public_tool_id_from_doc(rec.desired),
            str(rec.original.get("llm_function_name") or "").strip(),
            str(rec.original.get("name") or "").strip(),
        ):
            if key:
                mapping.setdefault(key, wire)
    return mapping


def _rewrite_list_strip(
    values: Any,
    tenant: str,
    preserve: frozenset[str],
    report: MigrationReport,
) -> tuple[list[Any], bool]:
    if not isinstance(values, list):
        return values, False
    out: list[Any] = []
    changed = False
    seen: set[str] = set()
    for ref in values:
        if not isinstance(ref, str) or ref == "*":
            out.append(ref)
            continue
        bare = strip_legacy_tenant_prefixed_value(
            ref, tenant, preserve_wire_names=preserve,
        )
        if bare != ref:
            changed = True
            report.refs_rewritten += 1
        if bare not in seen:
            seen.add(bare)
            out.append(bare)
    return out, changed


def _rewrite_mcp_refs(
    values: Any,
    pub_to_wire: dict[str, str],
    report: MigrationReport,
) -> tuple[list[Any], bool]:
    if not isinstance(values, list):
        return values, False
    out: list[Any] = []
    changed = False
    seen: set[str] = set()
    for ref in values:
        if not isinstance(ref, str) or ref == "*":
            out.append(ref)
            continue
        key = ref.strip()
        wire = pub_to_wire.get(key)
        if wire is None:
            # Already a wire name, or an unknown ref — keep verbatim, never drop.
            if not is_wire_configuration_name(key):
                report.refs_unmapped += 1
            mapped = key
        else:
            mapped = wire
            if wire != key:
                changed = True
                report.refs_rewritten += 1
        if mapped and mapped not in seen:
            seen.add(mapped)
            out.append(mapped)
    return out, changed


def _rewrite_references(
    records_by_collection: dict[str, list[DocRecord]],
    report: MigrationReport,
) -> None:
    mcp_records = records_by_collection.get(MCP_TOOLS, [])
    pub_to_wire = _build_mcp_public_to_wire(mcp_records)
    # Preserve set guards wire ids that legitimately contain "__" from prefix
    # stripping (e.g. an agent named ``data__loader``).
    preserve = frozenset(
        rec.wire
        for coll in (AGENTS, BUILTIN_TOOLS)
        for rec in records_by_collection.get(coll, [])
        if rec.wire
    )

    for rec in records_by_collection.get(AGENTS, []):
        for field_name in AGENT_REF_STRIP_FIELDS:
            new_values, _ = _rewrite_list_strip(
                rec.desired.get(field_name), rec.tenant_id, preserve, report,
            )
            if isinstance(rec.desired.get(field_name), list):
                rec.desired[field_name] = new_values
        mcp_values, _ = _rewrite_mcp_refs(
            rec.desired.get(AGENT_MCP_REF_FIELD), pub_to_wire, report,
        )
        if isinstance(rec.desired.get(AGENT_MCP_REF_FIELD), list):
            rec.desired[AGENT_MCP_REF_FIELD] = mcp_values

    for rec in records_by_collection.get(WORKFLOWS, []):
        nodes = rec.desired.get("nodes")
        if not isinstance(nodes, list):
            continue
        for node in nodes:
            if not isinstance(node, dict):
                continue
            agent_type = node.get("agent_type")
            if not isinstance(agent_type, str) or not agent_type or agent_type == "*":
                continue
            bare = strip_legacy_tenant_prefixed_value(
                agent_type, rec.tenant_id, preserve_wire_names=preserve,
            )
            if bare != agent_type:
                node["agent_type"] = bare
                report.refs_rewritten += 1


# ── grouping, dedup, planning ──────────────────────────────────────────────────

@dataclass
class GroupPlan:
    collection: str
    tenant_id: str
    wire: str
    final_id: str
    survivor: dict[str, Any]
    reuse_existing: bool          # final_id already exists in DB (replace) vs fresh
    delete_ids: list[str]
    is_write: bool                # False when an opaque single doc is unchanged


def _diff_fields(left: dict[str, Any], right: dict[str, Any]) -> list[str]:
    keys = set(left) | set(right)
    return sorted(k for k in keys if left.get(k) != right.get(k))


def _plan_group(
    records: list[DocRecord],
    report: MigrationReport,
) -> GroupPlan | None:
    """Plan one (collection, tenant, wire) group. Returns None on conflict."""
    first = records[0]
    payloads = [_semantic_payload(r.desired) for r in records]
    if any(p != payloads[0] for p in payloads[1:]):
        ids = [r.old_id for r in records]
        # Report the fields that diverge against the first member for triage.
        diffs: set[str] = set()
        for p in payloads[1:]:
            diffs.update(_diff_fields(payloads[0], p))
        report.conflicts.append(
            f"{first.collection} (tenant={first.tenant_id} wire={first.wire}): "
            f"divergent duplicates {ids} differ on {sorted(diffs)}"
        )
        return None

    # Survivor: prefer the doc whose _id is already opaque, then the newest.
    ranked = sorted(
        records,
        key=lambda r: (is_opaque_storage_id(r.old_id), _sortable_updated_at(r.original)),
        reverse=True,
    )
    survivor_rec = ranked[0]
    opaque_existing = next(
        (r.old_id for r in ranked if is_opaque_storage_id(r.old_id)), None
    )
    final_id = opaque_existing or mint_configuration_storage_id()
    reuse_existing = opaque_existing is not None

    survivor = dict(survivor_rec.desired)
    survivor["_id"] = final_id
    delete_ids = [r.old_id for r in records if r.old_id != final_id]

    if len(records) > 1:
        report.collapsed += len(records) - 1
        for r in records:
            if r.old_id != survivor_rec.old_id:
                logger.info(
                    "[COLLAPSE] %s tenant=%s wire=%s drop=%s keep=%s",
                    first.collection, first.tenant_id, first.wire,
                    r.old_id, survivor_rec.old_id,
                )

    is_write = True
    if reuse_existing and not delete_ids:
        # Single doc already at an opaque id — write only if normalization changed it.
        if survivor == survivor_rec.original:
            is_write = False
        else:
            report.updated_in_place += 1
    else:
        report.rekeyed += 1

    return GroupPlan(
        collection=first.collection,
        tenant_id=first.tenant_id,
        wire=first.wire,
        final_id=final_id,
        survivor=survivor,
        reuse_existing=reuse_existing,
        delete_ids=delete_ids,
        is_write=is_write,
    )


def _plan_collection(
    records: list[DocRecord],
    report: MigrationReport,
) -> list[GroupPlan]:
    groups: dict[tuple[str, str], list[DocRecord]] = {}
    for rec in records:
        groups.setdefault((rec.tenant_id, rec.wire), []).append(rec)
    plans: list[GroupPlan] = []
    for _, group in sorted(groups.items()):
        plan = _plan_group(group, report)
        if plan is not None:
            plans.append(plan)
    return plans


def _verify_plans(plans: list[GroupPlan], report: MigrationReport) -> None:
    """Plan-based invariants: one survivor per (tenant, wire); opaque ids; MCP rpc unique."""
    seen_identity: set[tuple[str, str, str]] = set()
    seen_rpc: set[tuple[str, str, str]] = set()
    for plan in plans:
        key = (plan.collection, plan.tenant_id, plan.wire)
        if key in seen_identity:
            report.errors.append(f"verify: duplicate identity survivor {key}")
        seen_identity.add(key)
        if not is_opaque_storage_id(plan.final_id):
            report.errors.append(
                f"verify: non-opaque final _id {plan.final_id} for {key}"
            )
        if plan.collection == MCP_TOOLS:
            rpc = str(plan.survivor.get("rpc_name") or "").strip()
            server = str(plan.survivor.get("mcp_server") or "").strip()
            if rpc and server:
                rkey = (plan.tenant_id, server, rpc)
                if rkey in seen_rpc:
                    report.errors.append(
                        f"verify: duplicate (tenant, mcp_server, rpc_name) {rkey}"
                    )
                seen_rpc.add(rkey)


# ── apply ──────────────────────────────────────────────────────────────────────

async def _apply_internal_mcp_repairs(db, repairs: list[dict[str, Any]]) -> None:
    col = db[MCP_TOOLS]
    for doc in repairs:
        doc_id = doc.get("_id")
        if not doc_id:
            continue
        await col.replace_one({"_id": doc_id}, doc, upsert=True)


async def _drop_identity_unique_indexes(db) -> None:
    """Drop (tenant, name) unique indexes so re-key can briefly coexist; app recreates on start."""
    drops = (
        (AGENTS, "tenant_id_1_name_1"),
        (WORKFLOWS, "tenant_id_1_name_1"),
        (BUILTIN_TOOLS, "tenant_id_1_name_1"),
        (MCP_TOOLS, "tenant_id_1_mcp_name_1"),
        (MCP_TOOLS, "tenant_id_1_mcp_server_1_rpc_name_1"),
    )
    for collection, index_name in drops:
        try:
            await db[collection].drop_index(index_name)
            logger.info("[MIGRATE] dropped index %s on %s", index_name, collection)
        except Exception:
            pass


async def _apply_plan(db, plan: GroupPlan) -> None:
    col = db[plan.collection]
    # Write the survivor FIRST (upsert handles both fresh-uuid insert and
    # replace-in-place) so a crash never loses the document; the unique
    # (tenant, name) index is built only after this migration, so a brief
    # duplicate during re-key cannot raise. Delete the superseded ids after.
    await col.replace_one({"_id": plan.final_id}, plan.survivor, upsert=True)
    for old_id in plan.delete_ids:
        await col.delete_one({"_id": old_id})


async def run(*, apply: bool, database: str) -> int:
    client = AsyncIOMotorClient(_uri(), serverSelectionTimeoutMS=30000)
    db = client[database]
    report = MigrationReport()
    try:
        await client.admin.command("ping")
        logger.info("[MIGRATE] mode=%s db=%s", "APPLY" if apply else "DRY-RUN", database)

        records_by_collection: dict[str, list[DocRecord]] = {}
        for collection, kind in COLLECTION_KINDS:
            records_by_collection[collection] = await _load_and_normalize(
                db, collection, kind, report,
            )

        _rewrite_references(records_by_collection, report)

        all_plans: list[GroupPlan] = []
        for collection, _ in COLLECTION_KINDS:
            all_plans.extend(
                _plan_collection(records_by_collection[collection], report)
            )

        _verify_plans(all_plans, report)

        if report.conflicts:
            logger.error(
                "[MIGRATE] %d unresolved collision(s) — NOT writing. Resolve manually:",
                len(report.conflicts),
            )
            for c in report.conflicts:
                logger.error("  CONFLICT %s", c)
            return 2
        if report.errors:
            logger.error("[MIGRATE] %d error(s) — NOT writing.", len(report.errors))
            for e in report.errors:
                logger.error("  ERROR %s", e)
            return 3

        writes = [p for p in all_plans if p.is_write or p.delete_ids]
        if report.internal_mcp_repairs:
            logger.info(
                "[MIGRATE] %d internal MCP row repair(s) planned.",
                len(report.internal_mcp_repairs),
            )
        if not apply:
            logger.info(
                "[MIGRATE] dry-run: %d write(s) planned "
                "(rekey=%d collapse=%d update_in_place=%d internal_mcp=%d). Re-run with --apply.",
                len(writes),
                report.rekeyed,
                report.collapsed,
                report.updated_in_place,
                len(report.internal_mcp_repairs),
            )
            return 0

        await _drop_identity_unique_indexes(db)
        for plan in writes:
            await _apply_plan(db, plan)
        if report.internal_mcp_repairs:
            await _apply_internal_mcp_repairs(db, report.internal_mcp_repairs)
        logger.info(
            "[MIGRATE] applied %d write(s) + %d internal MCP repair(s).",
            len(writes),
            len(report.internal_mcp_repairs),
        )

        await _verify_database(db, report)
        if report.errors:
            for e in report.errors:
                logger.error("  POST-VERIFY %s", e)
            return 3
        logger.info("[MIGRATE] post-apply verification clean.")
        return 0
    finally:
        client.close()
        logger.info("[MIGRATE] report: %s", report.as_dict())


async def _verify_database(db, report: MigrationReport) -> None:
    """Re-query each collection to confirm no (tenant, name) / rpc duplicates remain."""
    for collection, kind in COLLECTION_KINDS:
        match: dict[str, Any] = {"name": {"$type": "string"}}
        if collection == MCP_TOOLS:
            match["source"] = "mcp_server"
        pipeline = [
            {"$match": match},
            {"$group": {"_id": {"t": "$tenant_id", "n": "$name"}, "c": {"$sum": 1}}},
            {"$match": {"c": {"$gt": 1}}},
        ]
        dups = [d async for d in db[collection].aggregate(pipeline)]
        if dups:
            report.errors.append(f"{collection}: {len(dups)} (tenant,name) dup(s) remain")
        opaque = 0
        total = 0
        async for doc in db[collection].find({}, {"_id": 1, "source": 1, "name": 1}):
            if collection == MCP_TOOLS and _is_internal_mcp_doc(doc):
                continue
            total += 1
            if is_opaque_storage_id(str(doc.get("_id") or "")):
                opaque += 1
        if opaque != total:
            report.errors.append(
                f"{collection}: {total - opaque} non-opaque _id(s) remain"
            )


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    try:
        from dotenv import load_dotenv

        load_dotenv()
    except ImportError:
        pass
    parser = argparse.ArgumentParser(
        description="Consolidated one-shot config identity + UUIDv7 migration.",
    )
    parser.add_argument(
        "--apply", action="store_true", help="Apply changes. Default is dry-run.",
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
        logger.error("[MIGRATE] MongoDB unavailable: %s", exc)
        raise SystemExit(1) from exc


if __name__ == "__main__":
    main()
