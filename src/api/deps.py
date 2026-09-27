"""
Dependency injection for API routes.

Provides access to global instances initialized during app startup.
"""

from typing import Optional, Any

# Global instances (set during app lifespan startup)
_orchestrator: Optional[Any] = None
_storage: Optional[Any] = None
_event_emitter: Optional[Any] = None
_container_manager: Optional[Any] = None
_deploy_service: Optional[Any] = None
_message_store: Optional[Any] = None
_project_loader: Optional[Any] = None
_artifact_store: Optional[Any] = None
_external_mcp_manager: Optional[Any] = None
_agent_llm_calls_store: Optional[Any] = None


def set_orchestrator(orch):
    global _orchestrator
    _orchestrator = orch


def get_orchestrator():
    return _orchestrator


def set_storage(store):
    global _storage
    _storage = store


def get_storage():
    return _storage


def set_event_emitter(emitter):
    global _event_emitter
    _event_emitter = emitter


def get_event_emitter():
    return _event_emitter


def set_container_manager(cm):
    global _container_manager
    _container_manager = cm


def get_container_manager():
    return _container_manager


def set_deploy_service(ds):
    global _deploy_service
    _deploy_service = ds


def get_deploy_service():
    return _deploy_service


def set_message_store(ms):
    global _message_store
    _message_store = ms


def get_message_store():
    return _message_store


def set_project_loader(pl):
    global _project_loader
    _project_loader = pl


def get_project_loader():
    return _project_loader


def set_artifact_store(ast):
    global _artifact_store
    _artifact_store = ast


def get_artifact_store():
    return _artifact_store


def set_external_mcp_manager(mgr):
    global _external_mcp_manager
    _external_mcp_manager = mgr


def get_external_mcp_manager():
    return _external_mcp_manager


def set_agent_llm_calls_store(store):
    global _agent_llm_calls_store
    _agent_llm_calls_store = store


def get_agent_llm_calls_store():
    return _agent_llm_calls_store
