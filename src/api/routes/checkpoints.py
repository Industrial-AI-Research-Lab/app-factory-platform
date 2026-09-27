"""Checkpoint callback and authenticated journal listing routes."""

import hmac
import logging
import os

from fastapi import APIRouter, Depends, HTTPException, Query, status

from api import deps
from api.auth.tenant_context import TenantContext, get_tenant_context
from api.auth.tenant_guard import load_authorized_project
from schemas.checkpoints import A2ACheckpointConfig, CheckpointPoint
from storage.checkpoint_store import CheckpointConflict, CheckpointStore


logger = logging.getLogger(__name__)
router = APIRouter(tags=["checkpoints"])


def _forbidden() -> HTTPException:
    return HTTPException(status_code=403, detail="Checkpoint callback forbidden")


def _store() -> CheckpointStore:
    storage = deps.get_storage()
    messages = deps.get_message_store()
    if not storage or not messages:
        raise HTTPException(status_code=503, detail="Checkpoint storage unavailable")
    return CheckpointStore(storage, messages)


def _nonce_matches(config: A2ACheckpointConfig, supplied: str) -> bool:
    if not config.enabled or not config.callback_nonce_env:
        return False
    expected = os.getenv(config.callback_nonce_env)
    if not expected:
        return False
    try:
        expected_bytes = expected.encode("ascii")
        supplied_bytes = supplied.encode("ascii")
    except UnicodeEncodeError:
        return False
    allowed = all(chr(char).isalnum() or chr(char) in "-_" for char in expected_bytes)
    return (
        len(expected_bytes) >= 32
        and allowed
        and hmac.compare_digest(expected_bytes, supplied_bytes)
    )


@router.post("/api/checkpoints/{server_id}/{nonce}/points")
async def checkpoint_callback(server_id: str, nonce: str, body: CheckpointPoint):
    storage = deps.get_storage()
    store = _store()
    binding = await store.get_binding(body.run_id)
    if not binding or binding.get("server_id") != server_id:
        raise _forbidden()
    server = await storage.get_a2a_server(server_id, binding.get("tenant_id"))
    try:
        config = A2ACheckpointConfig.model_validate(
            (server or {}).get("checkpoints") or {}
        )
    except ValueError:
        raise _forbidden()
    if not server or not _nonce_matches(config, nonce):
        raise _forbidden()
    project = await storage.load_project(binding["project_id"])
    run = await storage.db.runs.find_one(
        {"run_id": body.run_id, "project_id": binding["project_id"], "deleted_at": None}
    )
    if not project or project.get("tenant_id") != binding.get("tenant_id") or not run:
        raise _forbidden()
    try:
        message, inserted = await store.record_point(
            binding, body.model_dump(mode="json")
        )
    except CheckpointConflict as exc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail=str(exc)
        ) from exc
    point = store._project(message)
    if inserted:
        emitter = deps.get_event_emitter()
        if emitter:
            try:
                await emitter.emit(
                    "checkpoint_saved",
                    body.run_id,
                    {
                        "project_id": binding["project_id"],
                        "server_id": server_id,
                        "point_id": body.point_id,
                        "message_id": message["id"],
                        "number": message["sequence"],
                    },
                )
            except Exception as exc:
                logger.warning(
                    "[CHECKPOINT] project_id=%s run_id=%s point_id=%s — event emission failed after durable insert: %s",
                    binding["project_id"],
                    body.run_id,
                    body.point_id,
                    type(exc).__name__,
                )
    return {"point": point, "duplicate": not inserted}


@router.get("/api/projects/{project_id}/runs/{run_id}/points")
async def list_checkpoint_points(
    project_id: str,
    run_id: str,
    limit: int = Query(100, ge=1, le=1000),
    tenant_ctx: TenantContext = Depends(get_tenant_context),
):
    storage, _ = await load_authorized_project(project_id, tenant_ctx)
    run = await storage.db.runs.find_one(
        {"run_id": run_id, "project_id": project_id, "deleted_at": None}, {"_id": 1}
    )
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")
    return {"points": await _store().list_points(project_id, run_id, limit)}


@router.post("/api/projects/{project_id}/runs/{run_id}/points/{point_id}/restore")
async def restore_checkpoint_point(
    project_id: str,
    run_id: str,
    point_id: str,
    tenant_ctx: TenantContext = Depends(get_tenant_context),
):
    from orchestration.checkpoint_restore import restore_checkpoint
    from storage.checkpoint_restore_store import RestoreError

    _, project = await load_authorized_project(project_id, tenant_ctx)
    orch = deps.get_orchestrator()
    if not orch:
        raise HTTPException(status_code=503, detail="Checkpoint runtime unavailable")
    try:
        return await restore_checkpoint(
            orch, project_id, run_id, point_id, project.get("tenant_id")
        )
    except RestoreError as exc:
        raise HTTPException(
            status_code=exc.status_code, detail={"code": exc.code, "run_id": exc.run_id}
        ) from exc
    except Exception as exc:
        logger.warning(
            "[CHECKPOINT] project_id=%s — restore failed: %s",
            project_id,
            type(exc).__name__,
        )
        from storage.checkpoint_restore_store import CheckpointRestoreStore

        try:
            operation = await CheckpointRestoreStore(orch.storage).get(project_id)
        except Exception:
            operation = None
        raise HTTPException(
            status_code=502,
            detail={
                "code": "checkpoint_restore_unavailable",
                "run_id": (operation or {}).get("run_id"),
            },
        ) from exc
