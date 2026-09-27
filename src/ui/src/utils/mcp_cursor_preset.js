/**
 * Parse Cursor-style ~/.cursor/mcp.json (or Devin-style) into AppFactory
 * External MCP discovery form fields.
 *
 * Supported per-server keys (subset of Cursor):
 * - url + optional headers, timeout, transport (AppFactory extension: "http" | "streamable-http")
 * - command + args + env + timeout (local stdio)
 * - image + args + env + timeout (docker stdio)
 * - disabled, disabledTools (warnings only; not applied to form)
 *
 * When options.runNpxInDocker is true (default), preset entries with command "npx" map to Docker stdio:
 * image options.npxRunnerImage or DEFAULT_MCP_NPX_DOCKER_IMAGE,
 * docker_cmd_args = [npx, ...args] unless the image name matches mcp-npx-runner (ENTRYPOINT npx).
 */

/** Public Node image (Docker Hub); no private registry required. Override with org-built mcp-npx-runner if desired. */
export const DEFAULT_MCP_NPX_DOCKER_IMAGE = 'node:22-bookworm-slim'

/** True when image is built with ENTRYPOINT ["npx"] (e.g. docker/mcp-npx-runner). */
function dockerImageUsesNpxEntrypoint(imageTag) {
  return /mcp-npx-runner/i.test(String(imageTag || ''))
}

export function defaultDiscoverFormShape() {
  return {
    server_id: '',
    mode: 'http',
    timeout_seconds: 30,
    endpoint: '',
    headers: [],
    image: '',
    docker_env_vars_raw: '',
    docker_cmd_args_raw: '',
    command: '',
    command_args_raw: '',
    command_env_raw: '',
  }
}

function clampTimeoutSecondsFromMs(ms) {
  if (typeof ms !== 'number' || Number.isNaN(ms) || ms <= 0) return null
  const sec = Math.round(ms / 1000)
  return Math.min(300, Math.max(1, sec))
}

/** Match ToolConfigurations.parseEnvVars round-trip: KEY=VALUE, KEY2=VALUE2 */
export function envObjectToCommaRaw(env) {
  if (!env || typeof env !== 'object') return ''
  const parts = []
  for (const [k, v] of Object.entries(env)) {
    if (!k || typeof k !== 'string') continue
    parts.push(`${k.trim()}=${String(v)}`)
  }
  return parts.join(', ')
}

export function headersObjectToList(headers) {
  if (!headers || typeof headers !== 'object') return []
  return Object.entries(headers).map(([name, value]) => ({
    name: String(name),
    value: String(value),
  }))
}

function argsArrayToRawString(args) {
  if (!Array.isArray(args)) return ''
  return args
    .map((a) => {
      const s = String(a)
      if (/[\s"']/.test(s)) return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
      return s
    })
    .join(' ')
}

function parseDockerRunCommand(rawArgs) {
  const args = Array.isArray(rawArgs) ? rawArgs.map((a) => String(a)) : []
  if (!args.length || args[0] !== 'run') return null

  const consumedFlags = new Set([
    '-i', '--interactive',
    '--rm',
    '-t', '--tty',
    '-d', '--detach',
  ])

  let image = ''
  const postImageArgs = []
  const envNameTokens = []
  const warnings = []

  for (let i = 1; i < args.length; i += 1) {
    const a = args[i]
    if (!image) {
      if (consumedFlags.has(a)) continue
      if (a === '-e' || a === '--env') {
        const next = args[i + 1]
        if (next) {
          envNameTokens.push(next)
          i += 1
          continue
        }
      }
      if (a.startsWith('-e=')) {
        envNameTokens.push(a.slice(3))
        continue
      }
      if (a.startsWith('--env=')) {
        envNameTokens.push(a.slice(6))
        continue
      }
      // Unknown docker-run flags before image: skip next token for flags with value.
      if (a.startsWith('-')) {
        const next = args[i + 1]
        if (next && !next.startsWith('-')) i += 1
        continue
      }
      image = a
      continue
    }
    postImageArgs.push(a)
  }

  if (!image) return null
  for (const token of envNameTokens) {
    if (token.includes('=')) continue
    warnings.push(`docker run: env token "${token}" expects a value from the env block.`)
  }
  return { image, postImageArgs, warnings }
}

function resolveUrlMode(entry, url) {
  const t = entry.transport || entry.streamTransport
  if (t === 'http' || t === 'json-rpc') return 'http'
  if (t === 'streamable-http' || t === 'sse') return 'streamable-http'
  try {
    const u = new URL(url)
    if (u.protocol === 'https:') return 'streamable-http'
    return 'http'
  } catch {
    return 'streamable-http'
  }
}

/**
 * @param {string} serverKey — key from mcpServers
 * @param {object} entry — server config object
 * @param {{ runNpxInDocker?: boolean, npxRunnerImage?: string }} [options]
 * @returns {{ form: ReturnType<defaultDiscoverFormShape>, warnings: string[] }}
 */
export function cursorEntryToDiscoverForm(serverKey, entry, options = {}) {
  const warnings = []
  const form = defaultDiscoverFormShape()
  const runNpxInDocker = options.runNpxInDocker !== false
  const npxImage = (options.npxRunnerImage || DEFAULT_MCP_NPX_DOCKER_IMAGE).trim()

  if (!serverKey || typeof serverKey !== 'string') {
    throw new Error('Invalid server name in mcpServers')
  }
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error('MCP entry must be an object')
  }

  form.server_id = serverKey.trim()

  // Claude wrappers: support objects that contain mcpServers/servers inside.
  const wrappedServers = entry.mcpServers ?? entry.servers
  if (wrappedServers && typeof wrappedServers === 'object' && !Array.isArray(wrappedServers)) {
    const nested = wrappedServers[serverKey] || wrappedServers[form.server_id]
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      entry = nested
    } else {
      const first = Object.values(wrappedServers).find((v) => v && typeof v === 'object' && !Array.isArray(v))
      if (first) {
        entry = first
        warnings.push('Claude wrapper with nested mcpServers detected; applied the first server entry.')
      }
    }
  }

  if (entry.disabled === true) {
    warnings.push('Server is marked disabled in the preset — enable manually if needed.')
  }
  if (Array.isArray(entry.disabledTools) && entry.disabledTools.length > 0) {
    warnings.push(
      `Preset lists disabledTools (${entry.disabledTools.length}) — AppFactory does not hide tools automatically; disable extras after import.`,
    )
  }

  const timeoutSec = clampTimeoutSecondsFromMs(entry.timeout)
  if (timeoutSec != null) form.timeout_seconds = timeoutSec

  if (entry.url && typeof entry.url === 'string') {
    form.endpoint = entry.url.trim()
    form.mode = resolveUrlMode(entry, form.endpoint)
    form.headers = headersObjectToList(entry.headers)
    form.image = ''
    form.docker_env_vars_raw = ''
    form.docker_cmd_args_raw = ''
    form.command = ''
    form.command_args_raw = ''
    form.command_env_raw = ''
    return { form, warnings }
  }

  if (entry.image && typeof entry.image === 'string') {
    form.mode = 'stdio'
    form.endpoint = ''
    form.headers = []
    form.image = entry.image.trim()
    form.docker_env_vars_raw = envObjectToCommaRaw(entry.env)
    form.docker_cmd_args_raw = argsArrayToRawString(entry.args)
    form.command = ''
    form.command_args_raw = ''
    form.command_env_raw = ''
    return { form, warnings }
  }

  if (entry.command && typeof entry.command === 'string') {
    const cmdLower = entry.command.trim().toLowerCase()
    if (cmdLower === 'docker') {
      const parsedDocker = parseDockerRunCommand(entry.args)
      if (parsedDocker) {
        form.mode = 'stdio'
        form.endpoint = ''
        form.headers = []
        form.image = parsedDocker.image
        form.docker_cmd_args_raw = argsArrayToRawString(parsedDocker.postImageArgs)
        form.docker_env_vars_raw = envObjectToCommaRaw(entry.env)
        form.command = ''
        form.command_args_raw = ''
        form.command_env_raw = ''
        warnings.push(
          'Docker MCP: docker run command converted to image + docker args for AppFactory.',
        )
        warnings.push(...parsedDocker.warnings)
        return { form, warnings }
      }
      warnings.push(
        'docker command found but args do not look like docker run; kept local command mode.',
      )
    }
    if (runNpxInDocker && cmdLower === 'npx') {
      form.mode = 'stdio'
      form.endpoint = ''
      form.headers = []
      form.image = npxImage
      form.docker_env_vars_raw = envObjectToCommaRaw(entry.env)
      const rawArgs = Array.isArray(entry.args) ? entry.args : []
      const dockerArgs = dockerImageUsesNpxEntrypoint(npxImage) ? rawArgs : ['npx', ...rawArgs]
      form.docker_cmd_args_raw = argsArrayToRawString(dockerArgs)
      form.command = ''
      form.command_args_raw = ''
      form.command_env_raw = ''
      if (dockerImageUsesNpxEntrypoint(npxImage)) {
        warnings.push(
          `npx in Docker: image ${npxImage} (ENTRYPOINT npx). Ensure the image is in a registry reachable from the API host (docker pull / docker login).`,
        )
      } else {
        warnings.push(
          `npx in Docker: image ${npxImage} from Docker Hub; container needs outbound npm access on first package run.`,
        )
      }
      return { form, warnings }
    }
    form.mode = 'stdio'
    form.endpoint = ''
    form.headers = []
    form.image = ''
    form.docker_env_vars_raw = ''
    form.docker_cmd_args_raw = ''
    form.command = entry.command.trim()
    form.command_args_raw = argsArrayToRawString(entry.args)
    form.command_env_raw = envObjectToCommaRaw(entry.env)
    warnings.push(
      'Local stdio command: without Node/Python on the API host the command may be missing; prefer url or docker image in production.',
    )
    return { form, warnings }
  }

  throw new Error(
    'Unknown entry format: need url (HTTP MCP), image (Docker stdio), or command (local stdio).',
  )
}

/**
 * Remove dangling commas before `}` or `]` (so JSON.parse matches Cursor/JSON5-style hand edits).
 * @param {string} s
 * @returns {string}
 */
export function stripTrailingCommasForMcpJson(s) {
  const input = String(s || '')
  let out = ''
  let inString = false
  let escaped = false
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i]
    if (inString) {
      out += ch
      if (escaped) {
        escaped = false
      } else if (ch === '\\') {
        escaped = true
      } else if (ch === '"') {
        inString = false
      }
      continue
    }
    if (ch === '"') {
      inString = true
      out += ch
      continue
    }
    if (ch === ',') {
      let j = i + 1
      while (j < input.length && /\s/.test(input[j])) j += 1
      if (j < input.length && (input[j] === '}' || input[j] === ']')) {
        continue
      }
    }
    out += ch
  }
  return out
}

/**
 * @param {string} jsonText
 * @returns {{ entries: [string, object][] }}
 */
export function parseCursorMcpServersJson(jsonText) {
  const stripLinePrefixes = (s) =>
    String(s || '').replace(/^\s*L\d+:\s?/gm, '')

  const stripCodeFences = (s) =>
    String(s || '')
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '')

  const removeTrailingCommas = (s) => stripTrailingCommasForMcpJson(s)

  const isServerLikeEntry = (v) => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return false
    return !!(
      (typeof v.url === 'string' && v.url.trim()) ||
      (typeof v.command === 'string' && v.command.trim()) ||
      (typeof v.image === 'string' && v.image.trim()) ||
      Array.isArray(v.args) ||
      (typeof v.transport === 'string' && v.transport.trim()) ||
      (typeof v.timeout === 'number')
    )
  }

  const normalizeToServerEntries = (data) => {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null
    const direct = data.mcpServers ?? data.servers
    if (direct && typeof direct === 'object' && !Array.isArray(direct)) {
      const entries = Object.entries(direct).filter(
        ([k, v]) => typeof k === 'string' && isServerLikeEntry(v),
      )
      if (entries.length > 0) return entries
    }
    // Accept snippets that are already body of mcpServers.
    const entries = Object.entries(data).filter(
      ([k, v]) => typeof k === 'string' && isServerLikeEntry(v),
    )
    if (entries.length > 0) return entries
    return null
  }

  const base = stripLinePrefixes(stripCodeFences((jsonText || '').trim()))
  if (!base) {
    throw new Error('Empty JSON: paste mcp.json or an mcpServers fragment')
  }

  const candidates = [
    base,
    `{${base}}`,
    `{"mcpServers": ${base}}`,
    `{"mcpServers": {${base}}}`,
  ]

  let lastErr = null
  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c)
      const entries = normalizeToServerEntries(parsed)
      if (entries && entries.length > 0) return { entries }
    } catch (e) {
      lastErr = e
    }
  }
  for (const c of candidates.map(removeTrailingCommas)) {
    try {
      const parsed = JSON.parse(c)
      const entries = normalizeToServerEntries(parsed)
      if (entries && entries.length > 0) return { entries }
    } catch (e) {
      lastErr = e
    }
  }

  const msg = lastErr?.message || 'could not recognize format'
  throw new Error(
    `Failed to parse JSON. Supported: full mcp.json, "mcpServers" fragments, or individual servers. Reason: ${msg}`,
  )
}
