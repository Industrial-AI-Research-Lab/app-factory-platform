"""Health check routes"""

from fastapi import APIRouter
import logging

from api.deps import get_storage, get_container_manager, get_orchestrator
from sandbox.host_cli import run_host_cli
from pymongo.errors import ServerSelectionTimeoutError, OperationFailure

router = APIRouter(tags=["health"])

# Health details logging flag
HEALTH_DETAILS_LOG_ENABLED = False


def set_health_logging(enabled: bool):
    global HEALTH_DETAILS_LOG_ENABLED
    HEALTH_DETAILS_LOG_ENABLED = enabled


@router.get("/")
async def root():
    """Health check"""
    orchestrator = get_orchestrator()
    return {
        "status": "running",
        "version": "0.1.0",
        "agents": len(orchestrator.agent_pool) if orchestrator else 0
    }


@router.get("/api/health")
async def api_health():
    """Lightweight API health endpoint for UI probes."""
    return {"status": "ok"}


@router.get("/api/health/details")
async def api_health_details():
    """Detailed health for API, MongoDB, and Container-Use."""
    storage = get_storage()
    container_manager = get_container_manager()
    
    api = {"status": "up"}

    mongodb_status = {"status": "down", "error": None}
    try:
        if storage and getattr(storage, "client", None):
            await storage.client.admin.command("ping")
            mongodb_status = {"status": "up", "error": None}
        else:
            mongodb_status = {"status": "down", "error": "Storage not initialized"}
    except (OperationFailure, ServerSelectionTimeoutError) as e:
        mongodb_status = {"status": "down", "error": str(e)}
    except Exception as e:
        mongodb_status = {"status": "down", "error": str(e)}

    container = {
        "enabled": bool(container_manager.enabled) if container_manager else False,
        "status": "down",
        "cli_path": container_manager.cli_path if container_manager else None,
        "version": None,
        "exit_code": None,
        "error": None,
    }
    try:
        if container_manager and container_manager.enabled:
            candidates = [container_manager.cli_path]
            if container_manager.cli_path != "/opt/cu/cu":
                candidates.append("/opt/cu/cu")
            if container_manager.cli_path != "cu":
                candidates.append("cu")
            res = None
            chosen = None
            for c in candidates:
                r = await run_host_cli([c, "--version"])
                if res is None:
                    res = r
                if r.get("exit_code") == 0:
                    res = r
                    chosen = c
                    break
            if chosen:
                container["cli_path"] = chosen
            container["exit_code"] = res.get("exit_code") if res else None
            container["version"] = (res.get("stdout") or "").strip() or None
            container["error"] = (res.get("stderr") or "").strip() or None
            container["status"] = "up" if res and res.get("exit_code") == 0 else "down"
        elif container_manager and not container_manager.enabled:
            container["status"] = "disabled"
        else:
            container["status"] = "down"
            container["error"] = "Container manager not initialized"
    except Exception as e:
        container["status"] = "down"
        container["error"] = str(e)

    return {
        "api": api,
        "mongodb": mongodb_status,
        "container_use": container,
    }


@router.post("/api/health/logging/enable")
async def enable_health_logging():
    """Enable console access logging for /api/health/details."""
    set_health_logging(True)
    logging.info("[HEALTH] details logging ENABLED")
    return {"status": "enabled"}


@router.post("/api/health/logging/disable")
async def disable_health_logging():
    """Disable console access logging for /api/health/details."""
    set_health_logging(False)
    logging.info("[HEALTH] details logging DISABLED")
    return {"status": "disabled"}
