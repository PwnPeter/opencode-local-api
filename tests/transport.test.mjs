import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { after, test } from 'node:test'
import { createTransport } from '../src/transport.mjs'

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
const complete = createTransport({
  url: 'https://opencode.ai/inference/openai/v1/chat/completions',
  headers: { 'user-agent': 'opencode/fixture' }, body: { messages: [], tools: [] },
}, 'upstream-key', (_url, init) => fetch(`http://127.0.0.1:${server.address().port}`, init))

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

test('truncated or errored nonstream generations never become partial successes', async () => {
  for (const raw of ['data: {"choices":[{"delta":{"content":"PARTIAL"}}]}\n\n', 'data: {"error":{"message":"upstream failed"}}\n\ndata: [DONE]\n\n', 'data: [DONE]\n\n']) {
    fixture = raw
    const result = await complete({ messages: [{ role: 'user', content: 'hi' }] }, new AbortController().signal)
    assert.equal(result.status, 502)
    assert.ok((await result.json()).error)
  }
})
