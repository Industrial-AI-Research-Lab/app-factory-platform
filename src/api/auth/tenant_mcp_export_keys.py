"""
MCP cursor-json-http export API keys in tenant_settings (bcrypt hash only).

Keys belong to the tenant (not the user). Multiple named keys per tenant.
Audit: created_by user id on each row.

Key format: syn_mcp_<key_id>_<secret>
"""

from __future__ import annotations

import logging
import re
import secrets
from datetime import datetime, timezone
from typing import Any

from api.auth.utils import hash_password, verify_password

logger = logging.getLogger(__name__)

MCP_EXPORT_KEY_PREFIX = "syn_mcp_"
KEY_ID_LEN = 12
_PARSE_KEY_RE = re.compile(rf"^{re.escape(MCP_EXPORT_KEY_PREFIX)}([a-zA-Z0-9]{{12}})_(.+)$")
SETTINGS_FIELD = "mcp_export_api_keys"
DEFAULT_SCOPE = "config:mcp:read"


class DuplicateMcpExportKeyNameError(ValueError):
    """Raised when the tenant already has an export key with this name."""


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _generate_key_id() -> str:
    alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
    return "".join(secrets.choice(alphabet) for _ in range(KEY_ID_LEN))


def parse_mcp_export_api_key(raw: str) -> tuple[str, str] | None:
    s = (raw or "").strip()
    m = _PARSE_KEY_RE.match(s)
    if not m:
        return None
    key_id, _secret = m.group(1), m.group(2)
    if not _secret:
        return None
    return key_id, s


def build_mcp_export_api_key(key_id: str, secret: str) -> str:
    return f"{MCP_EXPORT_KEY_PREFIX}{key_id}_{secret}"


def _entries_from_settings(settings: dict | None) -> list[dict]:
    if not isinstance(settings, dict):
        return []
    rows = settings.get(SETTINGS_FIELD)
    if not isinstance(rows, list):
        return []
    return [r for r in rows if isinstance(r, dict) and r.get("id")]


def _find_entry(entries: list[dict], key_id: str) -> dict | None:
    for row in entries:
        if str(row.get("id") or "") == key_id:
            return row
    return None


def _normalize_name(name: str) -> str:
    return (name or "mcp-export").strip() or "mcp-export"


def export_key_metadata(entry: dict | None) -> dict | None:
    if not isinstance(entry, dict) or not entry.get("id"):
        return None
    return {
        "id": entry.get("id"),
        "name": entry.get("name"),
        "scopes": entry.get("scopes") or [DEFAULT_SCOPE],
        "enabled": bool(entry.get("enabled", True)),
        "created_at": entry.get("created_at"),
        "created_by": entry.get("created_by"),
        "last_used_at": entry.get("last_used_at"),
    }


async def find_tenant_settings_for_export_key(storage, key_id: str) -> dict | None:
    if not key_id:
        return None
    if hasattr(storage, "find_tenant_settings_by_mcp_export_key_id"):
        return await storage.find_tenant_settings_by_mcp_export_key_id(key_id)
    if hasattr(storage, "_tenant_settings"):
        for doc in storage._tenant_settings:
            if _find_entry(_entries_from_settings(doc), key_id):
                return doc
    return None


async def verify_mcp_export_api_key(storage, provided: str) -> tuple[str, dict] | None:
    """Verify export key; return (tenant_id, key_entry) or None."""
    parsed = parse_mcp_export_api_key(provided)
    if not parsed:
        return None
    key_id, full_key = parsed
    settings_doc = await find_tenant_settings_for_export_key(storage, key_id)
    if not settings_doc:
        return None
    entry = _find_entry(_entries_from_settings(settings_doc), key_id)
    if not entry or not entry.get("enabled", True):
        return None
    key_hash = str(entry.get("key_hash") or "")
    if not key_hash or not verify_password(full_key, key_hash):
        return None
    tenant_id = str(settings_doc.get("_id") or "")
    if not tenant_id:
        return None
    last_used_at = _now_iso()
    if hasattr(storage, "touch_tenant_mcp_export_api_key_last_used"):
        try:
            touched = await storage.touch_tenant_mcp_export_api_key_last_used(
                tenant_id,
                key_id,
                last_used_at,
                actor_id="mcp-export-key",
            )
            if touched:
                entry["last_used_at"] = last_used_at
            else:
                logger.warning(
                    "[AUTH] [MCP_EXPORT] last_used_at not updated (key missing?) "
                    "tenant_id=%s key_id=%s",
                    tenant_id,
                    key_id,
                )
        except Exception as e:
            logger.warning(
                "[AUTH] [MCP_EXPORT] last_used_at touch failed tenant_id=%s key_id=%s: %s",
                tenant_id,
                key_id,
                e,
            )
    else:
        entry["last_used_at"] = last_used_at
    return tenant_id, entry


async def create_mcp_export_api_key(
    storage,
    *,
    tenant_id: str,
    name: str,
    created_by: str,
) -> dict[str, Any]:
    settings = await storage.get_tenant_settings(tenant_id) or {"_id": tenant_id}
    entries = _entries_from_settings(settings)
    norm_name = _normalize_name(name)
    if any(_normalize_name(e.get("name", "")).lower() == norm_name.lower() for e in entries):
        raise DuplicateMcpExportKeyNameError(
            f"Export key name '{norm_name}' already exists for this tenant"
        )

    key_id = _generate_key_id()
    while _find_entry(entries, key_id):
        key_id = _generate_key_id()

    secret = secrets.token_urlsafe(32)
    full_key = build_mcp_export_api_key(key_id, secret)
    row = {
        "id": key_id,
        "name": norm_name,
        "key_hash": hash_password(full_key),
        "scopes": [DEFAULT_SCOPE],
        "enabled": True,
        "created_at": _now_iso(),
        "created_by": created_by,
        "last_used_at": None,
    }
    if hasattr(storage, "push_tenant_mcp_export_api_key"):
        await storage.push_tenant_mcp_export_api_key(
            tenant_id, row, actor_id=created_by
        )
        key_count = len(_entries_from_settings(await storage.get_tenant_settings(tenant_id)))
    else:
        entries.append(row)
        settings[SETTINGS_FIELD] = entries
        await storage.save_tenant_settings(settings, actor_id=created_by)
        key_count = len(entries)
    logger.info(
        "[AUTH] [MCP_EXPORT] created tenant_id=%s key_id=%s name=%s created_by=%s count=%d",
        tenant_id,
        key_id,
        norm_name,
        created_by,
        key_count,
    )
    return {
        "id": key_id,
        "name": row["name"],
        "api_key": full_key,
        "tenant_id": tenant_id,
        "scopes": list(row["scopes"]),
        "created_at": row["created_at"],
    }


def list_mcp_export_api_keys(settings: dict | None) -> list[dict]:
    return [
        meta
        for entry in _entries_from_settings(settings)
        if (meta := export_key_metadata(entry))
    ]


async def revoke_mcp_export_api_key(
    storage,
    *,
    tenant_id: str,
    key_id: str,
    actor_id: str,
) -> bool:
    settings = await storage.get_tenant_settings(tenant_id)
    if not settings:
        return False
    if not _find_entry(_entries_from_settings(settings), key_id):
        return False
    if hasattr(storage, "pull_tenant_mcp_export_api_key"):
        revoked = await storage.pull_tenant_mcp_export_api_key(
            tenant_id, key_id, actor_id=actor_id
        )
    else:
        kept = [
            e
            for e in _entries_from_settings(settings)
            if str(e.get("id") or "") != key_id
        ]
        settings[SETTINGS_FIELD] = kept
        await storage.save_tenant_settings(settings, actor_id=actor_id)
        revoked = True
    if not revoked:
        return False
    remaining = len(
        _entries_from_settings(await storage.get_tenant_settings(tenant_id))
    )
    logger.info(
        "[AUTH] [MCP_EXPORT] revoked tenant_id=%s key_id=%s remaining=%d",
        tenant_id,
        key_id,
        remaining,
    )
    return True
