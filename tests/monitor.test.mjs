import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const zstdAvailable = spawnSync('zstd', ['--version']).status === 0
const script = fileURLToPath(new URL('../scripts/monitor.mjs', import.meta.url))

test('monitor compares native Harness and all proxy counters over the same window without mixing probes', { skip: !zstdAvailable }, t => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-monitor-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const projection = join(dir, 'projection.mjs')
  // The installed Harness projection is an external dependency; use fixed native results here.
  writeFileSync(projection, `export const tokenUsageProjectionDefinition = {
    init: () => ({ totals: { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } }),
    apply: (state, event) => event.seq === 1 ? { totals: { uncachedInputTokens: 10, outputTokens: 2, cacheReadTokens: 20, cacheWriteTokens: 0 } }
      : event.seq === 2 ? { totals: { uncachedInputTokens: 30, outputTokens: 22, cacheReadTokens: 100, cacheWriteTokens: 0 } }
      : event.seq === 4 ? { totals: { uncachedInputTokens: 9999, outputTokens: 9999, cacheReadTokens: 9999, cacheWriteTokens: 0 } } : state,
  }`)
  const events = [
    { type: 'model/selection', seq: 0, time: Date.parse('2026-10-26T00:00:00Z'), data: { provider: 'opencode', model: 'fixture' } },
    { type: 'assistant/message', seq: 1, time: Date.parse('2026-10-26T00:00:10Z'), data: { usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 20 } } },
    { type: 'assistant/message', seq: 2, time: Date.parse('2026-10-26T00:02:00Z'), data: { message: 'private fixture content', usage: { inputTokens: 20, outputTokens: 20, cacheReadTokens: 80 } } },
    { type: 'compaction/summary', seq: 3, time: Date.parse('2026-10-26T00:02:01Z'), data: { provider: 'opencode', model: 'fixture', summary: 'private fixture summary', usage: { inputTokens: 4, outputTokens: 2, cacheReadTokens: 6 } } },
    { type: 'assistant/message', seq: 4, time: Date.parse('2999-01-01T00:00:00Z'), data: { usage: { inputTokens: 9999, outputTokens: 9999, cacheReadTokens: 9999 } } },
  ]
  const compressed = spawnSync('zstd', ['-q', '-c'], { input: events.map(e => JSON.stringify(e)).join('\n') + '\n' })
  assert.equal(compressed.status, 0)
  const session = join(dir, 'session.zstd')
  writeFileSync(session, compressed.stdout)
  const journal = join(dir, 'attempts.jsonl')
  const base = { timestamp: '2026-10-26T00:02:00Z', source: 'relay', key_id: '111111111111', key_number: 1,
    public_ip: '198.51.100.1', interface: 'wifi', request_id: 'r', phase: 'usage', stream_complete: true }
  writeFileSync(journal, [
    { ...base, timestamp: '2026-10-26T00:00:10Z', usage: { total_tokens: 999 } },
    { ...base, usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, cached_tokens: 80 } },
    { ...base, source: 'probe', request_id: 'probe', usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7, cached_tokens: 0 } },
    { ...base, timestamp: '2999-01-01T00:00:00Z', request_id: 'future', usage: { total_tokens: 9999 } },
  ].map(row => JSON.stringify(row)).join('\n') + '\n')
  const output = join(dir, 'monitor-status.json'), config = join(dir, 'monitor.json')
  writeFileSync(config, JSON.stringify({ since: '2026-10-26T00:01:00Z', proxy_journal: journal, output,
    harness: { label: 'Yazio', session_log: session, usage_projection: projection, provider: 'opencode' } }))
  const run = () => spawnSync(process.execPath, [script, config], { encoding: 'utf8' })
  const result = run()
  assert.equal(result.status, 0, result.stderr)
  const raw = readFileSync(output, 'utf8'), report = JSON.parse(raw)
  assert.equal(report.proxy.sources.relay.tokens.total_tokens, 120)
  assert.equal(report.proxy.sources.probe.tokens.total_tokens, 7)
  assert.equal(report.harness.label, 'Yazio')
  assert.equal(report.harness.available, true)
  assert.equal(report.harness.window.prompt_tokens, 100)
  assert.equal(report.harness.window.completion_tokens, 20)
  assert.equal(report.harness.window.total_tokens, 120)
  assert.equal(report.harness.compactions.total_tokens, 12)
  assert.equal(report.harness.including_compactions.total_tokens, 132)
  assert.equal(report.comparison.relay_minus_harness.total_tokens, 0)
  assert.equal(report.comparison.relay_minus_harness_and_compactions.total_tokens, -12)
  assert.ok(!raw.includes('private fixture'))
  assert.equal(statSync(output).mode & 0o777, 0o600)
  writeFileSync(projection, `export const tokenUsageProjectionDefinition = {
    init: () => ({ totals: { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } }),
    apply: (state, event) => event.seq === 1 ? { totals: { uncachedInputTokens: 100, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } }
      : event.seq === 2 ? { totals: { uncachedInputTokens: 80, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } } : state,
  }`)
  let sample = spawnSync('zstd', ['-q', '-c'], { input: events.slice(0, 3).map(e => JSON.stringify(e)).join('\n') + '\n' })
  writeFileSync(session, sample.stdout)
  assert.equal(run().status, 0)
  const adjusted = JSON.parse(readFileSync(output, 'utf8'))
  assert.equal(adjusted.harness.available, true)
  assert.equal(adjusted.harness.window_basis, 'native_cumulative_delta')
  assert.equal(adjusted.harness.window.total_tokens, -20)
  assert.equal(adjusted.comparison.relay_minus_harness.total_tokens, 140)
  const undated = events.slice(0, 3).map(event => ({ ...event }))
  delete undated[2].time
  sample = spawnSync('zstd', ['-q', '-c'], { input: undated.map(e => JSON.stringify(e)).join('\n') + '\n' })
  writeFileSync(session, sample.stdout)
  assert.equal(run().status, 0)
  const missingTime = JSON.parse(readFileSync(output, 'utf8'))
  assert.equal(missingTime.harness.available, false)
  assert.equal(missingTime.comparison, null)
  assert.equal(missingTime.proxy.sources.relay.tokens.total_tokens, 120)
  const structuredRoute = events.slice(0, 3).map(event => ({ ...event }))
  structuredRoute[0].data = { provider: { private: 'private fixture provider object' }, model: 'fixture' }
  sample = spawnSync('zstd', ['-q', '-c'], { input: structuredRoute.map(e => JSON.stringify(e)).join('\n') + '\n' })
  writeFileSync(session, sample.stdout)
  assert.equal(run().status, 0)
  const badRouteRaw = readFileSync(output, 'utf8'), badRoute = JSON.parse(badRouteRaw)
  assert.equal(badRoute.harness.available, false)
  assert.ok(!badRouteRaw.includes('private fixture'))
  writeFileSync(session, Buffer.from('not a valid compressed stream'))
  assert.equal(run().status, 0)
  const unavailable = JSON.parse(readFileSync(output, 'utf8'))
  assert.equal(unavailable.harness.available, false)
  assert.equal(unavailable.comparison, null)
  assert.equal(unavailable.proxy.sources.relay.tokens.total_tokens, 120)
})
