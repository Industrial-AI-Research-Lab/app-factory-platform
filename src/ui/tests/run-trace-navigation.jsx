import React from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import ExecutionMonitor from '../src/pages/ExecutionMonitor'
import RunTraceNavigation from '../src/components/monitor/RunTraceNavigation'
import { AuthProvider } from '../src/hooks/useAuth'
import '../src/index.css'

const params = new URLSearchParams(window.location.search)
const activeId = params.has('long') ? 'active-' + '0123456789'.repeat(18) : 'active-run'
const parent = {
  run_id: 'parent-run',
  project_id: 'project-1',
  active: false,
  run_status: 'completed',
  trace_url: 'https://jaeger.example.com/trace/' + '1'.repeat(32),
}
const active = {
  run_id: activeId,
  project_id: 'project-1',
  active: true,
  run_status: 'completed',
  restored_from: { run_id: parent.run_id, point_id: 'point-1' },
  trace_url: 'https://jaeger.example.com/trace/' + '2'.repeat(32),
}
const legacy = { run_id: 'legacy-run', project_id: 'project-1', active: false, trace_url: null }
const summary = {
  project_id: 'project-1',
  current_run_id: active.run_id,
  title: 'Run navigation regression',
  user_prompt: 'Open a trace for its Run',
  status: 'completed',
  current_phase: 'completed',
  conversation_history: [],
  pending_approvals: [],
}
const requests = []
const result = document.getElementById('result')
let sourceAttempts = 0
let checkpointAttempts = 0
let releaseSource
let slowSource = false
let releaseProject
const nextRun = { ...legacy, run_id: 'next-run', project_id: 'project-3', active: true, trace_url: 'https://jaeger.example.com/trace/' + '3'.repeat(32) }

window.fetch = async (input, options = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url, window.location.origin)
  const method = options.method || 'GET'
  requests.push({ path: url.pathname, method })
  if (method !== 'GET') throw new Error('Navigation attempted a mutation: ' + method)
  let value = {}
  let status = 200
  if (url.pathname.endsWith('/events')) {
    const stream = new ReadableStream({
      start(controller) {
        options.signal?.addEventListener(
          'abort',
          () => controller.error(new DOMException('Aborted', 'AbortError')),
          { once: true },
        )
      },
    })
    return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } })
  }
  if (url.pathname === '/api/projects/project-1') value = summary
  else if (url.pathname === '/api/projects/project-2') {
    await new Promise((resolve) => { releaseProject = resolve })
    value = { ...summary, project_id: 'project-2', metadata: { last_revert_prefill: 'Stale project draft' } }
  } else if (url.pathname === '/api/projects/project-3')
    value = { ...summary, project_id: 'project-3', current_run_id: nextRun.run_id }
  else if (url.pathname === '/api/projects/project-2/runs') value = { runs: [] }
  else if (url.pathname === '/api/projects/project-3/runs') value = { runs: [nextRun] }
  else if (url.pathname === '/api/projects/project-3/runs/next-run') value = nextRun
  else if (url.pathname === '/api/projects/project-1/runs')
    value = { runs: params.has('absentActive') ? [legacy] : [active, legacy] }
  else if (url.pathname.endsWith('/runs/parent-run/points')) {
    value = { points: [
      { point_id: 'different-point', label: 'Wrong checkpoint' },
      { point_id: 'point-1', label: 'Hypotheses saved', time: '2026-09-14T18:13:22Z' },
    ] }
    if (params.has('checkpointMissing')) value = { points: [] }
    if (params.has('checkpointError') && ++checkpointAttempts === 1) {
      if (params.get('checkpointError') === 'network') throw new TypeError('Failed to fetch')
      value = { detail: 'Access denied' }
      status = 403
    }
  } else if (url.pathname.startsWith('/api/projects/project-1/runs/')) {
    const runId = decodeURIComponent(url.pathname.split('/').pop())
    value = [active, parent, legacy].find((run) => run.run_id === runId)
    if (runId === parent.run_id && slowSource)
      await new Promise((resolve) => { releaseSource = resolve })
    if (runId === parent.run_id && params.has('missing') && ++sourceAttempts === 1)
      value = null
    if (!value) {
      value = { detail: 'Run not found' }
      status = 404
    }
  } else if (url.pathname.endsWith('/messages')) value = { messages: [] }
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function waitFor(predicate, message) {
  const deadline = performance.now() + 6000
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error(message)
    await new Promise((resolve) => requestAnimationFrame(resolve))
  }
}

const button = (label) => [...document.querySelectorAll('button')]
  .find((element) => element.textContent.trim() === label)
const traceLinks = () => [...document.querySelectorAll('a')]
  .filter((link) => link.textContent.trim() === 'Open in Jaeger')

const root = createRoot(document.getElementById('root'))
const renderMonitor = (projectId) => root.render(
  <MemoryRouter initialEntries={['/monitor/project-1?run=parent-run']}>
    <AuthProvider>
      <ExecutionMonitor projectId={projectId} />
    </AuthProvider>
  </MemoryRouter>,
)
renderMonitor('project-1')

async function verifyProjectSwitch() {
  renderMonitor('project-2')
  await waitFor(() => releaseProject, 'The next project summary request did not start')
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  assert(
    !requests.some((request) => request.path === '/api/projects/project-2/runs/' + active.run_id),
    'Project change requested the previous project’s active Run',
  )
  assert(traceLinks().length === 0, 'Project change displayed the previous project’s trace')
  renderMonitor('project-3')
  await waitFor(() => traceLinks().some((link) => link.href === nextRun.trace_url), 'The new project trace did not load')
  releaseProject()
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  assert(traceLinks().length === 1 && traceLinks()[0].href === nextRun.trace_url, 'A late project summary replaced the current trace')
  assert(!requests.some((request) => request.path === '/api/projects/project-3/runs/' + active.run_id), 'A late project summary requested the previous active Run')
  assert(!document.querySelector('textarea')?.value.includes('Stale project draft'), 'A late project summary replaced the chat draft')
  result.textContent = 'PASS: project switch clears old Run and trace, late summary leaves current Run and chat unchanged'
  result.style.color = '#86efac'
}

async function verify() {
  await waitFor(
    () => traceLinks().some((link) => link.href === active.trace_url),
    'The collapsed panel did not load the canonical current Run trace',
  )
  assert(traceLinks().length === 1, 'The old query selected a different trace')
  if (params.has('projectSwitch')) return verifyProjectSwitch()
  const show = button('Show')
  assert(show, 'Run list control is missing')
  const source = [...document.querySelectorAll('button')]
    .find((element) => element.textContent.trim() === 'View source')
  assert(source, 'Restored Run has no source view action')
  const chatInput = document.querySelector('textarea')
  const projectReads = requests.filter((request) => request.path === '/api/projects/project-1').length
  const href = window.location.href
  source.click()
  await waitFor(() => document.querySelector('[aria-label="Source Run"]'), 'Source view did not open')

  if (params.has('missing')) {
    await waitFor(() => button('Retry source'), 'Unavailable source has no recovery action')
    assert(traceLinks().length === 1, 'Unavailable source displayed a stale trace')
    button('Retry source').click()
  }
  if (params.has('checkpointError')) {
    await waitFor(
      () => document.querySelector('[aria-label="Source Run"] a') && button('Retry source'),
      'Failed checkpoint lookup has no recovery action',
    )
    const failedView = document.querySelector('[aria-label="Source Run"]')
    assert(failedView.textContent.includes('Could not load checkpoint details.'), 'Failed checkpoint lookup is presented as a missing saved checkpoint')
    assert(!failedView.textContent.includes('Checkpoint details are unavailable.'), 'Checkpoint request failure uses the successful-empty message')
    assert(failedView.textContent.includes('point-1'), 'Checkpoint request failure lost the recorded restore ID')
    assert(failedView.querySelector('a').href === parent.trace_url, 'Checkpoint request failure hid the source trace')
    button('Retry source').click()
  }
  await waitFor(
    () => document.querySelector('[aria-label="Source Run"]')?.textContent.includes(
      params.has('checkpointMissing') ? 'Checkpoint details are unavailable.' : 'Hypotheses saved',
    ),
    'The exact source checkpoint did not load',
  )
  if (params.has('checkpointMissing')) assert(!button('Retry source'), 'Successful empty checkpoint lookup offered an error retry')
  const sourceView = document.querySelector('[aria-label="Source Run"]')
  assert(sourceView.contains(document.activeElement), 'Source view did not receive focus')
  assert(sourceView.querySelector('a').href === parent.trace_url, 'Source view has the wrong trace')
  assert(sourceView.textContent.includes('point-1'), 'Restore checkpoint identity is missing')
  assert(!sourceView.textContent.includes('Wrong checkpoint'), 'Displayed an unrelated checkpoint')
  const activeRow = document.getElementById('run-' + active.run_id)
  assert(activeRow.querySelector('a').href === active.trace_url, 'Active row trace changed')
  assert(activeRow.textContent.includes('ACTIVE'), 'Source navigation changed the active Run')
  assert(traceLinks().length === 1, 'Source view replaced the active Run link')
  assert(!document.body.textContent.includes('Inspect Run'), 'Ambiguous inspection action remains')
  assert(window.location.href === href, 'Source navigation changed the page URL')
  assert(document.querySelector('textarea') === chatInput, 'Source navigation remounted the chat')
  assert(
    requests.filter((request) => request.path === '/api/projects/project-1').length === projectReads,
    'Source navigation reloaded the project',
  )
  sourceView.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await waitFor(() => !document.querySelector('[aria-label="Source Run"]'), 'Escape did not close source view')
  assert(document.activeElement === source, 'Closing source view did not return focus')
  assert(requests.every((request) => request.method === 'GET'), 'Navigation mutated a Run')

  slowSource = true
  root.render(<RunTraceNavigation projectId="project-1" run={active} />)
  await waitFor(() => !document.querySelector('textarea') && button('View source'), 'Race fixture did not mount')
  button('View source').click()
  await waitFor(() => releaseSource, 'Delayed source request did not start')
  root.render(<RunTraceNavigation projectId="project-2" run={{ ...active, trace_url: null }} />)
  await waitFor(() => !document.querySelector('[aria-label="Source Run"]'), 'Project change kept previous source view open')
  releaseSource()
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  assert(!document.querySelector('[aria-label="Source Run"]'), 'Late source response reopened old project details')
  assert(!document.querySelector('a'), 'Late source response leaked a stale trace link')
  result.textContent = 'PASS: exact checkpoint, source trace, recovery, unchanged chat/active Run, Escape focus, and late-response isolation'
  result.style.color = '#86efac'
}

verify().catch((error) => {
  result.textContent = 'FAIL: ' + error.message
  result.style.color = '#fca5a5'
})
