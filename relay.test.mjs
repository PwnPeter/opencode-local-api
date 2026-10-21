import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { after, test } from 'node:test'
import { createHandler } from './relay.mjs'

const requests = []
const upstream = createServer(async (request, response) => {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  requests.push({ headers: request.headers, body: Buffer.concat(chunks).toString() })
  if (request.url === '/error/chat/completions') {
    response.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '3' })
    response.end('{"error":{"message":"rate limited"}}')
    return
  }
  if (request.headers.accept === 'text/event-stream') {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    response.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"read"}}]}}]}\n\n')
    setTimeout(() => response.end('data: [DONE]\n\n'), 15)
    return
  }
  response.writeHead(200, { 'Content-Type': 'application/json' })
  response.end('{"choices":[{"message":{"content":"OK"}}]}')
})
await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
after(() => new Promise(resolve => upstream.close(resolve)))

function handler(path = '') {
  return createHandler({
    token: 'local-test-token',
    complete: (body, signal) => fetch(`http://127.0.0.1:${upstream.address().port}${path}/chat/completions`, {
      method: 'POST', signal, body: JSON.stringify(body),
      headers: { Accept: body.stream ? 'text/event-stream' : 'application/json' },
    }),
  })
}

function request(body, headers = {}) {
  return new Request('http://127.0.0.1:4097/v1/chat/completions', {
    method: 'POST', headers: { Authorization: 'Bearer local-test-token', 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

test('rejects missing local credentials before contacting upstream', async () => {
  const before = requests.length
  const response = await handler()(new Request('http://127.0.0.1:4097/v1/models'))
  assert.equal(response.status, 401)
  assert.equal(requests.length, before)
})

test('lists only the supported free model', async () => {
  const response = await handler()(new Request('http://127.0.0.1:4097/v1/models', { headers: { Authorization: 'Bearer local-test-token' } }))
  assert.deepEqual((await response.json()).data.map(x => x.id), ['deepseek-v4.1-flash-free'])
})

test('rejects paid models and malformed input without an upstream request', async () => {
  const before = requests.length
  for (const body of [
    { model: 'deepseek-v4.1-flash', messages: [{ role: 'user', content: 'hi' }] },
    { model: 'deepseek-v4.1-flash-free', messages: [] }, '{', 'null',
  ]) assert.equal((await handler()(request(body))).status, 400)
  assert.equal(requests.length, before)
})

test('bounds streamed request bodies even without content-length', async () => {
  const before = requests.length
  const oversized = new Request('http://127.0.0.1:4097/v1/chat/completions', {
    method: 'POST', headers: { Authorization: 'Bearer local-test-token' }, duplex: 'half',
    body: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(32 * 1024 * 1024 + 1)); controller.close() } }),
  })
  assert.equal((await handler()(oversized)).status, 413)
  assert.equal(requests.length, before)
})

test('rejects malformed tool definitions and stream flags before contacting upstream', async () => {
  const before = requests.length
  const base = { model: 'deepseek-v4.1-flash-free', messages: [{ role: 'user', content: 'hi' }] }
  for (const extra of [{ tools: {} }, { tools: [null] }, { tools: [{ type: 'function', function: {} }] },
    { tools: [{ type: 'function', function: { name: '' } }] }, { stream: 'false' }, { messages: [null] }])
    assert.equal((await handler()(request({ ...base, ...extra }))).status, 400)
  assert.equal(requests.length, before)
})

test('passes conversation identity to the transport without forwarding credentials as body fields', async () => {
  let received
  const handle = createHandler({ token: 'local-test-token', complete: async (body, _signal, headers) => {
    received = { body, session: headers.get('x-opencode-session') }
    return Response.json({ ok: true })
  } })
  const body = { model: 'deepseek-v4.1-flash-free', messages: [{ role: 'user', content: 'hi' }] }
  assert.equal((await handle(request(body, { 'x-opencode-session': 'conversation-1' }))).status, 200)
  assert.deepEqual(received, { body, session: 'conversation-1' })
})

test('preserves messages, tool results, reasoning and parameters while separating credentials', async () => {
  const body = {
    model: 'deepseek-v4.1-flash-free', stream: false,
    messages: [{ role: 'assistant', content: null, reasoning_content: 'thinking', tool_calls: [{ id: 'call_a', type: 'function', function: { name: 'read', arguments: '{"path":"file"}' } }] },
      { role: 'tool', tool_call_id: 'call_a', content: 'data' }],
    tools: [{ type: 'function', function: { name: 'read', parameters: { type: 'object' } } }],
    max_tokens: 80, temperature: 0.2,
  }
  const response = await handler()(request(body))
  assert.equal(response.status, 200)
  assert.equal((await response.json()).choices[0].message.content, 'OK')
  assert.deepEqual(JSON.parse(requests.at(-1).body), body)
  assert.equal(requests.at(-1).headers.authorization, undefined)
})

test('passes streaming tool deltas and DONE through unchanged', async () => {
  const response = await handler()(request({ model: 'deepseek-v4.1-flash-free', messages: [{ role: 'user', content: 'hi' }], stream: true }))
  assert.equal(response.headers.get('content-type'), 'text/event-stream')
  assert.equal(await response.text(), 'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"read"}}]}}]}\n\ndata: [DONE]\n\n')
})

test('preserves upstream errors and retry headers', async () => {
  const response = await handler('/error')(request({ model: 'deepseek-v4.1-flash-free', messages: [{ role: 'user', content: 'hi' }] }))
  assert.equal(response.status, 429)
  assert.equal(response.headers.get('retry-after'), '3')
  assert.deepEqual(await response.json(), { error: { message: 'rate limited' } })
})
