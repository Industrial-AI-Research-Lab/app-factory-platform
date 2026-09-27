import { Navigate, useLocation } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth.jsx'
import { Loader2 } from 'lucide-react'

export default function ProtectedRoute({ children, requiredRole }) {
  const { isAuthenticated, hasRole, loading } = useAuth()
  const location = useLocation()

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-900 flex items-center justify-center">
        <Loader2 className="w-8 h-8 text-blue-400 animate-spin" />
      </div>
    )
  }

  if (!isAuthenticated()) {
    return <Navigate to="/login" state={{ from: location }} replace />
  }

  if (requiredRole && !hasRole(requiredRole)) {
    return (
      <div className="min-h-screen bg-slate-900 flex items-center justify-center">
        <div className="bg-slate-800 rounded-xl p-8 border border-slate-700 text-center max-w-sm">
          <h2 className="text-lg font-semibold text-red-400 mb-2">Access Denied</h2>
          <p className="text-slate-400 text-sm">
            You need <span className="text-slate-200 font-medium">{requiredRole}</span> role or higher to access this page.
          </p>
        </div>
      </div>
    )
  }

  return children
}
