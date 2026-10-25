import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createAttemptLogger } from '../src/audit.mjs'

test('private attempt records retain quotas and network labels without keys, prompts or proxy credentials', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'relay-audit-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const file = join(directory, 'attempts.jsonl')
  writeFileSync(join(directory, 'network-labels.json'), JSON.stringify({
    'fixed-connection': { usb_4g: false, mobile_data: false },
    'usb-connection': { usb_4g: true, mobile_data: true },
  }))
  const log = createAttemptLogger(['first-private-key', 'second-private-key'], file)
  await log({ key: 'second-private-key', request_id: 'request-a', phase: 'inference', public_ip: '198.51.100.3',
    interface: 'test-wifi', connection_uuid: 'fixed-connection', proxy_url: 'http://user:proxy-secret@192.0.2.1:8080/private?token=hidden',
    status: 429, quota_reached: true, error_type: 'FreeUsageLimitError', retry_after: '120',
    headers: { authorization: 'Bearer first-private-key' }, messages: ['private prompt'] })
  await log({ key: 'first-private-key', phase: 'inference', public_ip: '198.51.100.4', interface: 'test-usb',
    connection_uuid: 'usb-connection', proxy_url: null, status: 429, error_type: 'RateLimitError', quota_reached: false })
  await log({ key: 'first-private-key', phase: 'exit_check', interface: 'test-new', connection_uuid: 'unknown-connection', status: null })
  const raw = readFileSync(file, 'utf8')
  const rows = raw.trim().split('\n').map(JSON.parse)
  assert.equal(rows[0].key_number, 2)
  assert.match(rows[0].key_id, /^[a-f0-9]{12}$/)
  assert.equal(rows[0].public_ip, '198.51.100.3')
  assert.equal(rows[0].proxy_used, true)
  assert.equal(rows[0].proxy_url, 'http://192.0.2.1:8080')
  assert.equal(rows[0].usb_4g, false)
  assert.equal(rows[0].mobile_data, false)
  assert.equal(rows[0].quota_reached, true)
  assert.equal(rows[0].retry_after, '120')
  assert.equal(Date.parse(rows[0].retry_at) - Date.parse(rows[0].timestamp), 120_000)
  assert.match(rows[0].time_paris, /Europe\/Paris$/)
  assert.equal(rows[1].proxy_used, false)
  assert.equal(rows[1].usb_4g, true)
  assert.equal(rows[1].mobile_data, true)
  assert.equal(rows[1].quota_reached, false)
  assert.equal(rows[2].usb_4g, null)
  assert.equal(rows[2].mobile_data, null)
  assert.equal(rows[2].public_ip, null)
  for (const secret of ['first-private-key', 'second-private-key', 'proxy-secret', 'private prompt', 'token=hidden', 'Bearer'])
    assert.ok(!raw.includes(secret), secret)
  assert.equal(statSync(file).mode & 0o777, 0o600)
})

test('audit storage refuses symbolic links without altering their target', t => {
  const directory = mkdtempSync(join(tmpdir(), 'relay-audit-link-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const target = join(directory, 'target')
  const file = join(directory, 'attempts.jsonl')
  writeFileSync(target, 'preserve')
  symlinkSync(target, file)
  assert.throws(() => createAttemptLogger(['key'], file), /ELOOP|link/i)
  assert.equal(readFileSync(target, 'utf8'), 'preserve')
})

test('usage records whitelist actual counters, preserve unknowns and keep probes separate from relay clients', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'relay-usage-audit-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const file = join(directory, 'attempts.jsonl')
  const log = createAttemptLogger(['private-key'], file)
  const base = { key: 'private-key', phase: 'usage', interface: 'test', connection_uuid: 'fixture', status: 200 }
  await log({ ...base, source: 'relay', stream_complete: true, usage: { prompt_tokens: 100, completion_tokens: 20,
    total_tokens: 120, prompt_tokens_details: { cached_tokens: 60 }, completion_tokens_details: { reasoning_tokens: 5 },
    private: 'private-key' } })
  await log({ ...base, source: 'probe', stream_complete: false, usage: { prompt_tokens: -1,
    completion_tokens: '20', total_tokens: Infinity, prompt_tokens_details: { cached_tokens: 0 } } })
  await log({ ...base, usage: null })
  const raw = readFileSync(file, 'utf8'), rows = raw.trim().split('\n').map(JSON.parse)
  assert.equal(rows[0].source, 'relay')
  assert.equal(rows[0].stream_complete, true)
  assert.deepEqual(rows[0].usage, { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, cached_tokens: 60, reasoning_tokens: 5 })
  assert.equal(rows[1].source, 'probe')
  assert.deepEqual(rows[1].usage, { prompt_tokens: null, completion_tokens: null, total_tokens: null, cached_tokens: 0, reasoning_tokens: null })
  assert.equal(rows[2].usage, null)
  assert.ok(!raw.includes('private-key'))
})
