"""Deployment routes"""

from fastapi import APIRouter, Depends, HTTPException, Request
from api.auth.middleware import require_auth
from api.auth.tenant_context import TenantContext, get_tenant_context
from api.auth.tenant_guard import load_authorized_project
from pydantic import BaseModel
from typing import Optional
import os

from api.deps import get_orchestrator, get_deploy_service

router = APIRouter(tags=["deployments"], dependencies=[Depends(require_auth)])


class DeployRequest(BaseModel):
    deploy_slug: Optional[str] = None
    target_namespace: Optional[str] = None
    cluster_target: Optional[str] = None


class DeployActionRequest(BaseModel):
    cluster_target: Optional[str] = None


@router.post("/api/projects/{project_id}/deploy")
async def deploy_project(
    project_id: str,
    body: DeployRequest,
    tenant_ctx: TenantContext = Depends(get_tenant_context),
):
    """Trigger a local static demo deploy for a project (dev-only)."""
    orchestrator = get_orchestrator()
    deploy_service = get_deploy_service()
    
    if not orchestrator or not deploy_service:
        raise HTTPException(status_code=500, detail="Deploy service not initialized")
    await load_authorized_project(project_id, tenant_ctx)

    if os.getenv("DEPLOY_AGENT_LOCAL_ENABLED", "false").lower() != "true":
        raise HTTPException(status_code=501, detail="Deploy Agent local prototype disabled")

    project = orchestrator.active_projects.get(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    shared_context = project.get("shared_context")
    if not shared_context:
        raise HTTPException(status_code=500, detail="SharedContext not available for project")

    result = await deploy_service.deploy_static_demo_local(
        project_id=project_id,
        shared_context=shared_context,
        deploy_slug=body.deploy_slug,
        target_namespace=body.target_namespace,
        cluster_target=body.cluster_target,
    )

    return {
        "project_id": project_id,
        "deploy_status": result.get("deploy_status") or "failed",
        "deployment": result.get("deployment") or {},
    }


@router.post("/api/admin/deploy/static-demo/prod/{project_id}")
async def deploy_project_static_demo_prod(project_id: str, body: DeployRequest, request: Request):
    """Trigger a prod-capable static demo deploy (admin-only, experimental)."""
    orchestrator = get_orchestrator()
    deploy_service = get_deploy_service()
    
    if not orchestrator or not deploy_service:
        raise HTTPException(status_code=500, detail="Deploy service not initialized")

    if os.getenv("DEPLOY_AGENT_PROD_ENABLED", "false").lower() != "true":
        raise HTTPException(status_code=501, detail="Deploy Agent prod pipeline disabled")

    admin_key = os.getenv("DEPLOY_ADMIN_KEY")
    if not admin_key:
        raise HTTPException(status_code=501, detail="Deploy admin key not configured")

    header_key = request.headers.get("X-Deploy-Admin-Key")
    if header_key != admin_key:
        raise HTTPException(status_code=403, detail="Invalid deploy admin key")

    project = orchestrator.active_projects.get(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    shared_context = project.get("shared_context")
    if not shared_context:
        raise HTTPException(status_code=500, detail="SharedContext not available for project")

    result = await deploy_service.deploy_static_demo_prod(
        project_id=project_id,
        shared_context=shared_context,
        deploy_slug=body.deploy_slug,
        target_namespace=body.target_namespace,
    )

    return {
        "project_id": project_id,
        "deploy_status": result.get("deploy_status") or "failed",
        "deployment": result.get("deployment") or {},
    }


@router.delete("/api/projects/{project_id}/deployments/{deployment_id}")
async def teardown_deployment(
    project_id: str,
    deployment_id: str,
    request: Request,
    tenant_ctx: TenantContext = Depends(get_tenant_context),
):
    """Teardown a local static demo deployment (dev-only)."""
    orchestrator = get_orchestrator()
    deploy_service = get_deploy_service()
    
    if not orchestrator or not deploy_service:
        raise HTTPException(status_code=500, detail="Deploy service not initialized")
    await load_authorized_project(project_id, tenant_ctx)

    if os.getenv("DEPLOY_AGENT_LOCAL_ENABLED", "false").lower() != "true":
        raise HTTPException(status_code=501, detail="Deploy Agent local prototype disabled")

    admin_key = os.getenv("DEPLOY_ADMIN_KEY")
    if not admin_key:
        raise HTTPException(status_code=501, detail="Deploy teardown not configured")

    header_key = request.headers.get("X-Deploy-Admin-Key")
    if header_key != admin_key:
        raise HTTPException(status_code=403, detail="Invalid deploy admin key")

    project = orchestrator.active_projects.get(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    shared_context = project.get("shared_context")
    if not shared_context:
        raise HTTPException(status_code=500, detail="SharedContext not available for project")

    try:
        result = await deploy_service.teardown_deployment_local(
            project_id=project_id,
            shared_context=shared_context,
            deployment_id=deployment_id,
        )
    except ValueError:
        raise HTTPException(status_code=404, detail="Deployment not found")

    return {
        "project_id": project_id,
        "deployment_id": deployment_id,
        "status": result.get("deploy_status") or result.get("deployment", {}).get("status") or "deleted",
        "deployment": result.get("deployment") or {},
    }


@router.post("/api/admin/projects/{project_id}/deployments/{deployment_id}/retry")
async def retry_deployment_prod(project_id: str, deployment_id: str, request: Request, body: DeployActionRequest):
    """Retry a failed prod deployment by redeploying the same image (admin-only)."""
    orchestrator = get_orchestrator()
    deploy_service = get_deploy_service()

    if not orchestrator or not deploy_service:
        raise HTTPException(status_code=500, detail="Deploy service not initialized")

    if os.getenv("DEPLOY_AGENT_PROD_ENABLED", "false").lower() != "true":
        raise HTTPException(status_code=501, detail="Deploy Agent prod pipeline disabled")

    admin_key = os.getenv("DEPLOY_ADMIN_KEY")
    if not admin_key:
        raise HTTPException(status_code=501, detail="Deploy admin key not configured")
    header_key = request.headers.get("X-Deploy-Admin-Key")
    if header_key != admin_key:
        raise HTTPException(status_code=403, detail="Invalid deploy admin key")

    project = orchestrator.active_projects.get(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    shared_context = project.get("shared_context")
    if not shared_context:
        raise HTTPException(status_code=500, detail="SharedContext not available for project")

    try:
        result = await deploy_service.retry_deployment_prod(
            project_id=project_id,
            shared_context=shared_context,
            deployment_id=deployment_id,
        )
    except ValueError:
        raise HTTPException(status_code=404, detail="Deployment not found")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    return {
        "project_id": project_id,
        "deploy_status": (result.get("deploy_status") or "failed"),
        "deployment": result.get("deployment") or {},
    }


@router.post("/api/admin/projects/{project_id}/deployments/{deployment_id}/rollback")
async def rollback_deployment_prod(project_id: str, deployment_id: str, request: Request, body: DeployActionRequest):
    """Rollback to a previous successful prod deployment by redeploying its image (admin-only)."""
    orchestrator = get_orchestrator()
    deploy_service = get_deploy_service()

    if not orchestrator or not deploy_service:
        raise HTTPException(status_code=500, detail="Deploy service not initialized")

    if os.getenv("DEPLOY_AGENT_PROD_ENABLED", "false").lower() != "true":
        raise HTTPException(status_code=501, detail="Deploy Agent prod pipeline disabled")

    admin_key = os.getenv("DEPLOY_ADMIN_KEY")
    if not admin_key:
        raise HTTPException(status_code=501, detail="Deploy admin key not configured")
    header_key = request.headers.get("X-Deploy-Admin-Key")
    if header_key != admin_key:
        raise HTTPException(status_code=403, detail="Invalid deploy admin key")

    project = orchestrator.active_projects.get(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    shared_context = project.get("shared_context")
    if not shared_context:
        raise HTTPException(status_code=500, detail="SharedContext not available for project")

    try:
        result = await deploy_service.rollback_deployment_prod(
            project_id=project_id,
            shared_context=shared_context,
            target_deployment_id=deployment_id,
        )
    except ValueError:
        raise HTTPException(status_code=404, detail="Deployment not found")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    return {
        "project_id": project_id,
        "deploy_status": (result.get("deploy_status") or "failed"),
        "deployment": result.get("deployment") or {},
    }


@router.delete("/api/admin/deploy/static-demo/prod/{project_id}/deployments/{deployment_id}")
async def teardown_deployment_prod(project_id: str, deployment_id: str, request: Request):
    """Teardown a prod static demo deployment (admin-only)."""
    orchestrator = get_orchestrator()
    deploy_service = get_deploy_service()
    
    if not orchestrator or not deploy_service:
        raise HTTPException(status_code=500, detail="Deploy service not initialized")

    if os.getenv("DEPLOY_AGENT_PROD_ENABLED", "false").lower() != "true":
        raise HTTPException(status_code=501, detail="Deploy Agent prod pipeline disabled")

    admin_key = os.getenv("DEPLOY_ADMIN_KEY")
    if not admin_key:
        raise HTTPException(status_code=501, detail="Deploy admin key not configured")

    header_key = request.headers.get("X-Deploy-Admin-Key")
    if header_key != admin_key:
        raise HTTPException(status_code=403, detail="Invalid deploy admin key")

    project = orchestrator.active_projects.get(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    shared_context = project.get("shared_context")
    if not shared_context:
        raise HTTPException(status_code=500, detail="SharedContext not available for project")

    try:
        result = await deploy_service.teardown_deployment_prod(
            project_id=project_id,
            shared_context=shared_context,
            deployment_id=deployment_id,
        )
    except ValueError:
        raise HTTPException(status_code=404, detail="Deployment not found")
    except RuntimeError as e:
        raise HTTPException(status_code=501, detail=str(e))

    return {
        "project_id": project_id,
        "deployment_id": deployment_id,
        "status": result.get("deploy_status") or result.get("deployment", {}).get("status") or "deleted",
        "deployment": result.get("deployment") or {},
    }


@router.get("/api/projects/{project_id}/deployments")
async def list_deployments(
    project_id: str,
    tenant_ctx: TenantContext = Depends(get_tenant_context),
):
    """List all deployments for a project."""
    orchestrator = get_orchestrator()
    storage, _ = await load_authorized_project(project_id, tenant_ctx)
    
    if not orchestrator:
        raise HTTPException(status_code=500, detail="Orchestrator not initialized")

    project = orchestrator.active_projects.get(project_id)
    if project:
        shared_context = project.get("shared_context")
        if not shared_context:
            raise HTTPException(status_code=500, detail="SharedContext not available for project")
        return {
            "project_id": project_id,
            "deploy_status": shared_context.get("deploy_status", "not_started"),
            "deployments": shared_context.get("deployments", []),
        }

    if storage:
        ctx = await storage.load_context(project_id)
        if ctx is not None:
            return {
                "project_id": project_id,
                "deploy_status": ctx.get("deploy_status", "not_started"),
                "deployments": ctx.get("deployments", []),
            }

    raise HTTPException(status_code=404, detail="Project not found")


@router.get("/api/projects/{project_id}/deployments/{deployment_id}")
async def get_deployment(
    project_id: str,
    deployment_id: str,
    tenant_ctx: TenantContext = Depends(get_tenant_context),
):
    """Fetch a single deployment for a project."""
    orchestrator = get_orchestrator()
    storage, _ = await load_authorized_project(project_id, tenant_ctx)
    
    if not orchestrator:
        raise HTTPException(status_code=500, detail="Orchestrator not initialized")

    project = orchestrator.active_projects.get(project_id)
    if project:
        shared_context = project.get("shared_context")
        if not shared_context:
            raise HTTPException(status_code=500, detail="SharedContext not available for project")
        deployments = shared_context.get("deployments", [])
        for d in deployments:
            if isinstance(d, dict) and d.get("deployment_id") == deployment_id:
                return {"project_id": project_id, "deployment": d}

    if storage:
        ctx = await storage.load_context(project_id)
        if ctx is not None:
            deployments = ctx.get("deployments", []) or []
            for d in deployments:
                if isinstance(d, dict) and d.get("deployment_id") == deployment_id:
                    return {"project_id": project_id, "deployment": d}

    raise HTTPException(status_code=404, detail="Deployment not found")
