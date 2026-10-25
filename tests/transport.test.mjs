import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { after, test } from 'node:test'
import { apiKeysFromEnv, createTransport } from '../src/transport.mjs'
import { createProxyPool, createProxyRefresher, startProxyTunnels, proxiesFromEnv } from '../src/proxy.mjs'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { createProjectStore, ProxyExitError } from '../src/projects.mjs'

const requests = []
let fixture = 'data: {"id":"r","choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
let unavailable = 0
const server = createServer(async (request, response) => {
  let raw = ''
  for await (const chunk of request) raw += chunk
  requests.push({ body: JSON.parse(raw), headers: request.headers })
  if (unavailable > 0) {
    unavailable--
    response.writeHead(503, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ error: { message: 'Endpoint is unavailable.' } }))
    return
  }
  response.setHeader('Content-Type', 'text/event-stream')
  response.write(fixture.slice(0, 19))
  setTimeout(() => response.end(fixture.slice(19)), 5)
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
after(() => new Promise(resolve => server.close(resolve)))
const envelope = {
  url: 'https://opencode.ai/inference/openai/v1/chat/completions',
  headers: { 'user-agent': 'opencode/fixture', 'x-opencode-project': 'captured-project' }, body: { messages: [], tools: [] },
}
// The local HTTP fixture has one fixed exit IP.
const fixedProject = key => createHash('sha256').update(key + ':fixture-exit').digest('hex').slice(0, 40)
const complete = createTransport(envelope, 'upstream-key', (_url, init) => fetch(`http://127.0.0.1:${server.address().port}`, init), undefined, undefined, fixedProject)

test('records the rejected quota route before rotating to a successful key and exit', async () => {
  const entries = []
  const routes = [{ url: 'http://192.0.2.1:8080', ip: '198.51.100.1' }, { url: 'http://192.0.2.2:8080', ip: '198.51.100.2' }]
  const complete = createTransport(envelope, ['first-fixture', 'second-fixture'], async (_url, init) =>
    init.headers.authorization === 'Bearer first-fixture'
      ? Response.json({ error: { type: 'FreeUsageLimitError' } }, { status: 429, headers: { 'Retry-After': '120' } })
      : new Response(fixture), routes, null, async () => 'project', entry => entries.push(entry))
  const response = await complete({ model: 'deepseek-v4.1-flash-free', messages: [{ role: 'user', content: 'private prompt' }] }, AbortSignal.timeout(3000))
  assert.equal(response.status, 200)
  await response.body.cancel()
  assert.deepEqual(entries.filter(e => e.phase === 'inference').map(e => [e.key, e.public_ip, e.status, e.quota_reached]), [
    ['first-fixture', '198.51.100.1', 429, true], ['second-fixture', '198.51.100.2', 200, false],
  ])
  assert.equal(entries[0].retry_after, '120')
  assert.equal(entries[0].error_type, 'FreeUsageLimitError')
  assert.equal(entries[0].request_id, entries[1].request_id)
  assert.equal(entries[0].proxy_url, routes[0].url)
  assert.ok(!JSON.stringify(entries).includes('private prompt'))
})

test('direct audit entries use the freshly verified exit rather than the previous request IP', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'relay-audit-direct-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const ips = ['198.51.100.31', '198.51.100.32'], entries = []
  const projects = createProjectStore(join(directory, 'projects.jsonl'), async () => Response.json({ ip: ips.shift() }))
  t.after(() => projects.close())
  const complete = createTransport(envelope, 'key-fixture', async () => new Response(fixture), null, null, projects,
    entry => entries.push(entry))
  for (let i = 0; i < 2; i++) await (await complete({ messages: [], stream: true }, AbortSignal.timeout(3000))).body.cancel()
  assert.deepEqual(entries.filter(e => e.phase === 'inference').map(e => [e.public_ip, e.proxy_url]), [['198.51.100.31', null], ['198.51.100.32', null]])
  assert.deepEqual(entries.filter(e => e.phase === 'usage').map(e => e.public_ip), ['198.51.100.31', '198.51.100.32'])
})

test('a malformed configured pool cannot disable proxy confinement', t => {
  const directory = mkdtempSync(join(tmpdir(), 'invalid-proxy-pool-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const file = join(directory, 'proxies.json')
  writeFileSync(file, 'null')
  assert.throws(() => proxiesFromEnv({ RELAY_PROXIES_FILE: file }), /must not be empty/)
})

test('forces native streaming and aggregates it for nonstream clients', async () => {
  const result = await complete({ model: 'deepseek-v4.1-flash-free', messages: [{ role: 'user', content: 'hi' }], stream: false }, new AbortController().signal)
  assert.equal(result.status, 200)
  assert.equal((await result.json()).choices[0].message.content, 'OK')
  assert.equal(requests.at(-1).body.stream, true)
  assert.equal(requests.at(-1).headers.authorization, 'Bearer upstream-key')
  assert.match(requests.at(-1).headers['x-opencode-session'], /^ses_[a-f0-9]{12}[A-Za-z0-9]{14}$/)
})

test('passes streaming bytes unchanged', async () => {
  const result = await complete({ messages: [{ role: 'user', content: 'hi' }], stream: true }, new AbortController().signal)
  assert.equal(await result.text(), fixture)
})

test('keeps conversation identities stable, separated and renewed before their timestamps become stale', async t => {
  const originalNow = Date.now()
  t.mock.method(Date, 'now', () => originalNow)
  const body = { messages: [{ role: 'user', content: 'hi' }] }
  async function session(headers) {
    const result = await complete(body, new AbortController().signal, new Headers(headers))
    assert.equal(result.status, 200)
    return requests.at(-1).headers['x-opencode-session']
  }
  const first = await session({ 'x-opencode-session': 'client-thread-a' })
  assert.equal(await session({ 'x-opencode-session': 'client-thread-a' }), first)
  assert.notEqual(await session({ 'x-dsh-session-id': 'client-thread-b' }), first)
  assert.match(first, /^ses_[a-f0-9]{12}[A-Za-z0-9]{14}$/)
  assert.notEqual(first, 'client-thread-a')
  t.mock.method(Date, 'now', () => originalNow + 31 * 60_000)
  assert.notEqual(await session({ 'x-opencode-session': 'client-thread-a' }), first)
})

test('keeps headerless Harness tool turns on the same route without changing their history', async () => {
  const opening = { role: 'user', content: 'Read the probe file' }
  const messages = [opening, { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'call_1', content: 'file contents' }]
  await complete({ messages: [opening] }, new AbortController().signal)
  const first = requests.at(-1).headers['x-opencode-session']
  await complete({ messages }, new AbortController().signal)
  assert.equal(requests.at(-1).headers['x-opencode-session'], first)
  assert.deepEqual(requests.at(-1).body.messages, messages)
  await complete({ messages: [{ role: 'user', content: 'A different task' }] }, new AbortController().signal)
  assert.notEqual(requests.at(-1).headers['x-opencode-session'], first)
})

test('bounds routing identities instead of retaining every conversation indefinitely', async () => {
  let captured
  const bounded = createTransport({ url: 'https://opencode.ai/inference/openai/v1/chat/completions',
    headers: { 'user-agent': 'opencode/fixture' }, body: { messages: [], tools: [] } }, 'upstream-key', async (_url, init) => {
    captured = init.headers['x-opencode-session']
    return new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
  })
  async function send(thread) {
    const response = await bounded({ messages: [{ role: 'user', content: 'hi' }], stream: true },
      new AbortController().signal, new Headers({ 'x-opencode-session': thread }))
    await response.body.cancel()
    return captured
  }
  const first = await send('thread-0')
  for (let i = 1; i <= 512; i++) await send(`thread-${i}`)
  assert.notEqual(await send('thread-0'), first)
})

test('recovers from temporary provider unavailability without changing conversation affinity', async () => {
  unavailable = 2
  const start = requests.length
  const response = await complete({ messages: [{ role: 'user', content: 'retry probe' }] }, new AbortController().signal)
  assert.equal(response.status, 200)
  assert.equal((await response.json()).choices[0].message.content, 'OK')
  const attempts = requests.slice(start)
  assert.equal(attempts.length, 3)
  assert.equal(new Set(attempts.map(r => r.headers['x-opencode-session'])).size, 1)
  assert.equal(new Set(attempts.map(r => r.headers['x-opencode-request'])).size, 3)
})

test('returns the provider error after bounded retries', async t => {
  unavailable = 10
  t.after(() => { unavailable = 0 })
  const start = requests.length
  const response = await complete({ messages: [{ role: 'user', content: 'unavailable probe' }] }, new AbortController().signal)
  assert.equal(response.status, 503)
  assert.equal((await response.json()).error.message, 'Endpoint is unavailable.')
  assert.equal(requests.length - start, 4)
})

test('cancellation stops provider retries', async () => {
  const controller = new AbortController()
  let calls = 0
  const aborted = createTransport({ url: 'https://opencode.ai/inference/openai/v1/chat/completions',
    headers: { 'user-agent': 'opencode/fixture' }, body: { messages: [], tools: [] } }, 'upstream-key', async () => {
    calls++
    setImmediate(() => controller.abort())
    return new Response('unavailable', { status: 503 })
  })
  await assert.rejects(aborted({ messages: [{ role: 'user', content: 'cancel probe' }] }, controller.signal), { name: 'AbortError' })
  assert.equal(calls, 1)
})

test('preserves authentication, rate limits and explicit provider retry instructions', async () => {
  for (const status of [401, 403, 429, 503]) {
    let calls = 0
    const rejected = createTransport({ url: 'https://opencode.ai/inference/openai/v1/chat/completions',
      headers: { 'user-agent': 'opencode/fixture' }, body: { messages: [], tools: [] } }, 'upstream-key', async () => {
      calls++
      return new Response('provider error', { status, headers: { 'Retry-After': '60' } })
    })
    const response = await rejected({ messages: [{ role: 'user', content: 'error probe' }] }, new AbortController().signal)
    assert.equal(response.status, status)
    assert.equal(response.headers.get('retry-after'), '60')
    assert.equal(await response.text(), 'provider error')
    assert.equal(calls, 1)
  }
})

test('uses separate key sessions after rejected credentials or exhausted free usage, preserving the conversation', async () => {
  for (const status of [401, 403, 429]) {
    const attempts = []
    const fallback = createTransport(envelope, ['primary-key', 'backup-key'], async (_url, init) => {
      attempts.push(init)
      if (init.headers.authorization !== 'Bearer backup-key')
        return Response.json({ error: { type: 'FreeUsageLimitError' } }, { status })
      return new Response('data: {"choices":[{"delta":{"content":"BACKUP_OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
    })
    const response = await fallback({ messages: [{ role: 'user', content: 'backup probe' }] }, new AbortController().signal)
    assert.equal(response.status, 200)
    assert.equal((await response.json()).choices[0].message.content, 'BACKUP_OK')
    assert.deepEqual(attempts.map(init => init.headers.authorization), ['Bearer primary-key', 'Bearer backup-key'])
    assert.notEqual(attempts[0].headers['x-opencode-session'], attempts[1].headers['x-opencode-session'])
    for (const attempt of attempts)
      assert.equal(attempt.headers['x-opencode-session'], attempt.headers['x-opencode-session-id'])
    assert.notEqual(attempts[0].headers['x-opencode-request'], attempts[1].headers['x-opencode-request'])
    assert.equal(attempts[0].body, attempts[1].body)
  }
})

test('rotates through three keys and keeps the working key and its session on later turns', async () => {
  const attempts = []
  const keys = apiKeysFromEnv({ OPENCODE_API_KEY: 'first', OPENCODE_API_KEY_BACKUP: 'second', OPENCODE_API_KEYS: ' second, third, ' })
  const rotating = createTransport(envelope, keys, async (_url, init) => {
    attempts.push(init)
    if (init.headers.authorization !== 'Bearer third')
      return Response.json({ error: { type: 'FreeUsageLimitError' } }, { status: 429 })
    return new Response('data: {"choices":[{"delta":{"content":"THIRD_OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
  }, undefined, undefined, fixedProject)
  const messages = [{ role: 'user', content: 'rotation probe' }]
  const headers = new Headers({ 'x-dsh-session-id': 'rotation-thread' })
  const response = await rotating({ messages }, new AbortController().signal, headers)
  assert.equal((await response.json()).choices[0].message.content, 'THIRD_OK')
  assert.deepEqual(attempts.map(init => init.headers.authorization), ['Bearer first', 'Bearer second', 'Bearer third'])
  assert.equal(new Set(attempts.map(init => init.headers['x-opencode-session'])).size, 3)
  assert.equal(new Set(attempts.map(init => init.headers['x-opencode-project'])).size, 3)
  for (const attempt of attempts) assert.deepEqual(JSON.parse(attempt.body).messages, messages)
  const session = attempts[2].headers['x-opencode-session']
  messages.push({ role: 'assistant', content: 'THIRD_OK' }, { role: 'user', content: 'next turn' })
  const next = await rotating({ messages }, new AbortController().signal, headers)
  assert.equal(next.status, 200)
  await next.body.cancel()
  assert.equal(attempts.length, 4)
  assert.equal(attempts[3].headers.authorization, 'Bearer third')
  assert.equal(attempts[3].headers['x-opencode-session'], session)
  assert.deepEqual(JSON.parse(attempts[3].body).messages, messages)
})

test('tries each distinct key once when the entire pool is exhausted', async () => {
  const attempts = []
  const rotating = createTransport(envelope, ['first', 'second', 'first', 'third'], async (_url, init) => {
    attempts.push(init.headers.authorization)
    return Response.json({ error: { type: 'FreeUsageLimitError', message: init.headers.authorization } },
      { status: 429, headers: { 'Retry-After': '123' } })
  })
  const response = await rotating({ messages: [{ role: 'user', content: 'all exhausted' }] }, new AbortController().signal)
  assert.deepEqual(attempts, ['Bearer first', 'Bearer second', 'Bearer third'])
  assert.equal(response.status, 429)
  assert.equal(response.headers.get('retry-after'), '123')
  assert.equal((await response.json()).error.message, 'Bearer third')
})

test('late concurrent primary results do not undo rotation or skip the working key', { timeout: 2000 }, async () => {
  const attempts = []
  const pending = []
  let entered
  const allEntered = new Promise(resolve => { entered = resolve })
  const rotating = createTransport(envelope, ['first', 'second', 'third'], async (_url, init) => {
    attempts.push(init.headers.authorization)
    if (init.headers.authorization === 'Bearer first')
      return new Promise(resolve => { pending.push(resolve); if (pending.length === 3) entered() })
    return new Response('OK')
  })
  const body = { messages: [{ role: 'user', content: 'concurrent probe' }], stream: true }
  const first = rotating(body, new AbortController().signal)
  const duplicate = rotating(body, new AbortController().signal)
  const late = rotating(body, new AbortController().signal)
  const quota = () => Response.json({ error: { type: 'FreeUsageLimitError' } }, { status: 429 })
  await allEntered
  pending[0](quota())
  assert.equal(await (await first).text(), 'OK')
  pending[1](quota())
  assert.equal(await (await duplicate).text(), 'OK')
  pending[2](new Response('LATE_OK'))
  assert.equal(await (await late).text(), 'LATE_OK')
  const next = rotating(body, new AbortController().signal)
  assert.equal(attempts.at(-1), 'Bearer second')
  assert.equal(await (await next).text(), 'OK')
  assert.deepEqual(attempts, ['Bearer first', 'Bearer first', 'Bearer first', 'Bearer second', 'Bearer second', 'Bearer second'])
})

test('leaves the backup unused for primary success, ordinary rate limits and provider retry instructions', async () => {
  for (const status of [200, 400, 429, 503]) {
    const attempts = []
    const fallback = createTransport(envelope, ['primary-key', 'backup-key'], async (_url, init) => {
      attempts.push(init.headers.authorization)
      return Response.json({ error: { type: 'RateLimitError' } }, { status, headers: { 'Retry-After': '60' } })
    })
    const response = await fallback({ messages: [{ role: 'user', content: 'primary probe' }], stream: true }, new AbortController().signal)
    assert.equal(response.status, status)
    assert.equal(response.headers.get('retry-after'), '60')
    await response.body.cancel()
    assert.deepEqual(attempts, ['Bearer primary-key'])
  }
})

test('stops after the backup fails and forwards its quota error and retry delay', async () => {
  const attempts = []
  const fallback = createTransport(envelope, ['primary-key', 'backup-key'], async (_url, init) => {
    attempts.push(init.headers.authorization)
    return Response.json({ error: { type: 'FreeUsageLimitError' } },
      { status: attempts.length === 1 ? 401 : 429, headers: { 'Retry-After': '123' } })
  })
  const response = await fallback({ messages: [{ role: 'user', content: 'both rejected' }] }, new AbortController().signal)
  assert.equal(response.status, 429)
  assert.equal(response.headers.get('retry-after'), '123')
  assert.equal((await response.json()).error.type, 'FreeUsageLimitError')
  assert.deepEqual(attempts, ['Bearer primary-key', 'Bearer backup-key'])
})

test('truncated or errored nonstream generations never become partial successes', async () => {
  for (const raw of ['data: {"choices":[{"delta":{"content":"PARTIAL"}}]}\n\n', 'data: {"error":{"message":"upstream failed"}}\n\ndata: [DONE]\n\n', 'data: [DONE]\n\n']) {
    fixture = raw
    const result = await complete({ messages: [{ role: 'user', content: 'hi' }] }, new AbortController().signal)
    assert.equal(result.status, 502)
    assert.ok((await result.json()).error)
  }
})

const proxyFixtures = [
  { url: 'http://127.0.0.1:18081', ip: '198.51.100.1' },
  { url: 'http://127.0.0.1:18082', ip: '198.51.100.2' },
  { url: 'http://127.0.0.1:18083', ip: '198.51.100.3' },
]

test('keeps projects isolated when cooldowns expire and another key needs a fresh exit', async t => {
  let now = Date.now()
  t.mock.method(Date, 'now', () => now)
  const attempts = []
  const complete = createTransport(envelope, ['first', 'second'], async (_url, init) => {
    attempts.push(init)
    const attempt = attempts.length
    if ([1, 2, 4].includes(attempt))
      return Response.json({ error: { type: 'FreeUsageLimitError' } },
        { status: 429, headers: { 'Retry-After': attempt === 1 ? '1' : '300' } })
    return new Response('OK')
  }, [...proxyFixtures, { url: 'http://127.0.0.1:18084', ip: '198.51.100.4' }])
  const body = { messages: [{ role: 'user', content: 'project ownership probe' }], stream: true }
  assert.equal(await (await complete(body, AbortSignal.timeout(2000))).text(), 'OK')
  now += 2000
  assert.equal(await (await complete(body, AbortSignal.timeout(2000))).text(), 'OK')
  await Promise.all([0, 1].map(async () => {
    assert.equal(await (await complete(body, AbortSignal.timeout(2000))).text(), 'OK')
  }))
  assert.deepEqual(attempts.map(a => a.headers.authorization),
    ['Bearer first', 'Bearer second', 'Bearer first', 'Bearer first', 'Bearer second', 'Bearer second', 'Bearer second'])
  assert.deepEqual(attempts.map(a => a.proxy), [0, 1, 2, 2, 3, 3, 3].map(i => 'http://127.0.0.1:' + (18081 + i)))
  const projects = attempts.map(a => a.headers['x-opencode-project'])
  for (const project of projects) {
    assert.match(project, /^[a-f0-9]{40}$/)
    assert.notEqual(project, envelope.headers['x-opencode-project'])
  }
  assert.equal(new Set(projects).size, 4)
  assert.equal(projects[2], projects[3])
  assert.equal(projects[4], projects[5])
  assert.equal(projects[4], projects[6])
  assert.notEqual(projects[0], projects[4])
})

test('never transfers an exit to another key after failure, cooldown or pool replenishment', t => {
  let now = Date.now()
  t.mock.method(Date, 'now', () => now)
  const pool = createProxyPool(proxyFixtures.slice(0, 2))
  const first = pool.current(0)
  const second = pool.current(1)
  pool.failed(0, first, 1)
  pool.failed(1, second, 300)
  now += 2000
  pool.add([{ url: 'http://127.0.0.1:18089', ip: first.ip }])
  assert.equal(pool.current(1), null)
  assert.equal(pool.current(0).ip, first.ip)
})

test('route selection respects persistent ownership even when key indexes change', () => {
  const allowed = (index, ip) => ip === proxyFixtures[1 - index].ip
  const pool = createProxyPool(proxyFixtures.slice(0, 2), { canUse: allowed })
  assert.equal(pool.current(0).ip, proxyFixtures[1].ip)
  assert.equal(pool.current(1).ip, proxyFixtures[0].ip)
})

test('scopes session headers to a key/IP context without fabricating organization scope or copying stale tracing', async () => {
  const attempts = []
  const configuration = []
  const native = { ...envelope, version: '2.1.4', headers: { ...envelope.headers,
    'x-session-id': 'old-session', 'x-session-affinity': 'old-affinity',
    'x-opencode-parent-session-id': 'old-parent', 'x-parent-session-id': 'old-parent',
    'x-opencode-org-id': 'old-org', 'x-org-id': 'old-provider-org',
    traceparent: 'old-trace', b3: 'old-trace', tracestate: 'old-state', baggage: 'old-baggage',
  } }
  const complete = createTransport(native, ['first', 'second'], async (_url, init) => {
    if (String(_url).endsWith('/api/v2/config')) {
      configuration.push(init)
      return Response.json({ providers: { opencode: { headers: { 'x-opencode-org-id': init.headers.authorization + '-authorized-org' } } } })
    }
    attempts.push(init)
    if (attempts.length === 1)
      return Response.json({ error: { type: 'FreeUsageLimitError' } }, { status: 429 })
    return new Response('OK')
  }, proxyFixtures)
  const body = { messages: [{ role: 'user', content: 'isolated identities' }], stream: true }
  assert.equal(await (await complete(body, AbortSignal.timeout(2000))).text(), 'OK')
  assert.equal(await (await complete(body, AbortSignal.timeout(2000))).text(), 'OK')
  for (const { headers } of attempts) {
    for (const name of ['x-opencode-session-id', 'x-session-id', 'x-session-affinity'])
      assert.equal(headers[name], headers['x-opencode-session'])
    assert.equal(headers['x-opencode-org-id'], headers.authorization + '-authorized-org')
    for (const name of ['x-opencode-parent-session-id', 'x-parent-session-id', 'x-org-id', 'tracestate', 'baggage', 'x-opencode-request'])
      assert.equal(headers[name], undefined)
    assert.match(headers.traceparent, /^00-[a-f0-9]{32}-[a-f0-9]{16}-01$/)
    assert.equal(headers.b3, headers.traceparent.split('-').slice(1, 3).join('-') + '-1')
  }
  assert.notEqual(attempts[0].headers['x-opencode-session'], attempts[1].headers['x-opencode-session'])
  assert.equal(attempts[1].headers['x-opencode-session'], attempts[2].headers['x-opencode-session'])
  assert.equal(new Set(attempts.map(a => a.headers.traceparent)).size, 3)
  assert.deepEqual(configuration.map(r => [r.headers.authorization, r.proxy]), [
    ['Bearer first', proxyFixtures[0].url], ['Bearer second', proxyFixtures[1].url],
  ])
})

test('does not send inference when the provider rejects its configuration scope', async () => {
  const urls = []
  const complete = createTransport({ ...envelope, version: '2.1.4' }, 'first', async (url, init) => {
    urls.push(String(url))
    assert.equal(init.headers.authorization, 'Bearer first')
    return Response.json({ error: { type: 'authentication_error' } }, { status: 403 })
  }, proxyFixtures, null)
  const result = await complete({ messages: [], stream: true }, AbortSignal.timeout(2000))
  assert.equal(result.status, 403)
  assert.deepEqual(urls, ['https://opencode.ai/console/api/v2/config'])
})

test('preserves the last quota error when the next proxy fails exit verification', async () => {
  let projectCalls = 0
  const complete = createTransport(envelope, 'first', async () =>
    Response.json({ error: { type: 'FreeUsageLimitError', message: 'quota fixture' } }, { status: 429 }),
  proxyFixtures.slice(0, 2), null, async () => {
    if (++projectCalls > 1) throw new ProxyExitError()
    return 'project-fixture'
  })
  const result = await complete({ messages: [], stream: true }, AbortSignal.timeout(2000))
  assert.equal(result.status, 429)
  assert.equal((await result.json()).error.message, 'quota fixture')
})

test('never returns a consumed account configuration after inference and later proxy failures', async () => {
  let checks = 0
  const complete = createTransport({ ...envelope, version: '2.1.4' }, 'first', async (_url, init) => {
    if (init.method === 'GET') return Response.json({ providers: { opencode: {} } })
    throw new Error('Inference connection failed')
  }, proxyFixtures.slice(0, 2), null, async () => {
    if (++checks > 1) throw new ProxyExitError()
    return 'project-fixture'
  })
  await assert.rejects(complete({ messages: [], stream: true }, AbortSignal.timeout(2000)), { name: 'ProxyExitError' })
})

test('changes the key, IP and both session headers together on exhausted usage, preserving the conversation', async () => {
  const attempts = []
  const complete = createTransport(envelope, ['first', 'second'], async (_url, init) => {
    attempts.push(init)
    if (attempts.length === 1)
      return Response.json({ error: { type: 'FreeUsageLimitError' } }, { status: 429 })
    return new Response('OK')
  }, proxyFixtures)
  const body = { messages: [{ role: 'user', content: 'IP quota probe' }], stream: true }
  assert.equal(await (await complete(body, AbortSignal.timeout(2000))).text(), 'OK')
  assert.deepEqual(attempts.map(r => r.headers.authorization), ['Bearer first', 'Bearer second'])
  assert.deepEqual(attempts.map(r => r.proxy), ['http://127.0.0.1:18081', 'http://127.0.0.1:18082'])
  assert.notEqual(attempts[0].headers['x-opencode-session'], attempts[1].headers['x-opencode-session'])
  assert.notEqual(attempts[0].headers['x-opencode-request'], attempts[1].headers['x-opencode-request'])
  for (const r of attempts) assert.equal(r.headers['x-opencode-session'], r.headers['x-opencode-session-id'])
  assert.equal(attempts[0].body, attempts[1].body)
  await (await complete(body, AbortSignal.timeout(2000))).text()
  assert.equal(attempts[2].proxy, attempts[1].proxy)
  assert.equal(attempts[2].headers.authorization, 'Bearer second')
  assert.equal(attempts[2].headers['x-opencode-session'], attempts[1].headers['x-opencode-session'])
})

test('uses the stored project for the actual key and route and stops on a storage failure', async () => {
  let calls = 0
  const complete = createTransport(envelope, 'key-fixture', async (_url, init) => {
    calls++
    assert.equal(init.headers['x-opencode-project'], 'stored-project')
    return new Response('OK')
  }, proxyFixtures, undefined, async (key, ip) => {
    assert.equal(key, 'key-fixture')
    assert.equal(ip, proxyFixtures[0].ip)
    if (calls) throw new Error('Project registry is not writable')
    return 'stored-project'
  })
  assert.equal(await (await complete({ messages: [], stream: true }, AbortSignal.timeout(2000))).text(), 'OK')
  await assert.rejects(complete({ messages: [], stream: true }, AbortSignal.timeout(2000)), /registry/)
  assert.equal(calls, 1)
})

test('proxy failures rotate before credentials, ordinary rate limits keep their route, and cancellation stops rotation', async () => {
  for (const mode of ['network', 'rate', 'abort']) {
    const attempts = []
    const controller = new AbortController()
    const complete = createTransport(envelope, ['first', 'second'], async (_url, init) => {
      attempts.push(init)
      if (attempts.length === 1 && mode === 'network') throw new Error('proxy offline')
      if (mode === 'abort') { controller.abort(); throw controller.signal.reason }
      return Response.json({ error: { type: 'RateLimitError' } }, { status: 429, headers: { 'Retry-After': '60' } })
    }, proxyFixtures)
    if (mode === 'abort') await assert.rejects(complete({ messages: [], stream: true }, controller.signal), { name: 'AbortError' })
    else {
      const response = await complete({ messages: [], stream: true }, controller.signal)
      assert.equal(response.status, 429)
      assert.equal(response.headers.get('retry-after'), '60')
      await response.body.cancel()
    }
    assert.equal(attempts.length, mode === 'network' ? 2 : 1)
    assert.ok(attempts.every(r => r.headers.authorization === 'Bearer first'))
    assert.equal(attempts[0].proxy, proxyFixtures[0].url)
    if (mode === 'network') assert.equal(attempts[1].proxy, proxyFixtures[1].url)
  }
})

test('exhausted proxy pools stop without falling back to a direct connection or retrying forever', async () => {
  const attempts = []
  const complete = createTransport(envelope, ['first', 'second'], async (_url, init) => {
    attempts.push(init)
    return Response.json({ error: { type: 'FreeUsageLimitError' } }, { status: 429, headers: { 'Retry-After': '120' } })
  }, proxyFixtures)
  const response = await complete({ messages: [], stream: true }, AbortSignal.timeout(2000))
  assert.equal(response.status, 429)
  assert.equal(response.headers.get('retry-after'), '120')
  await response.body.cancel()
  assert.equal(attempts.length, 3)
  assert.equal(new Set(attempts.map(r => r.proxy)).size, 3)
  assert.ok(attempts.every(r => r.proxy))
  await assert.rejects(complete({ messages: [], stream: true }, AbortSignal.timeout(2000)), /proxy/i)
})

test('rejects invalid proxy configuration and deduplicates shared exit IPs', async () => {
  for (const proxies of [[], [{ url: 'file:///tmp/proxy', ip: '198.51.100.1' }], [{ url: 'http://127.0.0.1:1', ip: 'invalid' }]])
    assert.throws(() => createTransport(envelope, 'key', async () => new Response('OK'), proxies), /prox/i)
  const attempts = []
  const complete = createTransport(envelope, 'key', async (_url, init) => {
    attempts.push(init)
    return Response.json({ error: { type: 'FreeUsageLimitError' } }, { status: 429 })
  }, [proxyFixtures[0], { ...proxyFixtures[1], ip: proxyFixtures[0].ip }])
  await (await complete({ messages: [], stream: true }, AbortSignal.timeout(2000))).body.cancel()
  assert.equal(attempts.length, 1)
})

test('keeps key routes separate and ignores late failures from the previous IP', async () => {
  const attempts = []
  const pending = []
  const complete = createTransport(envelope, ['first', 'second'], async (_url, init) => {
    attempts.push(init)
    if (init.headers.authorization === 'Bearer first') return new Response('invalid', { status: 401 })
    if (init.proxy === proxyFixtures[1].url) return new Promise(resolve => pending.push(resolve))
    return new Response('OK')
  }, proxyFixtures)
  const body = { messages: [{ role: 'user', content: 'concurrent IP probe' }], stream: true }
  const first = complete(body, AbortSignal.timeout(2000))
  await new Promise(resolve => setImmediate(resolve))
  const late = complete(body, AbortSignal.timeout(2000))
  pending[0](Response.json({ error: { type: 'FreeUsageLimitError' } }, { status: 429 }))
  assert.equal(await (await first).text(), 'OK')
  pending[1](Response.json({ error: { type: 'FreeUsageLimitError' } }, { status: 429 }))
  assert.equal(await (await late).text(), 'OK')
  assert.deepEqual(attempts.map(r => r.headers.authorization), ['Bearer first', 'Bearer second', 'Bearer second', 'Bearer second', 'Bearer first', 'Bearer second'])
  assert.deepEqual(attempts.map(r => r.proxy), [proxyFixtures[0].url, proxyFixtures[1].url, proxyFixtures[1].url, proxyFixtures[2].url, proxyFixtures[0].url, proxyFixtures[2].url])
  assert.notEqual(attempts[1].headers['x-opencode-session'], attempts[3].headers['x-opencode-session'])
  assert.equal(attempts[3].headers['x-opencode-session'], attempts[5].headers['x-opencode-session'])
})

test('starts only the recorded VPN Gate containers on relay startup', t => {
  const dir = mkdtempSync(join(tmpdir(), 'proxy-start-'))
  const previous = process.env.PATH
  t.after(() => { process.env.PATH = previous; rmSync(dir, { recursive: true, force: true }) })
  process.env.PATH = dir
  writeFileSync(join(dir, 'podman'), '#!/bin/sh\nprintf "%s\\n" "$@" > "' + join(dir, 'started') + '"\n', { mode: 0o700 })
  startProxyTunnels([{ source: 'vpngate', container: 'opencode-egress-123456abcdef' }, { source: 'public' }])
  assert.equal(readFileSync(join(dir, 'started'), 'utf8'), 'start\nopencode-egress-123456abcdef\n')
  assert.throws(() => startProxyTunnels([{ source: 'vpngate', container: 'unrelated-service' }]), /container/i)
  assert.equal(readFileSync(join(dir, 'started'), 'utf8'), 'start\nopencode-egress-123456abcdef\n')
})

test('keeps discovering fresh exits and cycling keys after successive exhausted pools', async () => {
  const attempts = []
  let batches = 0
  const complete = createTransport(envelope, ['first', 'second'], async (_url, init) => {
    attempts.push(init)
    if (init.proxy !== 'http://127.0.0.1:18084')
      return Response.json({ error: { type: 'FreeUsageLimitError' } }, { status: 429 })
    return new Response('FRESH_IP_OK')
  }, proxyFixtures.slice(0, 2), async excluded => {
    batches++
    return [...proxyFixtures.filter(p => excluded.includes(p.ip)),
      batches === 1 ? proxyFixtures[2] : { url: 'http://127.0.0.1:18084', ip: '198.51.100.4' }]
  })
  const response = await complete({ messages: [{ role: 'user', content: 'Find a usable exit' }], stream: true }, AbortSignal.timeout(2000))
  assert.equal(await response.text(), 'FRESH_IP_OK')
  assert.deepEqual(attempts.map(a => a.proxy), [...proxyFixtures.map(p => p.url), 'http://127.0.0.1:18084'])
  assert.deepEqual(attempts.map(a => a.headers.authorization), ['Bearer first', 'Bearer second', 'Bearer first', 'Bearer second'])
  assert.equal(new Set(attempts.map(a => a.headers['x-opencode-session'])).size, 4)
})

test('cycles three keys with fresh IPs and keeps the successful pair on the next request', async () => {
  const proxies = [...proxyFixtures, { url: 'http://127.0.0.1:18084', ip: '198.51.100.4' }]
  const attempts = []
  const complete = createTransport(envelope, ['first', 'second', 'third'], async (_url, init) => {
    attempts.push(init)
    if (attempts.length < 4) return Response.json({ error: { type: 'FreeUsageLimitError' } }, { status: 429 })
    return new Response('PAIR_OK')
  }, proxies)
  const body = { messages: [{ role: 'user', content: 'paired rotation' }], stream: true }
  assert.equal(await (await complete(body, AbortSignal.timeout(2000))).text(), 'PAIR_OK')
  assert.deepEqual(attempts.map(a => a.headers.authorization), ['Bearer first', 'Bearer second', 'Bearer third', 'Bearer first'])
  assert.deepEqual(attempts.map(a => a.proxy), proxies.map(p => p.url))
  assert.equal(new Set(attempts.map(a => a.headers['x-opencode-session'])).size, 4)
  const session = attempts[3].headers['x-opencode-session']
  assert.equal(await (await complete(body, AbortSignal.timeout(2000))).text(), 'PAIR_OK')
  assert.equal(attempts[4].headers.authorization, 'Bearer first')
  assert.equal(attempts[4].proxy, proxies[3].url)
  assert.equal(attempts[4].headers['x-opencode-session'], session)
})

test('does not revisit failed IPs in the same request when their short cooldown expires during discovery', async t => {
  let now = Date.now()
  t.mock.method(Date, 'now', () => now)
  const attempts = []
  const complete = createTransport(envelope, ['first', 'second'], async (_url, init) => {
    attempts.push(init.proxy)
    if (attempts.length <= 2) { now += 61_000; throw new Error('offline') }
    return new Response(init.proxy === proxyFixtures[2].url ? 'FRESH_EXIT' : 'STALE_EXIT_RETRIED')
  }, proxyFixtures.slice(0, 2), async () => [proxyFixtures[2]])
  const response = await complete({ messages: [], stream: true }, AbortSignal.timeout(2000))
  assert.equal(await response.text(), 'FRESH_EXIT')
  assert.deepEqual(attempts, proxyFixtures.map(p => p.url))
})

test('discovers new exits after network failures and stops replenishment when the client cancels', async () => {
  const routes = []
  const complete = createTransport(envelope, 'first', async (_url, init) => {
    routes.push(init.proxy)
    if (init.proxy === proxyFixtures[0].url) throw new Error('offline')
    return new Response('ONLINE')
  }, [proxyFixtures[0]], async () => [proxyFixtures[1]])
  assert.equal(await (await complete({ messages: [], stream: true }, AbortSignal.timeout(2000))).text(), 'ONLINE')
  assert.deepEqual(routes, [proxyFixtures[0].url, proxyFixtures[1].url])

  const controller = new AbortController()
  let discoveries = 0
  const cancelled = createTransport(envelope, 'first', async () => {
    return Response.json({ error: { type: 'FreeUsageLimitError' } }, { status: 429 })
  }, [proxyFixtures[0]], async () => {
    discoveries++
    setImmediate(() => controller.abort())
    throw new Error('sources unavailable')
  })
  await assert.rejects(cancelled({ messages: [], stream: true }, controller.signal), { name: 'AbortError' })
  assert.equal(discoveries, 1)
})

test('shares discovery between clients and keeps it running when only one client cancels', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'proxy-discovery-'))
  const saved = Object.fromEntries(['PATH', 'OPENCODE_API_KEY', 'PROXY_TEST_DIR'].map(name => [name, process.env[name]]))
  t.after(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    rmSync(dir, { recursive: true, force: true })
  })
  process.env.PATH = dir + ':' + saved.PATH
  process.env.PROXY_TEST_DIR = dir
  process.env.OPENCODE_API_KEY = 'must-not-reach-discovery'
  writeFileSync(join(dir, 'python3'), `#!/bin/sh
printf x >> "$PROXY_TEST_DIR/calls"
printf '%s' "\${OPENCODE_API_KEY-unset}" > "$PROXY_TEST_DIR/credential"
read -r excluded
printf '%s' "$excluded" > "$PROXY_TEST_DIR/excluded"
sleep 0.05
printf '%s' '[{"url":"http://127.0.0.1:18084","ip":"198.51.100.4"}]' > "$PROXY_TEST_DIR/pool.json"
`, { mode: 0o700 })
  const refresh = createProxyRefresher({ RELAY_PROXIES_FILE: join(dir, 'pool.json') })
  const cancelled = new AbortController()
  const first = assert.rejects(refresh(['198.51.100.1'], cancelled.signal), { name: 'AbortError' })
  const second = refresh(['198.51.100.1'], AbortSignal.timeout(2000))
  cancelled.abort()
  assert.deepEqual(await second, [{ url: 'http://127.0.0.1:18084', ip: '198.51.100.4' }])
  await first
  assert.equal(readFileSync(join(dir, 'calls'), 'utf8'), 'x')
  assert.equal(readFileSync(join(dir, 'credential'), 'utf8'), 'unset')
  assert.equal(readFileSync(join(dir, 'excluded'), 'utf8'), '["198.51.100.1"]')
})

test('rejects an invalid discovery batch without losing an existing route or partially accepting entries', () => {
  const pool = createProxyPool([proxyFixtures[0]])
  const route = pool.current(0)
  assert.throws(() => pool.add([proxyFixtures[1], { url: 'file:///tmp/private', ip: '198.51.100.3' }]), /proxy/i)
  assert.equal(pool.current(0), route)
  assert.deepEqual(pool.excluded(), ['198.51.100.1'])
})
