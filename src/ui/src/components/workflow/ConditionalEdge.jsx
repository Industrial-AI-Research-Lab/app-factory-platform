import { memo } from 'react'
import { getBezierPath, EdgeLabelRenderer } from 'reactflow'

const EDGE_STYLES = {
  approved: { stroke: '#22c55e', strokeDasharray: 'none', label: 'approved', labelBg: '#166534' },
  rejected: { stroke: '#ef4444', strokeDasharray: '6 3', label: 'rejected', labelBg: '#991b1b' },
  default:  { stroke: '#64748b', strokeDasharray: 'none', label: '', labelBg: '#334155' },
}

function ConditionalEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  markerEnd,
  selected,
}) {
  const condition = data?.condition || 'default'
  const style = EDGE_STYLES[condition] || EDGE_STYLES.default

  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  })

  return (
    <>
      <path
        id={id}
        className="react-flow__edge-path"
        d={edgePath}
        markerEnd={markerEnd}
        style={{
          stroke: selected ? '#fff' : style.stroke,
          strokeWidth: selected ? 2.5 : 2,
          strokeDasharray: style.strokeDasharray,
          transition: 'stroke 0.2s',
        }}
      />
      {style.label && (
        <EdgeLabelRenderer>
          <div
            style={{
              position: 'absolute',
              transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
              pointerEvents: 'all',
            }}
            className="nodrag nopan"
          >
            <span
              className="text-[10px] font-medium px-1.5 py-0.5 rounded"
              style={{ backgroundColor: style.labelBg, color: style.stroke }}
            >
              {style.label}
            </span>
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  )
}

export default memo(ConditionalEdge)
