import {useState, useEffect, useMemo, useRef, useCallback} from 'react'
import {BrowserRouter as Router, Routes, Route, Link, Navigate, useNavigate, useLocation} from 'react-router-dom'
import WorkflowEditor from './pages/WorkflowEditor'
import ExecutionMonitor from './pages/ExecutionMonitor'
import Projects from './pages/Projects'
import Settings from './pages/Settings'
import Login from './pages/Login'
import ForgotPassword from './pages/ForgotPassword'
import ResetPassword from './pages/ResetPassword'
import AgentConfigurations from './pages/AgentConfigurations'
import ToolConfigurations from './pages/ToolConfigurations'
import McpToolConfigurations from './pages/McpToolConfigurations'
import UserManagement from './pages/UserManagement'
import TenantManagement from './pages/TenantManagement'
import TenantSettings from './pages/TenantSettings'
import TenantArtifacts from './pages/TenantArtifacts'
import RunConfigurations from './pages/RunConfigurations'
import ConfigBundle from './pages/ConfigBundle'
import NotFound from './pages/NotFound'
import TopNavLinks from './components/TopNavLinks'
import ProtectedRoute from './components/ProtectedRoute'
import {AuthProvider} from './hooks/useAuth.jsx'
import {Home, Workflow, Activity, ChevronDown, Brain, SlidersHorizontal} from 'lucide-react'
import BackendStatusBadge from './components/BackendStatusBadge'
import NotificationCenter from './components/NotificationCenter'
import { entityShortDescription } from './utils/entity_descriptions'
import { sanitizeWorkflowPrompts } from './utils/workflow_serializer'
import {apiFetch, formatApiDetail, projectIdFromApiDetail} from './utils_api'
import {notify} from './utils_notify'
import {useModels} from './hooks/useModels'
import AttachmentComposer from './components/chat/AttachmentComposer'
import { buildProjectCreateFormData } from './utils/attachmentFiles'
import A2AConfigurations from './pages/A2AConfigurations';
import {
    getReasoningControlMode,
    getReasoningEffortOptions,
    getTemperatureControlState,
} from './pages/agentConfigurationState'

const API_BASE = import.meta.env.VITE_API_URL || ''

// Empty value = "Use default": no override is sent, so each agent uses the
// effort wired into its run-config / static default. Other values explicitly
// override that default for the whole project. "None" is a real override —
// distinct from "Use default" — that tells the backend to ask the model for
// minimal-to-no reasoning regardless of what the agent's config says.
const modelConfigPath = (model) => String(model)
    .split('/')
    .map(encodeURIComponent)
    .join('/')

const STORAGE = {
    selection: 'AppFactory:home:selection',
    reasoningEffort: 'AppFactory:home:reasoning_effort',
    temperature: 'AppFactory:home:temperature',
    workflow: 'AppFactory:home:workflow',
    approvalMode: 'AppFactory:home:approval_mode_v2',
}

const APPROVAL_MODES = ['auto', 'human', 'inherit']

function readStored(key) {
    try {
        const raw = localStorage.getItem(key)
        return raw == null ? null : JSON.parse(raw)
    } catch {
        return null
    }
}

function writeStored(key, value) {
    try {
        if (value === null || value === undefined) {
            localStorage.removeItem(key)
        } else {
            localStorage.setItem(key, JSON.stringify(value))
        }
    } catch {
        // Quota exceeded or storage disabled — silently skip.
    }
}

function HomePage() {
    const [prompt, setPrompt] = useState('')
    const [loading, setLoading] = useState(false)
    const [selectedFiles, setSelectedFiles] = useState([])

    // Unified selection: either a run config or a single model.
    // Shape: { kind: 'run_config' | 'model', id: string } | null
    // Initialize from localStorage so the persist effect's first write is
    // a no-op (same value back). Previously we initialized to null, which
    // caused the persist effect to immediately wipe storage before
    // fetchData could read it — losing the user's saved choice on every
    // page load.
    const [selection, setSelection] = useState(() => {
        const stored = readStored(STORAGE.selection)
        if (stored && (stored.kind === 'run_config' || stored.kind === 'model') && typeof stored.id === 'string') {
            return stored
        }
        return null
    })
    const [pickerOpen, setPickerOpen] = useState(false)
    const [pickerSearch, setPickerSearch] = useState('')

    // '' means "Use default" (don't send a reasoning override). Any other
    // value in ALLOWED_REASONING_EFFORTS becomes a project-wide override.
    const [reasoningEffort, setReasoningEffort] = useState(() => {
        const stored = readStored(STORAGE.reasoningEffort)
        return typeof stored === 'string' ? stored : ''
    })
    const [temperatureOverride, setTemperatureOverride] = useState(() => {
        const stored = readStored(STORAGE.temperature)
        return typeof stored === 'number' && Number.isFinite(stored) ? stored : null
    })
    const [workflows, setWorkflows] = useState([])
    // Same lazy-init pattern as `selection` — preserves the user's last
    // workflow choice across reloads instead of always resetting to default.
    const [selectedWorkflow, setSelectedWorkflow] = useState(() => {
        const stored = readStored(STORAGE.workflow)
        return typeof stored === 'string' && stored ? stored : null
    })
    // Default 'human' (safe: pause at each gate) per AppFactory-322 review; 'auto'
    // only on explicit pick, 'inherit' defers to the run config. Storage key is
    // versioned (_v2) so a value saved under the old auto-default is not read
    // back as an explicit user choice. Backend hard-defaults to 'human' too.
    const [approvalMode, setApprovalMode] = useState(() => {
        const stored = readStored(STORAGE.approvalMode)
        return APPROVAL_MODES.includes(stored) ? stored : 'human'
    })
    // Expanded on load when a restored value is non-default (approval other than 'human',
    // or a reasoning/temperature override) so a returning user sees it — auto-approve skips
    // every human gate — instead of it applying invisibly; otherwise collapsed so the form
    // leads with prompt → workflow → model.
    const [advancedOpen, setAdvancedOpen] = useState(
        () => approvalMode !== 'human' || reasoningEffort !== '' || temperatureOverride != null,
    )
    const [runConfigs, setRunConfigs] = useState([])
    const navigate = useNavigate()

    // ── Backend-driven model search ───────────────────────────────────────
    // Поиск по тексту идёт на бэкенд через q; debounce 300мс внутри хука.
    // pickerOpen=false → enabled=false, чтобы не делать запросы пока
    // дропдаун закрыт. При открытии сразу грузим первый батч.
    // App.jsx — добавь перед useModels:
    const [debouncedSearch, setDebouncedSearch] = useState('')

    useEffect(() => {
        if (!pickerSearch) {
            setDebouncedSearch('')
            return
        }
        const timer = setTimeout(() => {
            setDebouncedSearch(pickerSearch)
        }, 300)
        return () => clearTimeout(timer)
    }, [pickerSearch])

    // И передавай debouncedSearch вместо pickerSearch:
    const {
        models,
        loading: modelsLoading,
        loadingMore,
        hasMore,
        fetchMore,
    } = useModels({
        q: debouncedSearch,   // ← дебаунсированная строка
        limit: 50,
        enabled: pickerOpen,
    })

    // Sentinel-элемент для инфинити-лоада внутри дропдауна
    const sentinelRef = useRef(null)
    useEffect(() => {
        if (!sentinelRef.current) return
        const observer = new IntersectionObserver(
            (entries) => { if (entries[0].isIntersecting) fetchMore() },
            {threshold: 0.1}
        )
        observer.observe(sentinelRef.current)
        return () => observer.disconnect()
    }, [fetchMore])

    // Для определения is_reasoning текущей выбранной модели ищем её в
    // загруженном списке. Если модель выбрана но ещё не в списке (другой
    // батч) — делаем точечный запрос чтобы знать поддерживает ли reasoning.
    const [selectedModelMeta, setSelectedModelMeta] = useState(null)

    // 1. Ищем модель локально прямо во время рендера с помощью useMemo
    const localFoundModel = useMemo(() => {
        if (selection?.kind !== 'model') return null
        return models.find(m => m.id === selection.id) || null
    }, [selection, models])

    // 2. Эффект отвечает ТОЛЬКО за сетевой запрос, если локально модель еще не загружена
    useEffect(() => {
        if (selection?.kind !== 'model') {
            setSelectedModelMeta(null)
            return
        }

        // Если нашли локально — синхронизируем стейт и выходим, запрос делать не нужно
        if (localFoundModel) {
            setSelectedModelMeta(localFoundModel)
            return
        }

        // Делаем точечный запрос, только если модели нет в текущем батче models
        let isMounted = true
        apiFetch(`/settings/models?q=${encodeURIComponent(selection.id)}&limit=5`)
            .then(r => r.json())
            .then(data => {
                if (!isMounted) return
                const exact = (data.models || []).find(m => m.id === selection.id)
                if (exact) setSelectedModelMeta(exact)
            })
            .catch(() => {})

        return () => { isMounted = false }
    }, [selection?.id, localFoundModel])

    const selectedModelObj = selectedModelMeta

    const [modelConfig, setModelConfig] = useState(null)
    const [modelConfigError, setModelConfigError] = useState('')

    const selectedRunConfig = useMemo(() => (
        selection?.kind === 'run_config' ? runConfigs.find(rc => rc._id === selection.id) : null
    ), [runConfigs, selection])

        useEffect(() => {
        // Fetch workflows, default model, and run configs
        // (models теперь через useModels — не нужно грузить здесь)
        const fetchData = async () => {
            try {
                const [defaultRes, wfRes, rcRes] = await Promise.all([
                    apiFetch('/settings/default-model'),
                    apiFetch('/configurations/workflows/').catch(() => null),
                    apiFetch('/configurations/run-configurations/').catch(() => null),
                ])
                const defaultData = await defaultRes.json()
                const defaultModelId = defaultData.model_id

                if (wfRes && wfRes.ok) {
                    const wfData = await wfRes.json()
                    setWorkflows(wfData)
                    if (wfData.length > 0) {
                        // Keep the previously persisted workflow if it still
                        // exists; otherwise fall back to the system default.
                        const storedWf = readStored(STORAGE.workflow)
                        const storedExists = typeof storedWf === 'string' && wfData.some(w => (w._id || w.id) === storedWf)
                        if (storedExists) {
                            setSelectedWorkflow(storedWf)
                        } else {
                            const def = wfData.find(w => w.is_default) || wfData[0]
                            setSelectedWorkflow(def._id || def.id)
                        }
                    }
                }

                let rcList = []
                if (rcRes && rcRes.ok) {
                    rcList = (await rcRes.json()) || []
                    setRunConfigs(rcList)
                }

                // Prefer a previously persisted selection, but only if the
                // referenced run-config still exists — stale ids fall through
                // to the system default. For model selections we trust stored
                // id without checking the list (it gets validated lazily via
                // selectedModelMeta fetch above).
                const stored = readStored(STORAGE.selection)
                let initialSelection = null
                if (stored?.kind === 'run_config' && rcList.some(rc => rc._id === stored.id)) {
                    initialSelection = {kind: 'run_config', id: stored.id}
                } else if (stored?.kind === 'model' && typeof stored.id === 'string') {
                    initialSelection = {kind: 'model', id: stored.id}
                }
                if (!initialSelection && rcList.length > 0) {
                    const def = rcList.find(rc => rc.is_default) || null
                    if (def?._id) initialSelection = {kind: 'run_config', id: def._id}
                }
                if (!initialSelection && defaultModelId) {
                    initialSelection = {kind: 'model', id: defaultModelId}
                }
                setSelection(initialSelection)
            } catch (err) {
                console.error('Failed to fetch data:', err)
            }
        }
        fetchData()
    }, [])

    useEffect(() => {
        const controller = new AbortController()
        setModelConfig(null)
        setModelConfigError('')
        if (selection?.kind !== 'model' || !selection.id) return () => controller.abort()

        apiFetch('/settings/model-config/' + modelConfigPath(selection.id), {
            signal: controller.signal,
        })
            .then(async (response) => {
                if (!response.ok) {
                    const payload = await response.json().catch(() => ({}))
                    throw new Error(formatApiDetail(payload.detail))
                }
                return response.json()
            })
            .then((nextConfig) => {
                if (!controller.signal.aborted) setModelConfig(nextConfig)
            })
            .catch((error) => {
                if (error.name !== 'AbortError') setModelConfigError(error.message)
            })

        return () => controller.abort()
    }, [selection?.kind, selection?.id])

    const reasoning = modelConfig?.reasoning
    const controlMode = getReasoningControlMode(reasoning)
    const reasoningEfforts = getReasoningEffortOptions(reasoning)
    const selectedEffortIsUnsupported = Boolean(
        reasoningEffort && !reasoningEfforts.includes(reasoningEffort),
    )
    const showReasoning = selection?.kind === 'model'
        && (controlMode !== 'hidden' || Boolean(reasoningEffort))
    const useEffortSelect = controlMode === 'effort-select' || controlMode === 'hidden'

    const temperature = modelConfig?.temperature
    const temperatureControl = getTemperatureControlState(temperature, temperatureOverride)
    const showTemperature = selection?.kind === 'model' && Boolean(temperature)

    // Persist selection across reloads. We write null/empty as a removal so
    // a fresh tenant install doesn't read garbage from a previous session.
    useEffect(() => {
        writeStored(STORAGE.selection, selection)
    }, [selection])

    useEffect(() => {
        // Only persist real overrides; empty string = "Use default" maps to
        // localStorage removal so the user's preference doesn't shadow a
        // future change to the agent's static defaults.
        writeStored(STORAGE.reasoningEffort, reasoningEffort || null)
    }, [reasoningEffort])

    useEffect(() => {
        writeStored(STORAGE.temperature, typeof temperatureOverride === 'number' ? temperatureOverride : null)
    }, [temperatureOverride])

    useEffect(() => {
        writeStored(STORAGE.workflow, selectedWorkflow || null)
    }, [selectedWorkflow])

    useEffect(() => {
        writeStored(STORAGE.approvalMode, approvalMode)
    }, [approvalMode])

    // Run configs фильтруем клиентски (список обычно маленький)
    const filteredRunConfigs = runConfigs.filter(rc => {
        if (!pickerSearch.trim()) return true
        const q = pickerSearch.toLowerCase()
        return rc.name?.toLowerCase().includes(q)
            || rc._id?.toLowerCase().includes(q)
            || entityShortDescription(rc).toLowerCase().includes(q)
    })

    const selectedWorkflowObj = (Array.isArray(workflows) ? workflows : []).find(wf => (wf._id || wf.id) === selectedWorkflow)
    const examplePrompts = sanitizeWorkflowPrompts(selectedWorkflowObj?.prompts)

    const selectionLabel = (() => {
        if (selectedRunConfig) {
            return `${selectedRunConfig.name}${selectedRunConfig.is_default ? ' (default)' : ''}`
        }
        if (selectedModelObj) return selectedModelObj.name || selectedModelObj.id
        if (selection?.kind === 'model') return selection.id
        return 'Select a run config or model…'
    })()

    const createProject = async () => {
        if (!prompt.trim() && selectedFiles.length === 0) return

        setLoading(true)

        // Immediately navigate to a loading project screen
        const tempProjectId = 'creating-' + Date.now()
        navigate(`/monitor/${tempProjectId}?creating=true`, {state: {userPrompt: prompt}})

        let orphanProjectId = null
        try {
            // Build request body. Selection is either a run config OR a single
            // model — never both. When a model is picked we set force_model=true
            // so it overrides every subsystem regardless of seeded run configs.
            const requestBody = {
                user_prompt: prompt,
                ...(selection?.kind === 'model'
                    ? {model_id: selection.id, force_model: true}
                    : selection?.kind === 'run_config'
                        ? {run_config_id: selection.id}
                        : {}),
                ...(selectedWorkflow ? {workflow_id: selectedWorkflow} : {}),
                // 'inherit' → omit so the run config (or backend 'human') decides.
                ...(approvalMode === 'inherit' ? {} : {approval_mode: approvalMode}),
            }
            // Only send a reasoning override when the user explicitly picked
            // an effort. The empty value ("Use default") leaves it to each
            // agent's own config, which the backend treats as no-override.
            if (selection?.kind === 'model' && controlMode !== 'hidden' && reasoningEffort) {
                requestBody.reasoning = {
                    enabled: true,
                    effort: reasoningEffort,
                }
            }
            if (showTemperature && temperatureOverride != null) {
                requestBody.temperature = temperatureOverride
            }

            const response = selectedFiles.length > 0
                ? await apiFetch('/projects', {
                    method: 'POST',
                    body: buildProjectCreateFormData(requestBody, selectedFiles),
                })
                : await apiFetch('/projects', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify(requestBody),
                })

            if (!response.ok) {
                const payload = await response.json().catch(() => ({}))
                orphanProjectId = projectIdFromApiDetail(payload?.detail)
                const detailText = formatApiDetail(payload?.detail) || `Server error (${response.status})`
                throw new Error(detailText)
            }

            const data = await response.json()
            // Navigate to the real project ID
            setSelectedFiles([])
            navigate(`/monitor/${data.project_id}`, {replace: true})
        } catch (error) {
            console.error('Error creating project:', error)
            const message = orphanProjectId
                ? `${String(error?.message || error)} — project kept without attachments`
                : String(error?.message || error)
            notify({title: 'Create failed', message, variant: 'error', ttl: 7000})
            // R2: backend keeps the project and returns project_id; open it instead of home.
            if (orphanProjectId) {
                navigate(`/monitor/${orphanProjectId}`, {replace: true})
            } else {
                navigate('/', {replace: true})
            }
        } finally {
            setLoading(false)
        }
    }

    return (
        <div className="min-h-screen bg-slate-900">
            {/* Header Bar */}
            <div className="px-8 py-6 border-b border-slate-800">
                <div className="flex items-center justify-between gap-4">
                    <h1 className="text-3xl font-bold text-slate-100">AppFactory</h1>
                    <TopNavLinks/>
                </div>
            </div>

            {/* Content Area */}
            <div className="flex items-center justify-center min-h-[calc(100vh-100px)]">
                <div className="max-w-2xl w-full p-8">
                    <div className="text-center mb-8">
                        <p className="text-slate-400 text-lg">Multi-Agent Orchestration System</p>
                    </div>

                    <div className="bg-slate-800 rounded-lg p-6 shadow-xl">
                        <label className="block text-sm font-medium text-slate-300 mb-2">
                            What would you like to build?
                        </label>
                        <AttachmentComposer
                            variant="home"
                            value={prompt}
                            onChange={setPrompt}
                            files={selectedFiles}
                            onFilesChange={setSelectedFiles}
                            placeholder="Describe your project... (e.g., 'Create a Telegram bot that scrapes news from a website')"
                            disabled={loading}
                            submitOnEnter={false}
                            minRows={5}
                        />

                        {/* Workflow Selector */}
                        {workflows.length > 0 && (
                            <div className="mt-4">
                                <label className="block text-sm font-medium text-slate-400 mb-1">Workflow</label>
                                <select
                                    value={selectedWorkflow || ''}
                                    onChange={(e) => setSelectedWorkflow(e.target.value)}
                                    className="w-full px-4 py-2.5 bg-slate-700 border border-slate-600 rounded-lg text-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500"
                                >
                                    {workflows.map(wf => (
                                        <option key={wf._id || wf.id} value={wf._id || wf.id}>
                                            {wf.name}{wf.is_default ? ' (default)' : ''}{wf.tenant_id === '__system__' ? ' · system' : ''}
                                        </option>
                                    ))}
                                </select>
                            </div>
                        )}

                        {examplePrompts.length > 0 && (
                            <div className="mt-4">
                                <label className="block text-sm font-medium text-slate-400 mb-1">Example prompts</label>
                                <div className="flex flex-wrap gap-2">
                                    {examplePrompts.map((p, i) => (
                                        <button
                                            key={i}
                                            type="button"
                                            onClick={() => setPrompt(p.text)}
                                            title={p.text}
                                            className="px-3 py-1.5 text-sm bg-slate-700 border border-slate-600 rounded-lg text-slate-200 hover:bg-slate-600 hover:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
                                        >
                                            {p.name}
                                        </button>
                                    ))}
                                </div>
                                <p className="mt-1.5 text-xs text-slate-500">Pick one to fill the request above, then edit it before starting.</p>
                            </div>
                        )}

                        <div className="mt-4 relative">
                            <label className="block text-sm font-medium text-slate-400 mb-1">
                                Run Configuration or Model
                            </label>
                            <button
                                type="button"
                                onClick={() => {
                                    setPickerOpen(!pickerOpen);
                                    setPickerSearch('');
                                }}
                                className="w-full flex items-center justify-between px-4 py-2.5 bg-slate-700 border border-slate-600 rounded-lg text-slate-200 hover:border-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
                            >
                                <span className="truncate flex items-center gap-2">
                                    {selection && (
                                        <span className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded ${selection.kind === 'run_config' ? 'bg-emerald-900/60 text-emerald-300' : 'bg-blue-900/60 text-blue-300'}`}>
                                            {selection.kind === 'run_config' ? 'Run Config' : 'Model'}
                                        </span>
                                    )}
                                    {selectionLabel}
                                    {selectedModelObj?.is_reasoning &&
                                        <Brain className="w-4 h-4 text-purple-400" title="Supports reasoning"/>}
                                </span>
                                <ChevronDown
                                    className={`w-4 h-4 ml-2 transition-transform ${pickerOpen ? 'rotate-180' : ''}`}/>
                            </button>

                            {pickerOpen && (
                                <div
                                    className="absolute z-50 mt-1 w-full bg-slate-700 border border-slate-600 rounded-lg shadow-xl">
                                    <input
                                        type="text"
                                        value={pickerSearch}
                                        onChange={(e) => setPickerSearch(e.target.value)}
                                        placeholder="Search run configs or models…"
                                        className="w-full px-3 py-2 bg-slate-800 border-b border-slate-600 text-slate-200 text-sm focus:outline-none"
                                        autoFocus
                                    />
                                    <div className="max-h-72 overflow-y-auto">
                                        {/* Run Configurations — клиентская фильтрация (список маленький) */}
                                        {filteredRunConfigs.length > 0 && (
                                            <>
                                                <div className="px-3 py-1.5 text-[10px] uppercase tracking-wide text-emerald-300 bg-slate-800/60 border-b border-slate-600">
                                                    Run Configurations
                                                </div>
                                                {filteredRunConfigs.map(rc => {
                                                    const isSelected = selection?.kind === 'run_config' && selection.id === rc._id
                                                    return (
                                                        <button
                                                            key={rc._id}
                                                            onClick={() => {
                                                                setSelection({kind: 'run_config', id: rc._id});
                                                                setPickerOpen(false);
                                                                setPickerSearch('');
                                                            }}
                                                            className={`w-full text-left px-3 py-2 hover:bg-slate-600 ${isSelected ? 'bg-emerald-900/40 text-emerald-200' : 'text-slate-200'}`}
                                                        >
                                                            <div className="flex items-center justify-between">
                                                                <span className="font-medium truncate text-sm">
                                                                    {rc.name}{rc.is_default ? ' (default)' : ''}
                                                                </span>
                                                                {rc.tenant_id === '__system__' && (
                                                                    <span className="text-xs text-slate-500 ml-2">system</span>
                                                                )}
                                                            </div>
                                                            {entityShortDescription(rc) && (
                                                                <div className="text-xs text-slate-500 truncate">{entityShortDescription(rc)}</div>
                                                            )}
                                                        </button>
                                                    )
                                                })}
                                            </>
                                        )}

                                        {/* Models — бэкендовый поиск + инфинити-лоад */}
                                        {(modelsLoading && models.length === 0) ? (
                                            <div className="px-3 py-4 text-slate-400 text-sm text-center">
                                                Loading models…
                                            </div>
                                        ) : models.length > 0 ? (
                                            <>
                                                <div className="px-3 py-1.5 text-[10px] uppercase tracking-wide text-blue-300 bg-slate-800/60 border-b border-t border-slate-600">
                                                    Models
                                                </div>
                                                {models.map(model => {
                                                    const isSelected = selection?.kind === 'model' && selection.id === model.id
                                                    return (
                                                        <button
                                                            key={model.id}
                                                            onClick={() => {
                                                                setSelection({kind: 'model', id: model.id});
                                                                setPickerOpen(false);
                                                                setPickerSearch('');
                                                            }}
                                                            className={`w-full text-left px-3 py-2 hover:bg-slate-600 ${isSelected ? 'bg-blue-900/40 text-blue-200' : 'text-slate-200'}`}
                                                        >
                                                            <div className="flex items-center justify-between">
                                                                <span className="font-medium truncate text-sm flex items-center gap-1.5">
                                                                    {model.name}
                                                                    {model.is_reasoning && <Brain className="w-3 h-3 text-purple-400"/>}
                                                                </span>
                                                                <span
                                                                    className={`text-xs flex-shrink-0 ml-2 ${model.is_free ? 'text-green-400' : 'text-slate-400'}`}>
                                                                    {model.is_free ? 'Free' : `$${(model.input_price || 0).toFixed(2)}/$${(model.output_price || 0).toFixed(2)}`}
                                                                </span>
                                                            </div>
                                                            <div className="text-xs text-slate-500 truncate">{model.id}</div>
                                                        </button>
                                                    )
                                                })}
                                                {/* Sentinel для инфинити-лоада */}
                                                {hasMore && (
                                                    <div ref={sentinelRef} className="px-3 py-2 text-center">
                                                        {loadingMore
                                                            ? <span className="text-xs text-slate-400">Loading more…</span>
                                                            : <span className="text-xs text-slate-500">Scroll for more</span>
                                                        }
                                                    </div>
                                                )}
                                            </>
                                        ) : null}

                                        {filteredRunConfigs.length === 0 && models.length === 0 && !modelsLoading && (
                                            <div className="px-3 py-4 text-slate-400 text-sm text-center">
                                                Nothing matches "{pickerSearch}"
                                            </div>
                                        )}
                                    </div>
                                </div>
                            )}
                            <p className="mt-1.5 text-xs text-slate-500">
                                {selection?.kind === 'model'
                                    ? 'This model will be used for every subsystem.'
                                    : selection?.kind === 'run_config'
                                        ? 'Each subsystem uses the model assigned by this run configuration.'
                                        : null}
                            </p>
                        </div>

                        <div className="mt-4 border-t border-slate-700 pt-4">
                            <button
                                type="button"
                                onClick={() => setAdvancedOpen((open) => !open)}
                                className="flex items-center gap-2 text-sm font-medium text-slate-400 hover:text-slate-200 focus:outline-none"
                            >
                                <SlidersHorizontal className="w-4 h-4"/>
                                Advanced params
                                <ChevronDown className={`w-4 h-4 transition-transform ${advancedOpen ? 'rotate-180' : ''}`}/>
                            </button>
                        </div>

                        {advancedOpen && (
                        <>
                        {/* Approval mode (AppFactory-322) */}
                        <div className="mt-4">
                            <label className="block text-sm font-medium text-slate-400 mb-1">Approval</label>
                            <select
                                value={approvalMode}
                                onChange={(e) => setApprovalMode(e.target.value)}
                                className="w-full px-4 py-2.5 bg-slate-700 border border-slate-600 rounded-lg text-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500"
                            >
                                <option value="auto">Auto-approve — skip all gates</option>
                                <option value="human">Require approval at each gate (default)</option>
                                <option value="inherit">Use run configuration's setting</option>
                            </select>
                            <p className="mt-1.5 text-xs text-slate-500">
                                {approvalMode === 'auto'
                                    ? 'Runs end-to-end without pausing — no human review of requirements, plan, or output.'
                                    : approvalMode === 'human'
                                        ? 'Pauses at each gate (requirements, plan, output) to wait for your approval.'
                                        : "Uses the selected run configuration's approval setting, or human review if it has none."}
                            </p>
                        </div>

                        {/* Reasoning effort (only for reasoning-capable models). The
                            previous "Enable Reasoning" checkbox was removed because
                            unchecking it didn't actually disable reasoning — agents
                            just fell back to their static "medium" default. The
                            dropdown alone now reflects the real semantic. */}
                        {showReasoning && (
                            <div className="mt-3 p-3 bg-slate-700/50 border border-purple-800/50 rounded-lg">
                                {useEffortSelect ? (
                                    <>
                                        <div className="flex items-center justify-between gap-3">
                                            <label className="flex items-center gap-2 text-sm text-slate-300">
                                                <Brain className="w-4 h-4 text-purple-400"/>
                                                Reasoning effort
                                            </label>
                                            <select
                                                value={reasoningEffort}
                                                onChange={(e) => setReasoningEffort(e.target.value)}
                                                className="bg-slate-600 border border-slate-500 rounded px-2 py-1 text-sm text-slate-200 focus:outline-none focus:ring-2 focus:ring-purple-500"
                                            >
                                                <option value="">Use default</option>
                                                {selectedEffortIsUnsupported && (
                                                    <option value={reasoningEffort} disabled>
                                                        {reasoningEffort} (not supported)
                                                    </option>
                                                )}
                                                {reasoningEfforts.map(effort => (
                                                    <option key={effort} value={effort}>{effort}</option>
                                                ))}
                                            </select>
                                        </div>
                                        <p className="text-xs text-slate-500 mt-2">
                                            {reasoningEffort
                                                ? "Overrides every agent's configured effort for this run. Higher = more thorough but slower & more tokens."
                                                : 'Each agent uses the effort wired into its own config. Pick a value to override the whole project.'}
                                        </p>
                                    </>
                                ) : (
                                    <>
                                        <label className="flex items-center gap-2 text-sm text-slate-300">
                                            <input
                                                type="checkbox"
                                                checked={Boolean(reasoningEffort)}
                                                onChange={(e) => setReasoningEffort(
                                                    e.target.checked ? (reasoning?.default_effort || 'medium') : '',
                                                )}
                                                className="accent-purple-500"
                                            />
                                            <Brain className="w-4 h-4 text-purple-400"/>
                                            Enable reasoning
                                        </label>
                                        <p className="text-xs text-slate-500 mt-2">This model exposes no effort selector — using a best-effort default</p>
                                    </>
                                )}
                            </div>
                        )}

                        {showTemperature && (
                            <div className="mt-3 p-3 bg-slate-700/50 border border-blue-800/50 rounded-lg">
                                <label className="flex items-center gap-2 text-sm text-slate-300">
                                    <input
                                        type="checkbox"
                                        checked={temperatureOverride != null}
                                        disabled={temperatureControl.disabled}
                                        onChange={(e) => setTemperatureOverride(
                                            e.target.checked
                                                ? (temperature?.forced ?? Math.min(temperature?.max ?? 2, Math.max(temperature?.min ?? 0, 1)))
                                                : null,
                                        )}
                                        className="accent-blue-500"
                                    />
                                    Temperature{temperatureOverride != null ? `: ${temperatureOverride}` : ''}
                                </label>
                                {temperatureOverride != null && (
                                    <input
                                        type="range"
                                        min={temperature?.forced ?? temperature?.min ?? 0}
                                        max={temperature?.forced ?? temperature?.max ?? 2}
                                        step="0.1"
                                        value={temperatureControl.displayValue}
                                        disabled={temperatureControl.disabled}
                                        onChange={(e) => setTemperatureOverride(parseFloat(e.target.value))}
                                        className="w-full mt-2 accent-blue-500 disabled:opacity-50"
                                    />
                                )}
                                {temperature?.supported === false && (
                                    <p className="text-xs text-slate-500 mt-2">Catalog marks this unsupported — may be dropped by the provider</p>
                                )}
                                {temperature?.forced != null && (
                                    <p className="text-xs text-slate-500 mt-2">Fixed at {temperature.forced} for this model</p>
                                )}
                            </div>
                        )}
                        </>
                        )}

                        {selection?.kind === 'model' && modelConfigError && (
                            <p className="mt-3 text-xs text-red-400">{modelConfigError}</p>
                        )}

                        <button
                            onClick={createProject}
                            disabled={loading || (!prompt.trim() && selectedFiles.length === 0)}
                            className="mt-4 w-full bg-blue-600 hover:bg-blue-700 disabled:bg-slate-600 text-white font-medium py-3 px-4 rounded-lg transition-colors"
                        >
                            {loading ? 'Starting...' : 'Start Project'}
                        </button>
                    </div>

                    <div className="mt-8 flex flex-wrap items-center justify-center gap-6">
                        <Link
                            to="/workflow-builder"
                            className="text-blue-400 hover:text-blue-300 inline-flex items-center gap-2"
                        >
                            <Workflow className="w-4 h-4"/>
                            Open Workflow Builder
                        </Link>
                        <Link
                            to="/run-configurations"
                            className="text-blue-400 hover:text-blue-300 inline-flex items-center gap-2"
                        >
                            <SlidersHorizontal className="w-4 h-4"/>
                            Open Run Configurations
                        </Link>
                    </div>
                </div>
            </div>
        </div>
    )
}

function AppContent() {
    const buildId = import.meta.env.VITE_BUILD_ID || 'dev'
    const location = useLocation()

    // Show health badge only on home page (/)
    const showHealthBadge = location.pathname === '/'
    const shellPrefixes = ['/', '/monitor/', '/projects', '/workflow-builder', '/run-configurations', '/settings']
    const isShellPage = shellPrefixes.some((p) => location.pathname === p || location.pathname.startsWith(p))

    return (
        <div className="min-h-screen bg-slate-900">
            <NotificationCenter/>
            {!isShellPage && (
                <nav className="bg-slate-800 border-b border-slate-700">
                    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
                        <div className="flex justify-between h-16">
                            <div className="flex items-center space-x-6">
                                <Link
                                    to="/"
                                    className="inline-flex items-center px-1 pt-1 text-sm font-medium text-slate-300 hover:text-white"
                                >
                                    <Home className="w-4 h-4 mr-2"/>
                                    Home
                                </Link>
                                <Link
                                    to="/workflow-builder"
                                    className="inline-flex items-center px-1 pt-1 text-sm font-medium text-slate-300 hover:text-white"
                                >
                                    <Workflow className="w-4 h-4 mr-2"/>
                                    Workflow Builder
                                </Link>
                                <Link
                                    to="/run-configurations"
                                    className="inline-flex items-center px-1 pt-1 text-sm font-medium text-slate-300 hover:text-white"
                                >
                                    <SlidersHorizontal className="w-4 h-4 mr-2"/>
                                    Run Configs
                                </Link>
                                <Link
                                    to="/projects"
                                    className="inline-flex items-center px-1 pt-1 text-sm font-medium text-slate-300 hover:text-white"
                                >
                                    <Activity className="w-4 h-4 mr-2"/>
                                    Projects
                                </Link>
                                <Link
                                    to="/settings"
                                    className="inline-flex items-center px-1 pt-1 text-sm font-medium text-slate-300 hover:text-white"
                                >
                                    Settings
                                </Link>
                            </div>
                        </div>
                    </div>
                </nav>
            )}

            <Routes>
                <Route path="/login" element={<Login/>}/>
                        <Route path="/forgot-password" element={<ForgotPassword/>}/>
        <Route path="/reset-password" element={<ResetPassword/>}/>
                <Route path="/" element={<ProtectedRoute><HomePage/></ProtectedRoute>}/>
                <Route path="/workflow-builder" element={<ProtectedRoute><WorkflowEditor/></ProtectedRoute>}/>
                <Route path="/projects" element={<ProtectedRoute><Projects/></ProtectedRoute>}/>
                <Route path="/settings"
                       element={<ProtectedRoute requiredRole="root"><Settings/></ProtectedRoute>}/>
                <Route path="/configurations/agents"
                       element={<ProtectedRoute requiredRole="tenant_admin"><AgentConfigurations/></ProtectedRoute>}/>
                <Route path="/configurations/workflows"
                    element={<Navigate to="/workflow-builder" replace />}/>
                <Route path="/configurations/tools"
                       element={<ProtectedRoute requiredRole="tenant_admin"><ToolConfigurations/></ProtectedRoute>}/>
                <Route path="/configurations/mcp-tools"
                       element={<ProtectedRoute requiredRole="tenant_admin"><McpToolConfigurations/></ProtectedRoute>}/>
                <Route path="/configurations/users"
                       element={<ProtectedRoute requiredRole="tenant_admin"><UserManagement/></ProtectedRoute>}/>
                <Route path="/configurations/tenants"
                       element={<ProtectedRoute requiredRole="root"><TenantManagement/></ProtectedRoute>}/>
                <Route path="/configurations/tenant-settings"
                       element={<ProtectedRoute requiredRole="tenant_admin"><TenantSettings/></ProtectedRoute>}/>
                <Route path="/configurations/tenant-artifacts"
                       element={<ProtectedRoute requiredRole="tenant_admin"><TenantArtifacts/></ProtectedRoute>}/>
                <Route path="/configurations/bundle"
                       element={<ProtectedRoute requiredRole="tenant_admin"><ConfigBundle/></ProtectedRoute>}/>
                <Route path="/run-configurations" element={<ProtectedRoute><RunConfigurations/></ProtectedRoute>}/>
                <Route path="/configurations/run-configurations"
                       element={<ProtectedRoute><Navigate to="/run-configurations" replace /></ProtectedRoute>}/>
                <Route path="/monitor/:projectId" element={<ProtectedRoute><ExecutionMonitor/></ProtectedRoute>}/>
                <Route path="/configurations/a2a" element={<ProtectedRoute><A2AConfigurations /></ProtectedRoute>} />
                <Route path="*" element={<NotFound/>}/>
            </Routes>

            {showHealthBadge && (
                <div className="fixed bottom-2 left-3">
                    <BackendStatusBadge/>
                </div>
            )}

            <div className="fixed bottom-2 right-3 text-[10px] text-slate-500 select-none">
                UI build: {buildId}
            </div>
        </div>
    )
}

function App() {
    return (
        <Router>
            <AuthProvider>
                <AppContent/>
            </AuthProvider>
        </Router>
    )
}

export default App