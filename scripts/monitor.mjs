import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const fields = ['prompt_tokens', 'completion_tokens', 'total_tokens', 'cached_tokens', 'reasoning_tokens']
const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => ['PATH', 'HOME', 'USER', 'LANG', 'TZ', 'XDG_CONFIG_HOME'].includes(key)))
function count(value, signed = false) {
  if (!Number.isSafeInteger(value) || (!signed && value < 0)) throw Error('Invalid native counters')
  return value
}
const normalized = (totals, signed = false) => {
  const prompt = count(totals.uncachedInputTokens, signed) + count(totals.cacheReadTokens, signed) + count(totals.cacheWriteTokens, signed)
  const output = count(totals.outputTokens, signed)
  return { prompt_tokens: count(prompt, signed), completion_tokens: output, total_tokens: count(prompt + output, signed),
    cached_tokens: totals.cacheReadTokens, reasoning_tokens: null }
}
const zero = () => ({ uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })
function sum(items) {
  return Object.fromEntries(fields.map(field => {
    const values = items.map(item => item?.[field]).filter(value => Number.isSafeInteger(value))
    return [field, values.length ? values.reduce((a, b) => a + b, 0) : null]
  }))
}
function difference(a, b) {
  return Object.fromEntries(fields.map(field => [field, Number.isSafeInteger(a?.[field]) && Number.isSafeInteger(b?.[field]) ? a[field] - b[field] : null]))
}

async function sessionUsage(config, since, until) {
  const { tokenUsageProjectionDefinition: projection } = await import(pathToFileURL(config.usage_projection).href)
  let state = projection.init(), baseline = { ...state.totals }, route = null, lastTime = null
  const routes = new Set(), compactions = zero()
  let compactionCalls = 0, missingCompactions = 0
  const child = spawn('zstd', ['-qdc', config.session_log], { env: environment, stdio: ['ignore', 'pipe', 'ignore'] })
  child.on('error', () => {})
  const finished = new Promise(resolve => child.once('close', resolve))
  try {
    for await (const line of createInterface({ input: child.stdout })) {
      const event = JSON.parse(line), data = event.data || {}
      if (Number.isFinite(event.time) && event.time >= until) continue
      const selected = event.type === 'request/header' ? data.header?.config
        : ['model/selection', 'request/context'].includes(event.type) ? data : null
      if (selected?.provider && selected?.model) {
        if (typeof selected.provider !== 'string' || typeof selected.model !== 'string') throw Error('Invalid native route')
        route = { provider: selected.provider, model: selected.model }
      }
      const previousTotals = { ...state.totals }
      state = projection.apply(state, event)
      if (!Number.isSafeInteger(event.time) && (event.type === 'compaction/summary' ||
          Object.keys(previousTotals).some(key => previousTotals[key] !== state.totals[key]))) throw Error('Undated native usage')
      if (Number.isFinite(event.time)) lastTime = event.time
      if (event.time < since) baseline = { ...state.totals }
      if (!(event.time >= since)) continue
      if (['assistant/message', 'assistant/attempt'].includes(event.type) && route) routes.add(JSON.stringify(route))
      if (event.type === 'compaction/summary' && data.provider === config.provider) {
        compactionCalls++
        if (!data.usage) { missingCompactions++; continue }
        compactions.uncachedInputTokens += count(data.usage.inputTokens)
        compactions.outputTokens += count(data.usage.outputTokens)
        compactions.cacheReadTokens += count(data.usage.cacheReadTokens ?? 0)
        compactions.cacheWriteTokens += count(data.usage.cacheWriteTokens ?? 0)
      }
    }
    if (await finished !== 0) throw Error('Incomplete session snapshot')
  } finally {
    if (child.exitCode === null) child.kill()
    await finished
  }
  const window = normalized(Object.fromEntries(Object.keys(baseline).map(key => [key, state.totals[key] - baseline[key]])), true)
  const compact = normalized(compactions)
  return { available: true, label: config.label, route, routes_during_window: [...routes].map(JSON.parse),
    comparable: route?.provider === config.provider && [...routes].every(value => JSON.parse(value).provider === config.provider),
    last_event_at: lastTime === null ? null : new Date(lastTime).toISOString(), cumulative: normalized(state.totals),
    window, window_basis: 'native_cumulative_delta', compactions: compact, compaction_calls: compactionCalls, compactions_without_usage: missingCompactions,
    including_compactions: sum([window, compact]) }
}

async function main() {
  const config = JSON.parse(readFileSync(process.argv[2], 'utf8')), since = Date.parse(config.since), until = Date.now()
  if (!Number.isFinite(since) || !config.proxy_journal || !config.output || !config.harness?.session_log ||
      !config.harness.usage_projection || !config.harness.provider) throw Error('Invalid monitor configuration')
  const result = await exec('python3', [fileURLToPath(new URL('./usage.py', import.meta.url)), config.proxy_journal,
    '--since', new Date(since).toISOString(), '--until', new Date(until).toISOString()],
    { env: environment, timeout: 20000, maxBuffer: 8 * 1024 * 1024 })
  const combinations = JSON.parse(result.stdout).combinations, sources = {}
  for (const source of new Set(combinations.map(row => row.source))) {
    const groups = combinations.filter(row => row.source === source)
    sources[source] = { tokens: sum(groups.map(row => row.tokens)),
      accepted: groups.reduce((n, row) => n + row.accepted, 0),
      unmeasured_accepted: groups.reduce((n, row) => n + row.unmeasured_accepted, 0),
      quota_errors: groups.reduce((n, row) => n + row.quota_errors, 0) }
  }
  let harness
  try { harness = await sessionUsage(config.harness, since, until) }
  catch { harness = { available: false, label: config.harness.label, error: 'session_snapshot_unavailable' } }
  const comparable = harness.available && harness.comparable && sources.relay
  const report = { captured_at: new Date().toISOString(), since: new Date(since).toISOString(), until: new Date(until).toISOString(),
    harness, proxy: { sources, combinations, window_basis: 'settlement_timestamp' }, comparison: comparable ? {
      relay_minus_harness: difference(sources.relay.tokens, harness.window),
      relay_minus_harness_and_compactions: difference(sources.relay.tokens, harness.including_compactions),
    } : null }
  mkdirSync(dirname(config.output), { recursive: true, mode: 0o700 })
  const temporary = config.output + '.tmp-' + randomUUID()
  try {
    writeFileSync(temporary, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    renameSync(temporary, config.output)
  } finally { rmSync(temporary, { force: true }) }
  console.log('Private token monitor snapshot updated')
}

main().catch(() => { console.error('Token monitor configuration or proxy journal unavailable'); process.exitCode = 1 })
