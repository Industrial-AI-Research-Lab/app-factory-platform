import { useEffect, useState } from 'react'
import { Loader2, Trash2, X } from 'lucide-react'

function formatDate(iso) {
  if (!iso) return '—'
  try {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return String(iso)
    return d.toLocaleString()
  } catch {
    return String(iso)
  }
}

function DeleteImageModal({ image, onCancel, onConfirm, deleting }) {
  if (!image) return null
  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div className="bg-slate-800 border border-slate-700 rounded-lg w-full max-w-md p-5">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-slate-100">Delete built image?</h3>
          <button type="button" onClick={onCancel} className="text-slate-400 hover:text-white">
            <X className="w-5 h-5" />
          </button>
        </div>
        <p className="text-xs text-slate-400 mb-2">
          Removes the database record and runs <code className="text-slate-300">docker rmi</code> on the API host.
        </p>
        <p className="text-xs font-mono text-slate-200 break-all bg-slate-900/80 border border-slate-600 rounded px-2 py-1.5 mb-4">
          {image.image_tag}
        </p>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={deleting}
            className="px-3 py-1.5 text-xs bg-slate-700 hover:bg-slate-600 rounded disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={deleting}
            className="px-3 py-1.5 text-xs bg-red-800 hover:bg-red-700 rounded disabled:opacity-50 flex items-center gap-1"
          >
            {deleting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
            Delete
          </button>
        </div>
      </div>
    </div>
  )
}

export default function McpBuiltImagesPanel({ zip }) {
  const [pendingDelete, setPendingDelete] = useState(null)

  useEffect(() => {
    zip.fetchBuiltImages()
  }, [zip.fetchBuiltImages])

  const confirmDelete = async () => {
    if (!pendingDelete) return
    await zip.deleteBuiltImage(pendingDelete.id)
    setPendingDelete(null)
  }

  const header = (
    <div className="flex items-center justify-between gap-2">
      <div>
        <span className="text-sm font-semibold">Built images</span>
        <p className="text-xs text-slate-500 mt-0.5">
          Storage of Docker images built from ZIP on this tenant. Delete only if not used by MCP tools.
        </p>
      </div>
      <button
        type="button"
        onClick={zip.fetchBuiltImages}
        disabled={zip.imagesLoading}
        className="px-3 py-1.5 text-xs bg-slate-700 hover:bg-slate-600 rounded disabled:opacity-50"
      >
        {zip.imagesLoading ? 'Refreshing…' : 'Refresh'}
      </button>
    </div>
  )

  const body = (
    <>
      {zip.builtImages.length === 0 ? (
          <p className="text-sm text-slate-500">
            No images yet. Upload a ZIP in the block above and run Build and smoke-test.
          </p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {zip.builtImages.map(img => (
              <div
                key={img.id}
                className="rounded-lg border border-slate-600 bg-slate-750/40 p-3 flex flex-col gap-2"
              >
                <p className="font-mono text-xs text-slate-100 break-all leading-snug">{img.image_tag}</p>
                <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-slate-500">
                  <span>server: <span className="text-slate-300">{img.server_id}</span></span>
                  <span>{formatDate(img.created_at)}</span>
                  {img.discover_tool_count != null && (
                    <span>{img.discover_tool_count} tool(s)</span>
                  )}
                </div>
                <div className="flex items-center justify-between mt-auto pt-1">
                  <span className={`text-xs ${img.in_use ? 'text-amber-300/90' : 'text-slate-500'}`}>
                    {img.in_use ? 'In use by MCP tools' : (img.status || 'ready')}
                  </span>
                  <button
                    type="button"
                    disabled={img.in_use || zip.busy}
                    onClick={() => setPendingDelete(img)}
                    className="text-xs text-slate-400 hover:text-red-300 disabled:opacity-40 flex items-center gap-1"
                    title={img.in_use ? 'Referenced by MCP tools' : 'Delete image'}
                  >
                    <Trash2 className="w-3.5 h-3.5" /> Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
    </>
  )

  return (
    <div className="bg-slate-800 border border-slate-700 rounded-lg">
      <div className="px-4 py-3 border-b border-slate-700">{header}</div>
      <div className="p-4">{body}</div>
      <DeleteImageModal
        image={pendingDelete}
        onCancel={() => setPendingDelete(null)}
        onConfirm={confirmDelete}
        deleting={zip.busy && !!pendingDelete}
      />
    </div>
  )
}
