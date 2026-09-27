import { useRef, useState } from 'react'
import { CheckCircle2, FileArchive, Loader2, Upload } from 'lucide-react'
import { isZipBuildInFlight } from '../../hooks/useMcpZipBuild'

function formatZipSize(bytes) {
  const n = Number(bytes) || 0
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  return `${(n / 1024).toFixed(1)} KB`
}

export default function McpZipDropzone({ zip, maxHint = '100 MB' }) {
  const fileInputRef = useRef(null)
  const [dragOver, setDragOver] = useState(false)

  const onFileInputChange = (e) => {
    const f = e.target.files?.[0]
    if (f) zip.handleFileSelected(f)
    e.target.value = ''
  }

  const onDrop = (e) => {
    e.preventDefault()
    setDragOver(false)
    const f = e.dataTransfer.files?.[0]
    if (f) zip.handleFileSelected(f)
  }

  const busyUpload = zip.uploading
    || (zip.busy && zip.phase === 'analyzing')
    || isZipBuildInFlight(zip.buildStatus)

  return (
    <div className="space-y-2">
      <p className="text-xs text-slate-500 leading-relaxed">
        GitHub-style <code className="text-slate-400">.zip</code> with an MCP server.
        Max {maxHint}. Drop or pick a .zip — Server ID is taken from the filename, then upload and scan run automatically.
      </p>
      <div
        role="presentation"
        onDragEnter={e => { e.preventDefault(); setDragOver(true) }}
        onDragOver={e => { e.preventDefault(); setDragOver(true) }}
        onDragLeave={e => {
          if (!e.currentTarget.contains(e.relatedTarget)) setDragOver(false)
        }}
        onDrop={onDrop}
        onClick={() => !busyUpload && fileInputRef.current?.click()}
        className={`relative flex min-h-[180px] flex-col items-center justify-center rounded-lg border-2 border-dashed px-6 py-8 text-center cursor-pointer transition-all ${
          busyUpload
            ? 'border-purple-500/70 bg-purple-950/15'
            : dragOver
              ? 'border-purple-400 bg-purple-950/25'
              : zip.uploadId
                ? 'border-emerald-600/50 bg-emerald-950/10 hover:border-emerald-500/60'
                : 'border-slate-500/80 bg-slate-900/50 hover:border-purple-500/50 hover:bg-slate-900/70'
        }`}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept=".zip,application/zip"
          className="hidden"
          onChange={onFileInputChange}
        />

        {busyUpload ? (
          <div className="flex flex-col items-center gap-3">
            <Loader2 className="w-9 h-9 animate-spin text-purple-400" />
            <p className="text-sm text-slate-200">
              {zip.uploading
                ? 'Uploading and extracting…'
                : isZipBuildInFlight(zip.buildStatus)
                  ? 'Build or smoke in progress…'
                  : 'Scanning for Dockerfiles…'}
            </p>
          </div>
        ) : zip.zipFile ? (
          <div className="flex flex-col items-center gap-2 max-w-full">
            {zip.uploadId ? (
              <CheckCircle2 className="w-9 h-9 text-emerald-400/90" />
            ) : (
              <FileArchive className="w-9 h-9 text-slate-400" />
            )}
            <p className="text-sm text-slate-100 font-mono break-all px-2">{zip.zipFile.name}</p>
            <p className="text-xs text-slate-400">
              {formatZipSize(zip.zipFile.size)}
              {zip.uploadId && <span className="text-emerald-400/90"> · ready</span>}
            </p>
            <p className="text-xs text-slate-500">Drop or click to replace</p>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-slate-800 border border-slate-600">
              <Upload className="w-6 h-6 text-slate-400" />
            </div>
            <p className="text-sm text-slate-200">Drop your .zip here</p>
            <p className="text-xs text-slate-500">or click to browse</p>
          </div>
        )}
      </div>
    </div>
  )
}
