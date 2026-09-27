import { Link, useLocation } from 'react-router-dom'
import { AlertTriangle, Home } from 'lucide-react'

export default function NotFound() {
  const location = useLocation()
  return (
    <div className="min-h-screen bg-slate-900 flex items-center justify-center px-4">
      <div className="bg-slate-800 border border-slate-700 rounded-xl p-8 text-center max-w-md w-full">
        <div className="flex justify-center mb-4">
          <div className="p-3 bg-yellow-900/40 rounded-full">
            <AlertTriangle className="w-8 h-8 text-yellow-400" />
          </div>
        </div>
        <h1 className="text-2xl font-bold text-slate-100 mb-2">404 — Page not found</h1>
        <p className="text-slate-400 text-sm mb-6">
          No route matches <code className="font-mono text-slate-200 px-1.5 py-0.5 bg-slate-900 rounded">{location.pathname}</code>.
        </p>
        <Link
          to="/"
          className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded transition-colors"
        >
          <Home className="w-4 h-4" /> Go home
        </Link>
      </div>
    </div>
  )
}
