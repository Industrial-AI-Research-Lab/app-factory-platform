import { useEffect, useState } from 'react'

// Variants: info, success, warning, error
const colors = {
  info: {
    bg: 'bg-slate-800/95',
    border: 'border-slate-600',
    text: 'text-slate-100'
  },
  success: {
    bg: 'bg-green-900/95',
    border: 'border-green-700',
    text: 'text-green-100'
  },
  warning: {
    bg: 'bg-amber-900/95',
    border: 'border-amber-700',
    text: 'text-amber-100'
  },
  error: {
    bg: 'bg-red-900/95',
    border: 'border-red-700',
    text: 'text-red-100'
  }
}

export default function NotificationCenter() {
  const [items, setItems] = useState([])

  useEffect(() => {
    const handler = (e) => {
      const detail = e.detail || {}
      const id = Date.now() + Math.random().toString(36).slice(2)
      const ttl = detail.ttl ?? 6000
      setItems((prev) => [...prev, { id, ...detail }])
      if (ttl > 0) {
        setTimeout(() => {
          setItems((prev) => prev.filter((x) => x.id !== id))
        }, ttl)
      }
    }
    const clearHandler = () => setItems([])
    window.addEventListener('app-notify', handler)
    window.addEventListener('app-notify-clear', clearHandler)
    return () => {
      window.removeEventListener('app-notify', handler)
      window.removeEventListener('app-notify-clear', clearHandler)
    }
  }, [])

  const close = (id) => setItems((prev) => prev.filter((x) => x.id !== id))

  return (
    <div className="fixed top-3 right-3 z-50 space-y-2 w-[360px] max-w-[92vw]">
      {items.map((n) => {
        const palette = colors[n.variant] || colors.info
        return (
          <div key={n.id} className={`border ${palette.bg} ${palette.border} ${palette.text} rounded-lg shadow-lg p-3`}>            
            <div className="flex items-start gap-3">
              <div className="flex-1 min-w-0">
                {n.title && <div className="font-semibold text-sm mb-0.5 truncate">{n.title}</div>}
                {n.message && <div className="text-xs opacity-90 whitespace-pre-wrap break-words">{n.message}</div>}
                {n.action && (
                  <div className="mt-2">
                    {n.action.href ? (
                      <a href={n.action.href} className="text-blue-300 hover:text-blue-200 text-xs underline">{n.action.label || 'Open'}</a>
                    ) : (
                      <button onClick={n.action.onClick} className="text-blue-300 hover:text-blue-200 text-xs underline">{n.action.label || 'Open'}</button>
                    )}
                  </div>
                )}
              </div>
              <button className="text-xs opacity-70 hover:opacity-100" onClick={() => close(n.id)}>✕</button>
            </div>
          </div>
        )
      })}
    </div>
  )
}
