import { useEffect, useState } from 'react'
import { apiUrl } from '../utils_api'

function BackendStatusBadge() {
  const [api, setApi] = useState('checking')
  const [mongo, setMongo] = useState('checking')
  const [container, setContainer] = useState('checking')

  function colorFor(s) {
    if (s === 'up') return 'bg-emerald-500'
    if (s === 'down') return 'bg-rose-500'
    if (s === 'disabled') return 'bg-slate-500'
    return 'bg-amber-500'
  }

  function labelFor(kind, s) {
    if (kind === 'api') return s === 'up' ? 'Connected' : s === 'down' ? 'Disconnected' : 'Checking…'
    if (kind === 'mongo') return s === 'up' ? 'Connected' : s === 'down' ? 'Down' : 'Checking…'
    if (kind === 'container') return s === 'up' ? 'Connected' : s === 'disabled' ? 'Disabled' : s === 'down' ? 'Down' : 'Checking…'
    return 'Checking…'
  }

  async function checkOnce() {
    // Call /health/details to get full status (API, MongoDB, Container)
    const controller = new AbortController()
    const id = setTimeout(() => controller.abort(), 4000)
    try {
      const r = await fetch(apiUrl('/health/details'), { signal: controller.signal })
      if (r.ok) {
        const data = await r.json()
        setApi(data.api?.status || 'down')
        setMongo(data.mongodb?.status || 'down')
        setContainer(data.container_use?.status || 'down')
      } else {
        setApi('down')
        setMongo('down')
        setContainer('down')
      }
    } catch (_) {
      setApi('down')
      setMongo('down')
      setContainer('down')
    } finally {
      clearTimeout(id)
    }
  }

  useEffect(() => {
    checkOnce()
    const iv = setInterval(checkOnce, 10000)
    return () => clearInterval(iv)
  }, [])

  return (
    <div className="inline-flex items-center gap-4 px-2 py-1 rounded-md bg-slate-700/60 border border-slate-600/60">
      <div className="inline-flex items-center gap-2">
        <span className={`inline-block w-2 h-2 rounded-full ${colorFor(api)}`}></span>
        <span className="text-xs text-slate-200">API: {labelFor('api', api)}</span>
      </div>
      <div className="inline-flex items-center gap-2">
        <span className={`inline-block w-2 h-2 rounded-full ${colorFor(mongo)}`}></span>
        <span className="text-xs text-slate-200">MongoDB: {labelFor('mongo', mongo)}</span>
      </div>
      <div className="inline-flex items-center gap-2">
        <span className={`inline-block w-2 h-2 rounded-full ${colorFor(container)}`}></span>
        <span className="text-xs text-slate-200">Container: {labelFor('container', container)}</span>
      </div>
    </div>
  )
}

export default BackendStatusBadge
