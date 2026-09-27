"""API Routes"""

from .health import router as health_router
from .projects import router as projects_router
from .approvals import router as approvals_router
from .control import router as control_router
from .runs import router as runs_router
from .run_configurations import router as run_configurations_router
from .deployments import router as deployments_router
from .events import router as events_router
from .admin import router as admin_router
from .messages import router as messages_router
from .settings import router as settings_router
from .agent_configurations import router as agent_configurations_router
from .workflow_definitions import router as workflow_definitions_router
from .configuration_phases import router as configuration_phases_router
from .tool_configurations import router as tool_configurations_router
from .agents import router as agents_router
from .tool_configurations import mcp_router as mcp_tool_configurations_router
from .config_bundle import router as config_bundle_router
from .agent_llm_calls import router as agent_llm_calls_router
from .execution_trace import router as execution_trace_router
from .a2a_configurations import router as a2a_configurations_router
from .checkpoints import router as checkpoints_router
from .human_input import router as human_input_router
from .a2a_human_input import router as a2a_human_input_router
from .archive import router as archive_router
from .file_attachments import router as file_attachments_router
from .tenant_artifacts import router as tenant_artifacts_router

__all__ = [
    "health_router",
    "projects_router",
    "approvals_router",
    "control_router",
    "runs_router",
    "run_configurations_router",
    "deployments_router",
    "events_router",
    "admin_router",
    "messages_router",
    "settings_router",
    "agent_configurations_router",
    "workflow_definitions_router",
    "configuration_phases_router",
    "tool_configurations_router",
    "agents_router",
    "mcp_tool_configurations_router",
    "config_bundle_router",
    "agent_llm_calls_router",
    "execution_trace_router",
    "a2a_configurations_router",
    "checkpoints_router",
    "human_input_router",
    "a2a_human_input_router",
    "archive_router",
    "file_attachments_router",
    "tenant_artifacts_router",
]
