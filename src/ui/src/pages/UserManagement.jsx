import { useEffect, useState, useCallback } from 'react'
import { Plus, Trash2, RefreshCw, X, KeyRound, ToggleLeft, ToggleRight } from 'lucide-react'
import TopNavLinks from '../components/TopNavLinks'
import CreateUserModal from '../components/user/CreateUserModal'
import { useAuth } from '../hooks/useAuth.jsx'
import { apiFetch } from '../utils_api'

const ROLES = ['viewer', 'developer', 'tenant_admin', 'root']

export default function UserManagement() {
  const { user: currentUser, hasRole } = useAuth()
  const isRoot = hasRole('root')
  const [users, setUsers] = useState([])
  const [tenants, setTenants] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [saving, setSaving] = useState({})

  // Modal state
  const [showCreate, setShowCreate] = useState(false)
  const [showResetPw, setShowResetPw] = useState(null) // user id
  const [createForm, setCreateForm] = useState(emptyCreate())
  const [resetPwForm, setResetPwForm] = useState('')

  function emptyCreate() {
    return { email: '', name: '', password: '', role: 'developer', tenant_id: '', enabled: true }
  }

  const openCreateModal = () => {
    const next = emptyCreate()
    if (isRoot) {
      next.tenant_id = ''
    } else {
      next.tenant_id = currentUser?.tenant_id || ''
    }
    setCreateForm(next)
    setShowCreate(true)
  }

  const fetchUsers = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await apiFetch('/auth/users')
      if (!res.ok) { const e = await res.json(); throw new Error(e.detail || 'Failed to fetch users') }
      const data = await res.json()
      setUsers(data)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchUsers() }, [fetchUsers])
  useEffect(() => {
    let cancelled = false
    const fetchTenants = async () => {
      if (!isRoot) { setTenants([]); return }
      try {
        const res = await apiFetch('/tenants/')
        if (!res.ok) return
        const data = await res.json()
        if (!cancelled) setTenants(data || [])
      } catch {}
    }
    fetchTenants()
    return () => { cancelled = true }
  }, [isRoot])

  const toggleEnabled = async (u) => {
    const id = u.id || u._id
    if (id === currentUser?.user_id) { alert('Cannot disable yourself'); return }
    setSaving(prev => ({ ...prev, [id]: true }))
    try {
      const res = await apiFetch(`/auth/users/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !u.enabled }),
      })
      if (!res.ok) { const e = await res.json(); throw new Error(e.detail || 'Update failed') }
      const updated = await res.json()
      setUsers(prev => prev.map(x => (x.id || x._id) === id ? updated : x))
    } catch (err) {
      alert(`Toggle failed: ${err.message}`)
    } finally {
      setSaving(prev => ({ ...prev, [id]: false }))
    }
  }

  const changeRole = async (u, newRole) => {
    const id = u.id || u._id
    setSaving(prev => ({ ...prev, [id]: true }))
    try {
      const res = await apiFetch(`/auth/users/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: newRole }),
      })
      if (!res.ok) { const e = await res.json(); throw new Error(e.detail || 'Update failed') }
      const updated = await res.json()
      setUsers(prev => prev.map(x => (x.id || x._id) === id ? updated : x))
    } catch (err) {
      alert(`Role change failed: ${err.message}`)
    } finally {
      setSaving(prev => ({ ...prev, [id]: false }))
    }
  }

  const createUser = async () => {
    const payload = { ...createForm }
    if (isRoot) {
      const selectedTenantId = (payload.tenant_id || '').trim()
      if (selectedTenantId) {
        payload.tenant_id = selectedTenantId
      } else {
        delete payload.tenant_id
      }
    } else {
      const actorTenantId = (currentUser?.tenant_id || '').trim()
      if (!actorTenantId) {
        alert('Your account is not bound to a tenant')
        return
      }
      payload.tenant_id = actorTenantId
    }

    setSaving(prev => ({ ...prev, modal: true }))
    try {
      const res = await apiFetch('/auth/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!res.ok) { const e = await res.json(); throw new Error(e.detail || 'Create failed') }
      setShowCreate(false)
      setCreateForm(emptyCreate())
      fetchUsers()
    } catch (err) {
      alert(`Create failed: ${err.message}`)
    } finally {
      setSaving(prev => ({ ...prev, modal: false }))
    }
  }

  const deleteUser = async (u) => {
    const id = u.id || u._id
    if (id === currentUser?.user_id) { alert('Cannot delete yourself'); return }
    if (!confirm(`Delete user "${u.name}" (${u.email})?`)) return
    try {
      const res = await apiFetch(`/auth/users/${id}`, { method: 'DELETE' })
      if (!res.ok && res.status !== 204) { const e = await res.json(); throw new Error(e.detail || 'Delete failed') }
      setUsers(prev => prev.filter(x => (x.id || x._id) !== id))
    } catch (err) {
      alert(`Delete failed: ${err.message}`)
    }
  }

  const resetPassword = async () => {
    if (!resetPwForm || resetPwForm.length < 8) { alert('Password must be at least 8 characters'); return }
    setSaving(prev => ({ ...prev, resetPw: true }))
    try {
      const res = await apiFetch(`/auth/users/${showResetPw}/reset-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ new_password: resetPwForm }),
      })
      if (!res.ok) { const e = await res.json(); throw new Error(e.detail || 'Reset failed') }
      alert('Password reset successfully')
      setShowResetPw(null)
      setResetPwForm('')
    } catch (err) {
      alert(`Reset failed: ${err.message}`)
    } finally {
      setSaving(prev => ({ ...prev, resetPw: false }))
    }
  }

  // Filter available roles based on current user's role
  const availableRoles = ROLES.filter(r => {
    if (currentUser?.role === 'root') return true
    const levels = { viewer: 0, developer: 1, tenant_admin: 2, root: 3 }
    return levels[r] <= (levels[currentUser?.role] || 0)
  })

  return (
    <div className="min-h-screen bg-slate-900 text-white">
      <header className="bg-slate-800 border-b border-slate-700 px-4 py-2 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-lg font-semibold">AppFactory</span>
          <span className="text-slate-500">/</span>
          <span className="text-sm text-slate-300">User Management</span>
        </div>
        <TopNavLinks />
      </header>

      <main className="max-w-5xl mx-auto px-4 py-6">
        <div className="flex items-center justify-between mb-4">
          <h1 className="text-xl font-bold">Users</h1>
          <div className="flex gap-2">
            <button onClick={fetchUsers} className="px-3 py-1.5 text-xs bg-slate-700 hover:bg-slate-600 rounded flex items-center gap-1">
              <RefreshCw className="w-3.5 h-3.5" /> Refresh
            </button>
            <button onClick={openCreateModal} className="px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-500 rounded flex items-center gap-1">
              <Plus className="w-3.5 h-3.5" /> New User
            </button>
          </div>
        </div>

        {error && <div className="bg-red-900/50 border border-red-700 text-red-200 px-4 py-2 rounded mb-4 text-sm">{error}</div>}
        {loading && <div className="text-slate-400 text-sm">Loading...</div>}

        {/* Table */}
        <div className="bg-slate-800 border border-slate-700 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-slate-400 border-b border-slate-700">
                <th className="text-left px-4 py-2">Email</th>
                <th className="text-left px-4 py-2">Name</th>
                <th className="text-left px-4 py-2">Role</th>
                <th className="text-left px-4 py-2">Tenant</th>
                <th className="text-center px-4 py-2">Enabled</th>
                <th className="text-left px-4 py-2">Last Login</th>
                <th className="text-right px-4 py-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.map(u => {
                const id = u.id || u._id
                const isSelf = id === currentUser?.user_id
                return (
                  <tr key={id} className={`border-b border-slate-700/50 hover:bg-slate-750 ${isSelf ? 'bg-slate-800/80' : ''}`}>
                    <td className="px-4 py-2">
                      {u.email}
                      {isSelf && <span className="ml-1 text-xs text-blue-400">(you)</span>}
                    </td>
                    <td className="px-4 py-2">{u.name}</td>
                    <td className="px-4 py-2">
                      <select
                        value={u.role}
                        onChange={e => changeRole(u, e.target.value)}
                        disabled={saving[id] || isSelf}
                        className="bg-slate-700 border border-slate-600 rounded px-2 py-0.5 text-xs disabled:opacity-50"
                      >
                        {availableRoles.map(r => <option key={r} value={r}>{r}</option>)}
                      </select>
                    </td>
                    <td className="px-4 py-2 text-xs text-slate-400">{u.tenant_id || '—'}</td>
                    <td className="px-4 py-2 text-center">
                      <button onClick={() => toggleEnabled(u)} disabled={saving[id] || isSelf} className="inline-flex items-center disabled:opacity-50">
                        {u.enabled
                          ? <ToggleRight className="w-5 h-5 text-green-400" />
                          : <ToggleLeft className="w-5 h-5 text-slate-500" />}
                      </button>
                    </td>
                    <td className="px-4 py-2 text-xs text-slate-400">
                      {u.last_login ? new Date(u.last_login).toLocaleString() : 'Never'}
                    </td>
                    <td className="px-4 py-2 text-right">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          onClick={() => { setShowResetPw(id); setResetPwForm('') }}
                          className="px-2 py-1 text-xs text-slate-300 hover:text-white"
                          title="Reset password"
                        >
                          <KeyRound className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => deleteUser(u)}
                          disabled={isSelf}
                          className="px-2 py-1 text-xs text-red-400 hover:text-red-300 disabled:opacity-30"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              })}
              {!loading && users.length === 0 && (
                <tr><td colSpan={7} className="px-4 py-8 text-center text-slate-500">No users found.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </main>

      <CreateUserModal
        show={showCreate}
        onClose={() => setShowCreate(false)}
        createForm={createForm}
        setCreateForm={setCreateForm}
        availableRoles={availableRoles}
        isRoot={isRoot}
        tenants={tenants}
        saving={saving.modal}
        onCreate={createUser}
      />

      {/* Reset Password Modal */}
      {showResetPw && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-slate-800 border border-slate-700 rounded-lg w-full max-w-sm p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold">Reset Password</h2>
              <button onClick={() => setShowResetPw(null)}><X className="w-5 h-5 text-slate-400 hover:text-white" /></button>
            </div>
            <label className="block">
              <span className="text-xs text-slate-400">New Password (min 8 chars)</span>
              <input type="password" value={resetPwForm} onChange={e => setResetPwForm(e.target.value)}
                className="w-full bg-slate-700 border border-slate-600 rounded px-2 py-1.5 text-sm mt-1" />
            </label>
            <div className="flex justify-end gap-2 mt-5">
              <button onClick={() => setShowResetPw(null)} className="px-4 py-2 text-xs bg-slate-700 hover:bg-slate-600 rounded">Cancel</button>
              <button onClick={resetPassword} disabled={saving.resetPw}
                className="px-4 py-2 text-xs bg-orange-600 hover:bg-orange-500 rounded flex items-center gap-1 disabled:opacity-50">
                <KeyRound className="w-3.5 h-3.5" /> {saving.resetPw ? 'Resetting...' : 'Reset'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
