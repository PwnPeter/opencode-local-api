import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { assemble, createNativeTransport, prepareRequest } from './native.mjs'

test('streams several native chunks through a single response body', async () => {
  let cfg
  const server = createServer(async (request, response) => {
    for await (const _ of request) {}
    response.setHeader('Content-Type', 'application/json')
    if (request.url === '/session' && request.method === 'POST') return response.end('{"id":"session_test"}')
    if (request.url.endsWith('/message')) {
      try {
        const extractor = cfg.provider.opencode.options.metadataExtractor.createStreamExtractor()
        extractor.processChunk({ choices: [{ delta: { content: 'FIRST' } }] })
        await new Promise(resolve => setTimeout(resolve, 10))
        extractor.processChunk({ choices: [{ delta: { content: 'SECOND' }, finish_reason: 'stop' }] })
        extractor.buildMetadata()
        return response.end('{"info":{}}')
      } catch (error) { return response.end(JSON.stringify({ info: { error: { data: { message: error.message } } } })) }
    }
    response.end('true')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const transport = createNativeTransport({ serverUrl: `http://127.0.0.1:${server.address().port}`, directory: '/tmp' })
    cfg = {}; transport.hooks.config(cfg)
    const result = await transport.complete({ stream: true, model: 'deepseek-v4.1-flash-free' }, new AbortController().signal)
    const raw = await result.text()
    assert.ok(raw.includes('FIRST'))
    assert.ok(raw.includes('SECOND'), raw)
    assert.ok(!raw.includes('"error"'), raw)
    assert.ok(raw.endsWith('data: [DONE]\n\n'))
  } finally { await new Promise(resolve => server.close(resolve)) }
})

test('empty streams settle as errors and nonstream partial failures never return success', async () => {
  for (const partial of [false, true]) {
    let cfg
    const server = createServer(async (request, response) => {
      for await (const _ of request) {}
      response.setHeader('Content-Type', 'application/json')
      if (request.url === '/session' && request.method === 'POST') return response.end('{"id":"session_test"}')
      if (request.url.endsWith('/message')) {
        const extractor = cfg.provider.opencode.options.metadataExtractor.createStreamExtractor()
        if (partial) extractor.processChunk({ choices: [{ delta: { content: 'PARTIAL' } }] })
        else extractor.buildMetadata()
        return response.end(JSON.stringify({ info: { error: { data: { statusCode: 502, message: 'upstream disconnected' } } } }))
      }
      response.end('true')
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    try {
      const transport = createNativeTransport({ serverUrl: `http://127.0.0.1:${server.address().port}`, directory: '/tmp' })
      cfg = {}; transport.hooks.config(cfg)
      const result = await Promise.race([
        transport.complete({ stream: !partial, model: 'deepseek-v4.1-flash-free' }, new AbortController().signal),
        new Promise(resolve => setTimeout(() => resolve(null), 300)),
      ])
      assert.ok(result, 'empty stream must settle')
      assert.equal(result.status, 502)
      assert.ok((await result.json()).error)
    } finally { await new Promise(resolve => server.close(resolve)) }
  }
})

test('cancellation during session creation settles and never sends a model prompt', async () => {
  const paths = []
  const controller = new AbortController()
  const server = createServer(async (request, response) => {
    for await (const _ of request) {}
    paths.push(request.url)
    response.setHeader('Content-Type', 'application/json')
    if (request.url === '/session') {
      controller.abort()
      await new Promise(resolve => setTimeout(resolve, 20))
      return response.end('{"id":"session_test"}')
    }
    response.end('{"info":{"error":{"data":{"statusCode":499,"message":"cancelled"}}}}')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const transport = createNativeTransport({ serverUrl: `http://127.0.0.1:${server.address().port}`, directory: '/tmp' })
    const result = await transport.complete({ model: 'deepseek-v4.1-flash-free' }, controller.signal)
    assert.equal(result.status, 499)
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.ok(!paths.some(x => x.endsWith('/message')), paths.join(','))
  } finally { await new Promise(resolve => server.close(resolve)) }
})

test('retains native context while preferring Harness tool definitions on name conflicts', () => {
  const native = { messages: [{ role: 'system', content: 'Native context' }, { role: 'user', content: 'trigger' }],
    tools: [{ function: { name: 'read', description: 'Native' } }, { function: { name: 'skill' } }] }
  const body = { messages: [{ role: 'tool', tool_call_id: 'call_1', content: 'result' }],
    tools: [{ function: { name: 'read', description: 'Harness' } }], max_tokens: 123 }
  const result = prepareRequest(native, body)
  assert.deepEqual(result.messages, [{ role: 'system', content: 'Native context' }, ...body.messages])
  assert.deepEqual(result.tools, [{ function: { name: 'skill' } }, { function: { name: 'read', description: 'Harness' } }])
  assert.equal(result.max_tokens, 123)
  assert.equal(result.stream, true)
  assert.equal(native.messages.length, 2)
})

test('assembles interleaved parallel tool deltas, reasoning and trailing usage', () => {
  const result = assemble([
    { id: 'response_1', model: 'deepseek-v4.1-flash-free', choices: [{ delta: { reasoning_content: 'reason', tool_calls: [
      { index: 0, id: 'a', function: { name: 'read', arguments: '{"path":' } },
      { index: 1, id: 'b', function: { name: 'read', arguments: '{"path":"b"}' } },
    ] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"a"}' } }] }, finish_reason: 'tool_calls' }] },
    { choices: [], usage: { total_tokens: 50 } },
  ])
  assert.equal(result.choices[0].finish_reason, 'tool_calls')
  assert.equal(result.choices[0].message.reasoning_content, 'reason')
  assert.deepEqual(result.choices[0].message.tool_calls.map(x => [x.id, x.function.arguments]), [['a', '{"path":"a"}'], ['b', '{"path":"b"}']])
  assert.equal(result.usage.total_tokens, 50)
})
