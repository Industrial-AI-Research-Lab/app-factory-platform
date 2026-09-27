const TOOL_NODE_TYPES = new Set(['tool', 'tool_call', 'tool_result', 'result'])

function metadataRows(details, selected) {
  return [
    ['Agent', details.agent_display_name || details.agent_name || details.agent_id],
    ['Tool', details.tool_name],
    ['Tool call ID', details.tool_call_id],
    ['Source message', details.source_message_id],
    ['Run', details.run_id],
    ['Task', details.task_id],
    ['Workflow node', details.workflow_node_id],
    ['Sequence', details.sequence],
    ['Created', details.created_at],
    ['Status', details.display_status === 'unknown' ? undefined : details.display_status],
    ['Result recorded', details.result_recorded === true ? 'yes' : undefined],
    ['Correlation', details.correlation || selected.correlation],
  ].filter(([, value]) => value !== undefined && value !== null && value !== '')
}

function PayloadBlock({ label, value }) {
  if (value === undefined || value === null) return null
  return <section className="mt-3">
    <h5 className="text-xs font-semibold uppercase tracking-wide text-slate-300">{label}</h5>
    <pre className="mt-1 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded border border-slate-600 bg-slate-900/70 p-2 text-xs text-slate-200">{typeof value === 'string' ? value : JSON.stringify(value, null, 2)}</pre>
  </section>
}

export default function TraceDetailsPanel({ selected, payloadLoading, onLoadPayload }) {
  if (!selected || !TOOL_NODE_TYPES.has(selected.type)) return null
  const details = selected.details || {}
  const payloads = details.payloads || {}
  const resultPayload = payloads.result ?? details.payload
  const canLoad = Boolean(details.payload_available) && typeof onLoadPayload === 'function'

  return <section className="mt-4 border-t border-slate-700 pt-3" aria-label="Tool metadata">
    <h4 className="text-xs font-semibold uppercase tracking-wide text-amber-300">
      {selected.type === 'tool_result' || selected.type === 'result' ? 'Tool result' : 'Tool call'} details
    </h4>
    <dl className="mt-2 space-y-1 text-xs">
      {metadataRows(details, selected).map(([label, value]) => <div className="flex gap-2" key={label}>
        <dt className="w-28 shrink-0 text-slate-500">{label}</dt>
        <dd className="min-w-0 break-words font-mono text-slate-300">{String(value)}</dd>
      </div>)}
    </dl>
    <button type="button" className="mt-3 rounded bg-blue-700 px-2 py-1 text-xs hover:bg-blue-600 disabled:cursor-not-allowed disabled:opacity-50" disabled={payloadLoading || !canLoad} onClick={onLoadPayload}>
      {payloadLoading ? 'Loading…' : canLoad ? 'Load payload' : 'Payload unavailable'}
    </button>
    <PayloadBlock label="Arguments" value={payloads.arguments} />
    <PayloadBlock label="Result" value={resultPayload} />
  </section>
}
