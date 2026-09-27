import { Handle, Position } from 'reactflow'
import { Activity, AlertTriangle, Bot, CheckCircle2, ClipboardCheck, GitBranch, Inbox, Send, Wrench } from 'lucide-react'
import { invocationCountBadges } from './traceViewModel'

const ICONS = {
  blue: Bot,
  emerald: CheckCircle2,
  violet: GitBranch,
  amber: Wrench,
  sky: ClipboardCheck,
  orange: ClipboardCheck,
  rose: AlertTriangle,
  slate: Inbox,
}

const STATUS_CLASSES = {
  completed: 'bg-emerald-400/20 text-emerald-200 border-emerald-400/30',
  running: 'bg-cyan-400/20 text-cyan-200 border-cyan-400/30',
  failed: 'bg-rose-400/20 text-rose-200 border-rose-400/30',
  requested: 'bg-amber-400/20 text-amber-200 border-amber-400/30',
  unknown: 'bg-slate-400/20 text-slate-200 border-slate-400/30',
}

export default function TraceNode({ data }) {
  const Icon = ['result', 'output'].includes(data.trace.type) ? Send : (ICONS[data.palette] || Activity)
  const countBadges = invocationCountBadges(data.counts)
  return <div aria-label={data.label} className={`min-w-[188px] max-w-[250px] rounded-lg border shadow-lg ${data.paletteClass} ${data.active ? 'ring-2 ring-cyan-300 ring-offset-2 ring-offset-slate-900' : ''} ${data.searchActive ? 'ring-4 ring-cyan-200 ring-offset-2 ring-offset-slate-950 shadow-cyan-400/60' : ''} ${data.searchMatch && !data.searchActive ? 'ring-2 ring-cyan-400/70 ring-offset-1 ring-offset-slate-900' : ''}`}>
    <Handle id="tree-target" type="target" position={Position.Top} className="!bg-slate-400 !border-slate-900" />
    <Handle id="return-target" type="target" position={Position.Right} style={{ top: '28%' }} className="!bg-violet-400 !border-slate-900" />
    <div className="flex gap-2 p-2.5">
      <span className={`mt-0.5 h-7 w-1 shrink-0 rounded-full ${data.accentClass}`} />
      <div className="min-w-0 flex-1">
        <div className="flex items-start gap-1.5">
          <Icon className="h-4 w-4 shrink-0 opacity-90" />
          <span className="truncate text-xs font-semibold" title={data.primary}>{data.primary}</span>
        </div>
        {data.action && <div className="mt-1 truncate font-mono text-[11px] opacity-85" title={data.action}>{data.action}</div>}
        {countBadges.length > 0 && <div className="mt-1.5 flex gap-1 text-[10px] font-medium opacity-90">
          {countBadges.map(badge => <span key={badge.kind} className={badge.kind === 'llm'
            ? 'rounded border border-sky-300/30 bg-sky-400/15 px-1.5 py-0.5 text-sky-100'
            : 'rounded border border-amber-300/30 bg-amber-400/15 px-1.5 py-0.5 text-amber-100'}>{badge.label}</span>)}
        </div>}
        {data.status && data.status !== 'unknown' && <span className={`mt-2 inline-flex rounded border px-1.5 py-0.5 text-[10px] font-medium ${STATUS_CLASSES[data.status] || ''}`}>{data.status}</span>}
      </div>
    </div>
    <Handle id="tree-source" type="source" position={Position.Bottom} className="!bg-slate-400 !border-slate-900" />
    <Handle id="return-source" type="source" position={Position.Right} style={{ top: '72%' }} className="!bg-violet-400 !border-slate-900" />
  </div>
}
