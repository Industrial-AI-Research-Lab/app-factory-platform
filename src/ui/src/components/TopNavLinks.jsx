import { useState, useRef, useEffect } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { Home, Workflow, Activity, Settings, LogOut, User, ChevronDown, Bot, GitBranch, Wrench, Users, SlidersHorizontal, Building2, Plug, Package, Network } from 'lucide-react'
import { useAuth } from '../hooks/useAuth.jsx'

export default function TopNavLinks({ className = '' }) {
  const location = useLocation()
  const navigate = useNavigate()
  const { user, logout, hasRole } = useAuth()
  const [configOpen, setConfigOpen] = useState(false)
  const dropdownRef = useRef(null)

  const isActive = (path) => {
    if (path === '/') return location.pathname === '/'
    return location.pathname === path || location.pathname.startsWith(path + '/')
  }

  const isConfigActive = () =>
    location.pathname.startsWith('/configurations') || location.pathname === '/settings'

  const base = 'inline-flex items-center text-xs sm:text-sm'
  const active = 'text-white'
  const inactive = 'text-slate-300 hover:text-white'

  const handleLogout = () => {
    logout()
    navigate('/login', { replace: true })
  }

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) setConfigOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  // Close dropdown on navigation
  useEffect(() => { setConfigOpen(false) }, [location.pathname])

  return (
    <div className={`hidden md:flex items-center gap-4 ${className}`}>
      <Link
        to="/"
        className={`${base} ${isActive('/') ? active : inactive}`}
      >
        <Home className="w-4 h-4 mr-1.5" />
        <span className="hidden lg:inline">Home</span>
      </Link>
      <Link
        to="/workflow-builder"
        className={`${base} ${isActive('/workflow-builder') ? active : inactive}`}
      >
        <Workflow className="w-4 h-4 mr-1.5" />
        <span className="hidden lg:inline">Workflow Builder</span>
      </Link>
      <Link
        to="/run-configurations"
        className={`${base} ${isActive('/run-configurations') ? active : inactive}`}
      >
        <SlidersHorizontal className="w-4 h-4 mr-1.5" />
        <span className="hidden lg:inline">Run Configs</span>
      </Link>
      <Link
        to="/projects"
        className={`${base} ${isActive('/projects') ? active : inactive}`}
      >
        <Activity className="w-4 h-4 mr-1.5" />
        <span className="hidden lg:inline">Projects</span>
      </Link>

      {/* Configuration dropdown (tenant_admin+ only) */}
      {hasRole('tenant_admin') && (
        <div className="relative" ref={dropdownRef}>
          <button
            onClick={() => setConfigOpen(prev => !prev)}
            className={`${base} gap-1 ${isConfigActive() ? active : inactive}`}
          >
            <Settings className="w-4 h-4" />
            <span className="hidden lg:inline">Configuration</span>
            <ChevronDown className={`w-3 h-3 transition-transform ${configOpen ? 'rotate-180' : ''}`} />
          </button>
          {configOpen && (
            <div className="absolute top-full right-0 mt-1 w-48 bg-slate-800 border border-slate-700 rounded-lg shadow-xl z-50 py-1">
              <DropdownSection label="Orchestration" />
              <DropdownLink to="/configurations/agents" icon={Bot} label="Agents" active={isActive('/configurations/agents')} />
              <DropdownLink to="/configurations/workflows" icon={GitBranch} label="Workflows" active={isActive('/configurations/workflows')} />

              <div className="border-t border-slate-700 my-1" />
              <DropdownSection label="Integrations" />
              <DropdownLink to="/configurations/a2a" icon={Network} label="A2A Servers" active={isActive('/configurations/a2a')} />
              <DropdownLink to="/configurations/mcp-tools" icon={Plug} label="MCP Tools" active={isActive('/configurations/mcp-tools')} />
              <DropdownLink to="/configurations/tools" icon={Wrench} label="Tools" active={isActive('/configurations/tools')} />

              <div className="border-t border-slate-700 my-1" />
              <DropdownSection label="Access" />
              <DropdownLink to="/configurations/tenant-settings" icon={Building2} label="Tenant Settings" active={isActive('/configurations/tenant-settings')} />
              <DropdownLink to="/configurations/tenant-artifacts" icon={Building2} label="Tenant Artifacts" active={isActive('/configurations/tenant-artifacts')} />
              {hasRole('root') && (
                <DropdownLink to="/configurations/tenants" icon={Building2} label="Tenants" active={isActive('/configurations/tenants')} />
              )}
              <DropdownLink to="/configurations/users" icon={Users} label="Users" active={isActive('/configurations/users')} />

              <div className="border-t border-slate-700 my-1" />
              <DropdownSection label="System" />
              <DropdownLink to="/configurations/bundle" icon={Package} label="Config Bundle" active={isActive('/configurations/bundle')} />
              {hasRole('root') && (
                <DropdownLink to="/settings" icon={Settings} label="Settings" active={isActive('/settings')} />
              )}
            </div>
          )}
        </div>
      )}

      {/* Divider */}
      <div className="w-px h-5 bg-slate-600 mx-1" />

      {/* User info + logout */}
      {user && (
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1 text-xs text-slate-400">
            <User className="w-3.5 h-3.5" />
            <span className="hidden lg:inline max-w-[120px] truncate">{user.name || user.email}</span>
            <span className="text-[10px] text-slate-500 bg-slate-700 px-1.5 py-0.5 rounded">{user.role}</span>
          </span>
          <button
            onClick={handleLogout}
            title="Sign out"
            className="inline-flex items-center text-xs text-slate-400 hover:text-red-400 transition-colors"
          >
            <LogOut className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
    </div>
  )
}

function DropdownLink({ to, icon: Icon, label, active }) {
  return (
    <Link
      to={to}
      className={`flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-slate-700 ${active ? 'text-white bg-slate-700/50' : 'text-slate-300'}`}
    >
      <Icon className="w-4 h-4" />
      {label}
    </Link>
  )
}

function DropdownSection({ label }) {
  return (
    <div className="px-3 pt-1.5 pb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500 select-none">
      {label}
    </div>
  )
}
