import { useState } from 'react'
import { Activity, Loader } from 'lucide-react'
import { apiFetch } from '../../utils_api'

export default function SnapshotsTab({ projectId, onRevertToSnapshot, onStopAndRevertPreviousUserAction }) {
  const [snapshots, setSnapshots] = useState([])
  const [snapshotsLoading, setSnapshotsLoading] = useState(false)

  const loadSnapshots = async () => {
    try {
      setSnapshotsLoading(true)
      const res = await apiFetch(`/projects/${projectId}/snapshots?tags=user_action`)
      const data = await res.json()
      setSnapshots(Array.isArray(data.snapshots) ? data.snapshots : [])
    } catch (e) {
      console.error('Failed to load snapshots', e)
    } finally {
      setSnapshotsLoading(false)
    }
  }

  return (
    <div className="bg-slate-800 rounded-lg p-6">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold text-slate-100">Snapshots</h3>
        <div className="flex gap-2">
          <button
            onClick={loadSnapshots}
            className="inline-flex items-center gap-2 bg-slate-600 hover:bg-slate-500 text-white text-sm px-3 py-1.5 rounded"
          >
            {snapshotsLoading ? <Loader className="w-4 h-4 animate-spin" /> : <Activity className="w-4 h-4" />} Reload
          </button>
          <button
            onClick={() => onStopAndRevertPreviousUserAction()}
            className="inline-flex items-center gap-2 bg-yellow-700 hover:bg-yellow-600 text-white text-sm px-3 py-1.5 rounded"
          >
            Stop + Revert to Previous User Action
          </button>
        </div>
      </div>
      {snapshots.length === 0 ? (
        <div className="p-6 bg-slate-900 rounded text-slate-400">No snapshots yet. Click Reload to fetch.</div>
      ) : (
        <div className="space-y-2">
          {snapshots.map((s) => (
            <div key={s.id} className="flex items-center justify-between p-3 bg-slate-700 rounded">
              <div className="space-y-0.5">
                <div className="text-slate-200 text-sm font-medium">{s.label || s.type}</div>
                <div className="text-slate-400 text-xs font-mono">
                  {s.type} • {s.phase || 'n/a'} • {s.git_commit ? s.git_commit.slice(0,7) : 'no-commit'} • {s.created_at}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button 
                  onClick={() => onRevertToSnapshot(s.id, false)} 
                  className="bg-blue-600 hover:bg-blue-700 text-white text-xs px-3 py-1.5 rounded"
                >
                  Revert
                </button>
                <button 
                  onClick={() => onRevertToSnapshot(s.id, true)} 
                  className="bg-green-600 hover:bg-green-700 text-white text-xs px-3 py-1.5 rounded"
                >
                  Revert & Resume
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
