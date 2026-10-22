import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assemble, identifier, prepareRequest } from '../src/protocol.mjs'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import https from 'node:https'
import { createServer, request as httpRequest } from 'node:http'
import Extract from '../scripts/extract.mjs'

test('identifiers retain native time encoding and format', () => {
  const msg = identifier('msg', false, 1_700_000_000_000)
  const session = identifier('ses', true, 1_700_000_000_000)
  assert.match(msg, /^msg_[a-f0-9]{12}[A-Za-z0-9]{14}$/)
  assert.match(session, /^ses_[a-f0-9]{12}[A-Za-z0-9]{14}$/)
  assert.equal(BigInt('0x' + msg.slice(4, 16)) >> 12n, 1_700_000_000_000n & ((1n << 36n) - 1n))
  assert.notEqual(msg, identifier('msg', false, 1_700_000_000_000))
})

test('preserves the caller prompt and tools while trimming unnecessary native context', () => {
  const native = { messages: [{ role: 'system', content: 'native instructions must not override the client' }], tools: [{ function: { name: 'bash' } }, { function: { name: 'read', description: 'native' } }, { function: { name: 'skill' } }] }
  const body = { model: 'deepseek-v4.1-flash-free', messages: [{ role: 'system', content: 'Harness instructions' }, { role: 'tool', tool_call_id: 'a', content: 'result' }], tools: [{ function: { name: 'read', description: 'Harness' } }], stream: false, max_tokens: 20 }
  const result = prepareRequest(native, body)
  assert.equal(result.stream, true)
  assert.equal(result.max_tokens, 20)
  assert.deepEqual(result.messages, body.messages)
  assert.deepEqual(result.tools, [{ function: { name: 'bash' } }, ...body.tools])
  assert.equal(native.tools[1].function.description, 'native')
})

test('parallel tool argument fragments and trailing usage survive aggregation', () => {
  const result = assemble([
    { id: 'r', model: 'free', choices: [{ delta: { reasoning_content: 'reason', tool_calls: [{ index: 0, id: 'a', function: { name: 'read', arguments: '{"path":' } }, { index: 1, id: 'b', function: { name: 'read', arguments: '{"path":"b"}' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"a"}' } }] }, finish_reason: 'tool_calls' }] },
    { choices: [], usage: { total_tokens: 20 } },
  ])
  assert.equal(result.choices[0].finish_reason, 'tool_calls')
  assert.deepEqual(result.choices[0].message.tool_calls.map(call => [call.id, call.function.arguments]), [['a', '{"path":"a"}'], ['b', '{"path":"b"}']])
  assert.equal(result.choices[0].message.reasoning_content, 'reason')
  assert.equal(result.usage.total_tokens, 20)
})

test('extraction saves only the required protocol and leaves the real native request intact', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'relay-extract-test-'))
  const previous = process.env.RELAY_ENVELOPE_OUTPUT
  process.env.RELAY_ENVELOPE_OUTPUT = join(directory, 'envelope.json')
  t.after(() => {
    if (previous === undefined) delete process.env.RELAY_ENVELOPE_OUTPUT
    else process.env.RELAY_ENVELOPE_OUTPUT = previous
    rmSync(directory, { recursive: true, force: true })
  })
  const init = { method: 'POST', headers: { Authorization: 'Bearer upstream-fixture' }, body: JSON.stringify({ model: 'deepseek-v4.1-flash-free',
    messages: [{ role: 'system', content: 'private local context' }, { role: 'user', content: 'native probe' }],
    tools: ['bash', 'read', 'task'].map(name => ({ type: 'function', function: { name } })),
  }) }
  let sent, authorization
  const server = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    sent = Buffer.concat(chunks).toString()
    authorization = request.headers.authorization
    response.end('OK')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  t.mock.method(https, 'request', (url, options, callback) => {
    assert.equal(options.family, 4)
    const local = new URL(url)
    local.protocol = 'http:'
    return httpRequest(local, options, callback)
  })
  const plugin = await Extract()
  const config = {}
  plugin.config(config)
  const response = await config.provider.opencode.options.fetch(`https://127.0.0.1:${server.address().port}/inference/openai/v1/chat/completions`, init)
  assert.equal(await response.text(), 'OK')
  const raw = readFileSync(process.env.RELAY_ENVELOPE_OUTPUT, 'utf8')
  const saved = JSON.parse(raw)
  assert.deepEqual(saved.body.messages, [])
  assert.deepEqual(saved.body.tools.map(tool => tool.function.name), ['bash', 'read'])
  assert.equal(saved.headers.authorization, undefined)
  assert.ok(!raw.includes('upstream-fixture') && !raw.includes('private local context'))
  assert.equal(sent, init.body)
  assert.equal(authorization, init.headers.Authorization)
})
