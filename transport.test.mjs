import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { after, test } from 'node:test'
import { createTransport } from './transport.mjs'

const requests = []
let fixture = 'data: {"id":"r","choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
const server = createServer(async (request, response) => {
  let raw = ''
  for await (const chunk of request) raw += chunk
  requests.push({ body: JSON.parse(raw), headers: request.headers })
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

test('truncated or errored nonstream generations never become partial successes', async () => {
  for (const raw of ['data: {"choices":[{"delta":{"content":"PARTIAL"}}]}\n\n', 'data: {"error":{"message":"upstream failed"}}\n\ndata: [DONE]\n\n', 'data: [DONE]\n\n']) {
    fixture = raw
    const result = await complete({ messages: [{ role: 'user', content: 'hi' }] }, new AbortController().signal)
    assert.equal(result.status, 502)
    assert.ok((await result.json()).error)
  }
})
