from __future__ import annotations

from typing import Any, Dict, List, Optional
import json
import logging
import os
import uuid

from fastapi import HTTPException

from llm.agent_model_params import resolve_tenant_default_model
from api.research_followup import collection_followup_scope
from api.research_followup_answer import build_followup_payload
from schemas import ApprovalSchema, TaskSchema
from schemas.event_schema import EventSchema
from storage.checkpoint_restore_store import RestoreError
from storage.message_store import TOOL_LEDGER_TYPES
from telemetry.run_scope import run_trace_scope
from telemetry.tracer import create_task_with_context

logger = logging.getLogger(__name__)


def _postrun_chat_max_steps() -> int:
    """Tool-loop budget cap for the post-run follow-up chat.

    A completed project's chat can call write tools freely, so the cap bounds
    runaway tool loops. Overridable via POST_RUN_CHAT_MAX_STEPS; a missing or
    non-positive value falls back to the default.
    """
    try:
        value = int(os.getenv("POST_RUN_CHAT_MAX_STEPS", "12"))
        return value if value > 0 else 12
    except (TypeError, ValueError):
        return 12


def _short_json(value: Any, limit: int = 2000) -> str:
    try:
        text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, default=str)
    except Exception:
        text = str(value)
    return text[:limit]


def _build_followup_context(shared_context) -> str:
    """Last-phase project context for the follow-up chat.

    Beyond the code files the old toolless path showed: the requirements and
    plan (so the assistant knows the brief), plus a listing of every artifact's
    path + type (so non-code deliverables like geojson are visible, not just
    `code_file`). Best-effort — any read failure yields an empty section.
    """
    if not shared_context:
        return ""
    parts: List[str] = []
    try:
        requirements = shared_context.get("requirements")
        if requirements:
            parts.append("### Requirements\n" + _short_json(requirements))
        plan = shared_context.get("plan")
        if plan:
            parts.append("### Plan\n" + _short_json(plan))
        artifacts = shared_context.get("artifacts") or []
        if artifacts:
            listing = "\n".join(
                f"- {a.get('path', 'unknown')} ({a.get('type', 'artifact')})" for a in artifacts
            )
            parts.append("### Project artifacts\n" + listing[:2000])
            code_files = [a for a in artifacts if a.get("type") == "code_file" and a.get("content")]
            for cf in code_files[:5]:
                parts.append(f"### {cf.get('path', 'unknown')}\n```\n{cf.get('content', '')[:8000]}\n```")
    except Exception:
        logger.warning("[POSTRUN_CHAT] context build failed — continuing without it", exc_info=True)
    return "\n\n".join(parts)


async def _sync_and_reseed_output_approval(
    *, orchestrator, message_store, project_id: str, proj: Dict[str, Any],
    shared_context, execution_result: Dict[str, Any],
) -> Optional[List[Dict[str, Any]]]:
    """Push sandbox edits back to the repo, refresh artifacts, and reopen the
    output approval so the user re-approves a changed deliverable.

    Shared by the ad-hoc coding task and the write-capable follow-up chat: both
    mutate a completed project's sandbox and must re-request `output` approval
    (superseding any pending one). Returns the refreshed artifacts for the
    caller's assistant message, or None if the refresh failed.
    """
    try:
        await orchestrator._sync_container_to_repo(project_id)
    except Exception as e:
        logger.warning("[ADHOC] sync_container_to_repo failed project_id=%s err=%s", project_id, str(e))

    refreshed_artifacts = None
    try:
        refreshed_artifacts = await orchestrator._prepare_final_artifacts(project_id, proj, shared_context)
    except Exception as e:
        logger.warning("[ADHOC] refresh_artifacts failed project_id=%s err=%s", project_id, str(e))

    try:
        if refreshed_artifacts is not None and getattr(orchestrator, "approvals", None):
            try:
                await message_store.supersede_pending_approval(project_id, "output")
                # Clear in-memory pending approvals of type output. Read via
                # ApprovalSchema.get_type — entries are written under `gate_type`
                # (schema) or `type` (legacy writers), never `approval_type`.
                to_remove = [
                    aid for aid, a in orchestrator.approvals.pending_approvals.items()
                    if a.get("project_id") == project_id and ApprovalSchema.get_type(a) == "output"
                ]
                for aid in to_remove:
                    del orchestrator.approvals.pending_approvals[aid]
            except Exception:
                pass

            await orchestrator.approvals.request_approval(
                project_id,
                "output",
                {"artifacts": refreshed_artifacts, "execution_result": execution_result},
                run_id=proj.get("run_id"),
            )
    except Exception as e:
        logger.warning("[ADHOC] reseed_output_approval failed project_id=%s err=%s", project_id, str(e))
    return refreshed_artifacts


async def route_user_message(
        *,
        project_id: str,
        content: str,
        message: Dict[str, Any],
        classification: Dict[str, Any],
        run_id: Optional[str],
        message_store,
        event_emitter,
        orchestrator,
        tenant_id: Optional[str] = None,
) -> Dict[str, Any]:
    intent = (classification.get("intent") or "general").lower()
    agent = classification.get("agent")

    # Determine pending approval from DB (single source of truth)
    pending_approval_type = None
    pending_approval_id = None
    try:
        db_approvals = await message_store.get_pending_approvals_for_project(project_id, limit=1)
        if db_approvals:
            db_approval = db_approvals[0] or {}
            pending_approval_type = db_approval.get("subtype") or db_approval.get("type")
            pending_approval_id = (db_approval.get("data") or {}).get("approval_id")
    except Exception:
        pass

    # Route to refinement for approval-related intents. The classifier in
    # `orchestration/intent_classifier.py` now receives the workflow
    # definition and pending-approval context, so it returns intent=feedback
    # directly for messages like "single task please" during a pending gate
    # — no escalation needed in the happy path. The escalation below stays
    # as a safety net for cases where the classifier still labels obvious
    # feedback as `general` (LLM mistakes happen; treat the pending gate as
    # the strongest signal).
    #
    # The approval_type comes from the workflow's approval_gate node and can
    # be ANY string defined by the workflow author — never check it against
    # a hardcoded set like {"plan","requirements"}; truthiness is enough.
    #
    # Stage 2 follow-up (separate change): `refine_approval` in
    # `api/routes/approvals.py:262` still dispatches via hardcoded
    # `if approval_type == "plan" / elif == "requirements"` and will need
    # a generic agent lookup. Until then, refinement of other gate types
    # will fail at that layer rather than here.
    refinement_intents = {"approval", "feedback", "refine"}
    if pending_approval_type and intent == "general":
        logger.info(
            "[INTENT] safety-net escalating intent=general -> feedback during pending %s approval %s",
            pending_approval_type, pending_approval_id,
        )
        intent = "feedback"
        classification = {**classification, "intent": "feedback", "_escalated_from": "general"}
    if pending_approval_type and intent in refinement_intents:
        # Call the tenant-free core directly. Calling `refine_approval` (the
        # HTTP route) from here used to silently die: its `tenant_ctx`
        # defaulted to a `fastapi.params.Depends` instance (FastAPI's DI
        # only resolves Depends on HTTP entry, not on direct Python calls),
        # and `verify_project_tenant.is_root` raised AttributeError. The
        # `except Exception: pass` below ate every trace. See the contract
        # block on `_refine_approval_core` in approvals.py for the full
        # story. Authorization for project_id was already enforced upstream
        # in `messages.send_message` via `load_authorized_project`.
        from api.routes.approvals import _refine_approval_core
        logger.info(
            "[REFINE] dispatching feedback project=%s approval_type=%r approval_id=%s",
            project_id, pending_approval_type, pending_approval_id,
        )
        try:
            result = await _refine_approval_core(
                project_id=project_id,
                approval_type=pending_approval_type,
                feedback=content,
                approval_id_hint=pending_approval_id,
                feedback_already_persisted=True,
            )
            return {
                "routed_to": f"refine/{pending_approval_type}",
                "intent": classification,
                "message": message,
                "result": result,
            }
        except HTTPException:
            # Propagate well-typed errors to the HTTP layer rather than
            # swallowing — they already carry actionable status + detail.
            raise
        except Exception as exc:
            # Loud, NOT silent. The previous `except Exception: pass` was
            # the second half of the structural bug that hid the
            # tenant_ctx AttributeError described in
            # `_refine_approval_core`. If something does fail here in
            # future, the user gets a chat-visible error AND the backend
            # gets a full traceback in logs.
            logger.exception(
                "[REFINE] _refine_approval_core failed project=%s approval_type=%r",
                project_id, pending_approval_type,
            )
            return {
                "message": message,
                "intent": classification,
                "error": f"Refinement failed: {type(exc).__name__}: {exc}",
            }

    # Revert intent: revert to latest user message
    if intent == "revert" and orchestrator:
        async def _do_revert():
            try:
                proj = orchestrator.active_projects.get(project_id)
                if not proj:
                    await orchestrator.projects.load_project_to_active(project_id, orchestrator.agent_pool)
                await orchestrator.revert_to_latest_user_message(project_id)
            except RestoreError as exc:
                logger.warning(
                    "[REVERT] project_id=%s run_id=%s restore_run_id=%s code=%s — chat revert rejected",
                    project_id,
                    run_id,
                    exc.run_id,
                    exc.code,
                )
            except Exception as exc:
                logger.warning(
                    "[REVERT] project_id=%s run_id=%s error_type=%s — chat revert failed",
                    project_id,
                    run_id,
                    type(exc).__name__,
                )

        revert_coroutine = _do_revert()
        try:
            create_task_with_context(revert_coroutine)
        except Exception as exc:
            revert_coroutine.close()
            logger.warning(
                "[REVERT] project_id=%s run_id=%s error_type=%s — chat revert scheduling failed",
                project_id,
                run_id,
                type(exc).__name__,
            )
        return {"message": message, "intent": classification, "routed_to": "revert/latest_user_message"}

    # Deploy intent: request deploy approval
    if intent == "deploy" and orchestrator:
        async def _do_seed_deploy():
            try:
                proj = orchestrator.active_projects.get(project_id)
                if not proj:
                    proj = await orchestrator.projects.load_project_to_active(project_id, orchestrator.agent_pool)
                if not proj:
                    return
                await orchestrator._seed_deploy_approval(project_id, proj)
            except Exception:
                pass

        try:
            create_task_with_context(_do_seed_deploy())
        except Exception:
            pass
        return {"message": message, "intent": classification, "routed_to": "deploy/request_approval"}

    # Question and general intents: answer via LLM and append assistant
    # message. Routing `general` here (instead of letting it fall through to
    # the no-op default at the end) means vague messages like "single task"
    # get a conversational reply that can disambiguate into a clearer follow-
    # up. Verified missing on project 61476d91-...: classifier returned
    # intent=general, route_user_message hit the no-side-effects default, and
    # the user's message sat silently in the store with no acknowledgement.
    if intent in {"question", "general"} and orchestrator and getattr(orchestrator, "llm_client", None):
        async def _emit_answer(answer: str, extra: Optional[Dict[str, Any]] = None) -> None:
            metadata = {"intent": intent, "in_reply_to": message.get("id")}
            if extra:
                metadata.update(extra)
            msg = await message_store.append_assistant_message(
                project_id=project_id,
                content=answer,
                run_id=run_id,
                phase="general",
                metadata=metadata,
            )
            if event_emitter:
                await event_emitter.emit("message_appended", run_id, {"project_id": project_id, "message": msg})

        async def _answer_toolless(shared_context, system_prompt, msgs) -> None:
            # No loaded project (reload failed) → resolve the tenant's default
            # instead of a hardcoded gpt-5-mini, which is banned on some tenants.
            if shared_context:
                model = shared_context.get_model("question_handler")
            else:
                model, _ = await resolve_tenant_default_model(orchestrator.storage, tenant_id)
            resp = await orchestrator.llm_client.chat_completion(
                messages=[{"role": "system", "content": system_prompt}, *msgs[-20:]],
                model=model,
                temperature=0,
            )
            answer = (
                resp.get("content") if isinstance(resp, dict) else str(resp)
            ) or ""
            await _emit_answer(answer.strip() or "I couldn't produce an answer.")

        async def _answer_with_tools(
            proj, shared_context, agents, system_prompt, msgs, scope=None
        ) -> bool:
            union = sorted(
                {
                    t
                    for a in agents
                    for t in (getattr(a, "_effective_allowed_tools", None) or [])
                }
            )
            options = {}
            if scope is not None:
                union = sorted(scope["constraints"])
                options["tool_argument_constraints"] = scope["constraints"]
            result = await agents[0].answer_followup(
                [{"role": "system", "content": system_prompt}, *msgs[-20:]],
                allowed_tool_ids=union,
                max_steps=_postrun_chat_max_steps(),
                **options,
            )
            if not result.get("had_tools"):
                return False  # tool-less project → let the plain-completion path answer
            if result.get("wrote"):
                await _sync_and_reseed_output_approval(
                    orchestrator=orchestrator,
                    message_store=message_store,
                    project_id=project_id,
                    proj=proj,
                    shared_context=shared_context,
                    execution_result={"followup_chat": True},
                )
            answer = (result.get("content") or "").strip() or "I couldn't produce an answer."
            payload = None
            has_collection_scope = scope is not None and isinstance(scope.get("collection_sha256"), str)
            if has_collection_scope:
                payload = build_followup_payload(content, answer, scope.get("collection_sha256"), result.get("tool_results"))
            if payload is None:
                if has_collection_scope:
                    logger.warning(
                        "[POSTRUN_CHAT] project_id=%s tool_results=%s — no ok query result, plain answer",
                        project_id,
                        len(result.get("tool_results") or []),
                    )
                await _emit_answer(answer)
            else:
                await _emit_answer(
                    json.dumps(payload, ensure_ascii=False),
                    extra={"task_type": "knowledge_collection_followup", "collection_sha256": payload["collection_sha256"]},
                )
            return True

        async def _do_answer():
            try:
                # The newest 50 conversation messages, NOT the last 50
                # sequence numbers: the ledger burns sequences at tool speed
                # (two per call), so a latest_seq-minus-50 window goes empty
                # exactly when the agent has been busy with tools — answers
                # would silently lose all conversation memory.
                history = await message_store.get_messages(
                    project_id, run_id=run_id, limit=50,
                    exclude_types=list(TOOL_LEDGER_TYPES), tail=True,
                )

                msgs = []
                for m in history:
                    t = (m.get("type") or "").lower()
                    if t not in {"user", "assistant"}:
                        continue
                    role = "user" if t == "user" else "assistant"
                    msgs.append({"role": role, "content": m.get("content") or ""})

                msgs.append({"role": "user", "content": content})

                # Reload an evicted project so the follow-up chat can use the
                # project's tools (Prostor/BlocksNet/archive) instead of a
                # toolless single shot — a completed run stays active, so load
                # succeeds post-run. Loud on failure, then degrade to toolless.
                proj = orchestrator.active_projects.get(project_id)
                if not proj:
                    try:
                        proj = await orchestrator.projects.load_project_to_active(
                            project_id, orchestrator.agent_pool
                        )
                    except Exception:
                        logger.exception("[POSTRUN_CHAT] reload failed project_id=%s", project_id)
                        proj = None

                shared_context = proj.get("shared_context") if proj else None
                agents = (proj.get("agents") or []) if proj else []

                if intent == "question":
                    base_prompt = "Answer the user's question concisely and accurately based on the project context."
                else:
                    # general: conversational reply. When ANY approval gate is
                    # pending (workflow-defined — could be "plan",
                    # "requirements", "output", or anything else), point the
                    # model at it so a vague message gets surfaced as "did
                    # you want me to revise the pending X?" — the user's
                    # yes/no then classifies cleanly into approval / feedback
                    # on the next turn. Type name comes from the workflow's
                    # `approval_gate` node, not a hardcoded set.
                    gate_hint = ""
                    if pending_approval_type:
                        gate_hint = (
                            f" A '{pending_approval_type}' approval is currently pending. "
                            "If the user's message looks like feedback on it, acknowledge "
                            f"that and ask whether they want the pending {pending_approval_type} "
                            "revised with that feedback."
                        )
                    base_prompt = (
                        "Respond conversationally to the user. If their message is "
                        "ambiguous, ask one short clarifying question." + gate_hint
                    )
                context_text = _build_followup_context(shared_context)
                system_prompt = base_prompt + (f"\n\nProject context:\n{context_text}" if context_text else "")

                scope = await collection_followup_scope(
                    shared_context, agents, project_id=project_id
                )
                if scope is not None:
                    system_prompt = base_prompt + "\n\n" + scope["prompt"]
                    agents = [scope["agent"]] if scope["agent"] is not None else []

                answered = False
                if proj and shared_context and agents:
                    try:
                        async with run_trace_scope(
                            orchestrator.storage,
                            orchestrator.tracer,
                            project_id,
                            proj.get("run_id"),
                        ):
                            answered = await _answer_with_tools(
                                proj, shared_context, agents, system_prompt, msgs, scope
                            )
                    except Exception:
                        logger.exception(
                            "[POSTRUN_CHAT] tool answer failed project_id=%s",
                            project_id,
                        )

                if not answered:
                    await _answer_toolless(shared_context, system_prompt, msgs)
            except Exception:
                logger.exception(
                    "[POSTRUN_CHAT] answer failed project_id=%s", project_id
                )

        try:
            create_task_with_context(_do_answer())
        except Exception:
            pass
        return {"message": message, "intent": classification, "routed_to": "llm/answer"}

    # Agent routing for cross-phase requests
    if orchestrator and (intent == "code_change" or agent in {"coding", "planner", "qa"}):
        async def _run_agent_task_in_run(proj):
            try:
                shared_context = proj.get("shared_context")
                agents = proj.get("agents") or orchestrator.agent_pool
                token = proj.get("token")

                selected = agent
                if intent == "code_change" and not selected:
                    selected = "coding"

                if selected == "planner":
                    await orchestrator.phases.run_phase(
                        project_id,
                        "planning",
                        "User requested plan update",
                        agents,
                        token,
                        lambda: orchestrator._is_cancelled(project_id),
                    )
                    try:
                        # Supersede any existing pending plan approval before requesting new one
                        # This prevents duplicate prevention from returning the OLD approval
                        await message_store.supersede_pending_approval(project_id, "plan")
                        # Clear in-memory pending approvals of type plan. Read via
                        # ApprovalSchema.get_type — entries are written under
                        # `gate_type` (schema) or `type` (legacy hand-rolled
                        # writers in approvals.py), never `approval_type`.
                        to_remove = [
                            aid for aid, a in orchestrator.approvals.pending_approvals.items()
                            if a.get("project_id") == project_id and ApprovalSchema.get_type(a) == "plan"
                        ]
                        for aid in to_remove:
                            del orchestrator.approvals.pending_approvals[aid]

                        plan_data = shared_context.get("plan") if shared_context else None
                        await orchestrator.approvals.request_approval(
                            project_id,
                            "plan",
                            plan_data or {},
                            run_id=proj.get("run_id"),
                        )
                    except Exception:
                        pass
                    return

                task_type = "coding" if selected == "coding" else "qa"
                task = TaskSchema.create(
                    task_id=str(uuid.uuid4()),
                    project_id=project_id,
                    task_type=task_type,
                    description=content,
                )

                # Emit event so UI shows agent is working. Prior code referenced
                # a non-existent EventType symbol inside the try block — the
                # ImportError fell into except Exception and the task_assigned
                # signal never reached SSE on any planner-routed message.
                try:
                    await event_emitter.emit(
                        EventSchema.TASK_ASSIGNED,
                        proj.get("run_id"),
                        {
                            "project_id": project_id,
                            "task_id": task.get("task_id"),
                            "task_type": task_type,
                            "agent": f"{task_type}_agent",
                            "description": content[:200],
                        },
                    )
                except Exception:
                    logger.exception(
                        "[INTENT_ROUTER] task_assigned emit failed project_id=%s task_id=%s",
                        project_id, task.get("task_id"),
                    )

                task_result = await orchestrator.tasks.execute_single_task(
                    project_id,
                    task,
                    shared_context,
                    agents,
                    token,
                    lambda: orchestrator._is_cancelled(project_id),
                )

                refreshed_artifacts = await _sync_and_reseed_output_approval(
                    orchestrator=orchestrator,
                    message_store=message_store,
                    project_id=project_id,
                    proj=proj,
                    shared_context=shared_context,
                    execution_result={"adhoc_task": task_result},
                )

                # Append an assistant message so user gets feedback that work finished
                try:
                    changed_paths = []
                    if isinstance(refreshed_artifacts, list):
                        for art in refreshed_artifacts:
                            p = (art.get("path") or "").strip()
                            if p:
                                changed_paths.append(p)
                    changed_paths = changed_paths[:10]
                    summary = classification.get("summary") or content
                    assistant_text = f"Completed: {summary.strip()}"
                    if changed_paths:
                        assistant_text += "\n\nUpdated files:\n" + "\n".join(changed_paths)

                    msg = await message_store.append_assistant_message(
                        project_id=project_id,
                        content=assistant_text,
                        run_id=run_id,
                        phase="execution",
                        metadata={
                            "intent": "code_change",
                            "task_id": task.get("task_id"),
                            "task_result": task_result.get("status") if isinstance(task_result, dict) else None,
                        },
                    )
                    if event_emitter:
                        await event_emitter.emit("message_appended", proj.get("run_id"), {"project_id": project_id, "message": msg})
                except Exception as e:
                    logger.error(f"[ADHOC] assistant message failed: {e}")
            except Exception as e:
                logger.error(f"[ADHOC] _run_agent_task failed project_id={project_id}: {e}", exc_info=True)

        async def _run_agent_task():
            try:
                proj = orchestrator.active_projects.get(project_id)
                if not proj:
                    proj = await orchestrator.projects.load_project_to_active(
                        project_id, orchestrator.agent_pool
                    )
                if not proj:
                    logger.warning(
                        "[ADHOC] project_id=%s reason=project_missing — skipping task",
                        project_id,
                    )
                    return
                async with run_trace_scope(
                    orchestrator.storage,
                    orchestrator.tracer,
                    project_id,
                    proj.get("run_id"),
                ):
                    await _run_agent_task_in_run(proj)
            except Exception:
                logger.exception("[ADHOC] task setup failed project_id=%s", project_id)

        try:
            create_task_with_context(_run_agent_task())
        except Exception:
            pass

        return {
            "message": message,
            "intent": classification,
            "routed_to": f"agent/{agent or 'coding'}",
        }

    # Default: no side effects
    return {"message": message, "intent": classification, "pending_approval_id": pending_approval_id}
