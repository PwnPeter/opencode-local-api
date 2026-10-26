import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createAttemptLogger } from '../src/audit.mjs'
import { createPreferredTransport } from '../src/preferred.mjs'
import { createProjectStore } from '../src/projects.mjs'
import { createHandler } from '../src/relay.mjs'

const envelope = { url: 'https://opencode.ai/inference/openai/v1/chat/completions',
  headers: { 'user-agent': 'opencode/fixture' }, body: {} }
const sse = (content, usage) => 'data: ' + JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }] }) +
  '\n\ndata: ' + JSON.stringify({ choices: [], usage }) + '\n\ndata: [DONE]\n\n'

async function setup(t, mode = 'quota', controller) {
  const directory = mkdtempSync(join(tmpdir(), 'relay-fast-failover-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const keys = ['first-fixture', 'second-fixture']
  const routes = keys.map((key, i) => ({ name: 'route-' + i,
    key_fingerprint: createHash('sha256').update(key).digest('hex'),
    proxy: { url: `socks5h://192.0.2.${i + 1}:1080`, ip: `198.51.100.${i + 1}` } }))
  const pin = join(directory, 'pin.json'), plan = join(directory, 'plan.json'), journal = join(directory, 'attempts.jsonl')
  writeFileSync(pin, JSON.stringify(routes[0]))
  writeFileSync(plan, JSON.stringify({ routes }))
  const projects = createProjectStore(join(directory, 'projects.jsonl'), async (_url, init) =>
    Response.json({ ip: routes.find(route => route.proxy.url === init.proxy).proxy.ip }))
  t.after(() => projects.close())
  const calls = []
  const complete = await createPreferredTransport(envelope, keys, async () => { throw Error('Unconfigured fallback forbidden') },
    projects, { RELAY_PINNED_ROUTE_FILE: pin, RELAY_ROUTE_PLAN_FILE: plan }, async (_url, init) => {
      const body = JSON.parse(init.body)
      calls.push({ key: init.headers.authorization, proxy: init.proxy, body })
      if (init.headers.authorization === 'Bearer first-fixture') {
        if (mode === 'cancel-accepted') {
          controller.abort(new DOMException('Client cancelled', 'AbortError'))
          return new Response(sse('not delivered', { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 }))
        }
        if (mode === 'network') throw Error('Fixture network outage')
        if (mode === 'cancel') controller.abort(new DOMException('Client cancelled', 'AbortError'))
        return Response.json({ error: { type: mode === 'rate' ? 'RateLimitError' : 'FreeUsageLimitError' } },
          { status: 429, headers: { 'Retry-After': '86400' } })
      }
      const probe = body.messages.some(message => message.content.includes('FAILOVER_ROUTE_OK'))
      if (probe && mode === 'incomplete') return new Response('data: {"choices":[{"delta":{"content":"FAILOVER_ROUTE_OK"}}]}\n\n')
      if (!probe && mode === 'external-selection') writeFileSync(pin, JSON.stringify({ ...routes[0], name: 'operator-current' }))
      return new Response(sse(probe ? 'FAILOVER_ROUTE_OK' : 'ORIGINAL_REQUEST_OK',
        probe ? { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } : { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }))
    }, createAttemptLogger(keys, journal))
  t.after(() => complete.close?.())
  return { complete, pin, plan, journal, calls, routes, projects }
}

for (const mode of ['quota', 'network']) test(`a ${mode} failure switches inside the same client request and keeps token totals on the actual route`, async t => {
  const f = await setup(t, mode)
  const body = { model: 'deepseek-v4.1-flash-free', stream: true,
    messages: [{ role: 'user', content: 'original private conversation' }],
    tools: [{ type: 'function', function: { name: 'fixture_tool', parameters: { type: 'object' } } }] }
  const handle = createHandler({ token: 'local-fixture', complete: f.complete })
  const response = await handle(new Request('http://127.0.0.1:4097/v1/chat/completions', {
    method: 'POST', headers: { Authorization: 'Bearer local-fixture', 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }))
  assert.equal(response.status, 200)
  assert.ok((await response.text()).includes('ORIGINAL_REQUEST_OK'))
  assert.equal(f.calls.length, 3)
  assert.deepEqual(f.calls.at(-1).body.messages, body.messages)
  assert.deepEqual(f.calls.at(-1).body.tools, body.tools)
  assert.equal(JSON.parse(readFileSync(f.pin, 'utf8')).key_fingerprint, f.routes[1].key_fingerprint)
  const entries = readFileSync(f.journal, 'utf8').trim().split('\n').map(JSON.parse)
  const client = entries.filter(e => e.phase === 'inference' && e.source === 'relay')
  assert.equal(client.length, 2)
  assert.equal(client[0].request_id, client[1].request_id)
  assert.deepEqual(client.map(e => e.key_number), [1, 2])
  assert.deepEqual(client.map(e => e.public_ip), ['198.51.100.1', '198.51.100.2'])
  const usage = entries.filter(e => e.phase === 'usage')
  assert.deepEqual(usage.map(e => [e.source, e.key_number, e.public_ip, e.usage.total_tokens]),
    [['probe', 2, '198.51.100.2', 6], ['relay', 2, '198.51.100.2', 120]])
  assert.ok(!readFileSync(f.journal, 'utf8').includes('original private conversation'))
})

test('ordinary rate limits keep the route and provider retry instructions', async t => {
  const f = await setup(t, 'rate')
  const response = await f.complete({ messages: [], stream: true }, undefined, undefined, { source: 'relay' })
  assert.equal(response.status, 429)
  assert.equal(response.headers.get('retry-after'), '86400')
  assert.equal(f.calls.length, 1)
})

test('an incomplete candidate probe cannot be selected or receive the original conversation', async t => {
  const f = await setup(t, 'incomplete')
  const response = await f.complete({ messages: [{ role: 'user', content: 'original private conversation' }], stream: true })
  assert.equal(response.status, 429)
  assert.equal((await response.json()).error.type, 'FreeUsageLimitError')
  assert.equal(f.calls.length, 2)
  assert.equal(JSON.parse(readFileSync(f.pin, 'utf8')).key_fingerprint, f.routes[0].key_fingerprint)
})

test('client cancellation prevents further probes or route publication', async t => {
  const controller = new AbortController(), f = await setup(t, 'cancel', controller)
  await assert.rejects(f.complete({ messages: [], stream: true }, controller.signal), { name: 'AbortError' })
  assert.equal(f.calls.length, 1)
  assert.equal(JSON.parse(readFileSync(f.pin, 'utf8')).key_fingerprint, f.routes[0].key_fingerprint)
})

test('cancellation after acceptance closes the unused stream and preserves its usage observation', async t => {
  const controller = new AbortController(), f = await setup(t, 'cancel-accepted', controller)
  await assert.rejects(f.complete({ messages: [], stream: true }, controller.signal, undefined, { source: 'relay' }), { name: 'AbortError' })
  const entries = readFileSync(f.journal, 'utf8').trim().split('\n').map(JSON.parse)
  assert.ok(entries.some(entry => entry.phase === 'usage' && entry.key_number === 1 && entry.stream_complete === false))
  assert.equal(f.calls.length, 1)
})

test('failover cannot transfer an exit already owned by another key', async t => {
  const f = await setup(t)
  assert.equal(f.projects.reserve('first-fixture', f.routes[1].proxy.ip), true)
  const response = await f.complete({ messages: [], stream: true })
  assert.equal(response.status, 429)
  assert.equal(f.calls.length, 1)
  assert.equal(f.projects.canUse('second-fixture', f.routes[1].proxy.ip), false)
})

test('a concurrent selection change is retained while the verified request still succeeds', async t => {
  const f = await setup(t, 'external-selection')
  const response = await f.complete({ messages: [{ role: 'user', content: 'original private conversation' }], stream: true })
  assert.equal(response.status, 200)
  assert.ok((await response.text()).includes('ORIGINAL_REQUEST_OK'))
  assert.equal(JSON.parse(readFileSync(f.pin, 'utf8')).name, 'operator-current')
})
