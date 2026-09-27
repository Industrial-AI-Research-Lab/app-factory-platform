import logging
import os
from urllib.parse import urlsplit

from pydantic import HttpUrl

from telemetry.run_context import _extract_span_context
from telemetry.tracer import get_tracer


logger = logging.getLogger(__name__)


def with_trace_link(run: dict, base_url: str | None) -> dict:
    result = {**run, "trace_id": None, "trace_url": None}
    telemetry = result.pop("telemetry", None)
    if base_url is None:
        return result
    try:
        traceparent = (
            telemetry.get("traceparent") if isinstance(telemetry, dict) else None
        )
        if not isinstance(traceparent, str):
            raise ValueError("Missing trace context")
        context = _extract_span_context(traceparent)
    except (ImportError, ValueError):
        logger.warning(
            "[OTEL_LINK] project_id=%s run_id=%s - saved trace context unavailable",
            run.get("project_id"),
            run.get("run_id"),
        )
        return result
    trace_id = f"{context.trace_id:032x}"
    result.update(trace_id=trace_id, trace_url=f"{base_url}/trace/{trace_id}")
    return result


def public_jaeger_url() -> str | None:
    tracer = get_tracer()
    if not tracer.enabled or tracer.tracer is None:
        logger.warning("[OTEL_LINK] status=disabled - runtime tracing unavailable")
        return None
    value = os.getenv("JAEGER_UI_URL", "").strip()
    if not value:
        logger.warning("[OTEL_LINK] status=unconfigured - public Jaeger UI URL missing")
        return None
    try:
        if "\\" in value or any(
            c.isspace() or ord(c) < 32 or ord(c) == 127 for c in value
        ):
            raise ValueError("Invalid URL characters")
        parts = urlsplit(value)
        url = HttpUrl(value)
        if (
            parts.username is not None
            or parts.password is not None
            or url.query is not None
            or url.fragment is not None
        ):
            raise ValueError("Credentials, query and fragment are not supported")
    except ValueError:
        logger.warning("[OTEL_LINK] status=invalid - public Jaeger UI URL rejected")
        return None
    return str(url).rstrip("/")
