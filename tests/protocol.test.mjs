import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assemble, identifier, prepareRequest } from '../src/protocol.mjs'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Extract from '../scripts/extract.mjs'

test('identifiers retain native time encoding and format', () => {
  const msg = identifier('msg', false, 1_700_000_000_000)
  const session = identifier('ses', true, 1_700_000_000_000)
  assert.match(msg, /^msg_[a-f0-9]{12}[A-Za-z0-9]{14}$/)
  assert.match(session, /^ses_[a-f0-9]{12}[A-Za-z0-9]{14}$/)
  assert.equal(BigInt('0x' + msg.slice(4, 16)) >> 12n, 1_700_000_000_000n & ((1n << 36n) - 1n))
  assert.notEqual(msg, identifier('msg', false, 1_700_000_000_000))
})

test('preserves native context and all tool definitions while keeping caller history and tool overrides', () => {
  const native = { messages: [{ role: 'system', content: 'OpenCode instructions; directory {{RELAY_WORKSPACE}}' }], tools: [{ function: { name: 'shell' } }, { function: { name: 'read', description: 'native' } }, { function: { name: 'skill' } }] }
  const body = { model: 'deepseek-v4.1-flash-free', messages: [{ role: 'system', content: 'Harness instructions' }, { role: 'tool', tool_call_id: 'a', content: 'result' }], tools: [{ function: { name: 'read', description: 'Harness' } }], stream: false, max_tokens: 20 }
  const result = prepareRequest(native, body, 'project-one')
  assert.equal(result.stream, true)
  assert.equal(result.max_tokens, 20)
  assert.equal(result.messages[0].content, 'OpenCode instructions; directory /workspace/project-one')
  assert.deepEqual(result.messages.slice(1), body.messages)
  assert.deepEqual(result.tools, [{ function: { name: 'shell' } }, { function: { name: 'skill' } }, ...body.tools])
  assert.notEqual(prepareRequest(native, body, 'project-two').messages[0].content, result.messages[0].content)
  assert.equal(native.tools[1].function.description, 'native')
})

test('uses the current native token parameter and shell tool without changing caller history', () => {
  const native = { max_completion_tokens: 32000, tools: ['shell', 'read', 'subagent'].map(name => ({ function: { name } })) }
  const body = { messages: [{ role: 'user', content: 'original' }], max_tokens: 200, tools: [{ function: { name: 'read', description: 'client' } }] }
  const result = prepareRequest(native, body)
  assert.equal(result.max_completion_tokens, 200)
  assert.equal(result.max_tokens, undefined)
  assert.equal(result.messages, body.messages)
  assert.deepEqual(result.tools.map(tool => tool.function.name), ['shell', 'subagent', 'read'])
  assert.equal(result.tools[2].function.description, 'client')
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

test('extraction captures the current HTTP hook without sending credentials or retaining private context', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'relay-extract-test-'))
  const previous = process.env.RELAY_ENVELOPE_OUTPUT
  const previousDirectory = process.env.RELAY_CAPTURE_DIRECTORY
  process.env.RELAY_ENVELOPE_OUTPUT = join(directory, 'envelope.json')
  process.env.RELAY_CAPTURE_DIRECTORY = '/private/extract-project'
  t.after(() => {
    if (previous === undefined) delete process.env.RELAY_ENVELOPE_OUTPUT
    else process.env.RELAY_ENVELOPE_OUTPUT = previous
    if (previousDirectory === undefined) delete process.env.RELAY_CAPTURE_DIRECTORY
    else process.env.RELAY_CAPTURE_DIRECTORY = previousDirectory
    rmSync(directory, { recursive: true, force: true })
  })
  const request = new Request('https://opencode.ai/inference/openai/v1/chat/completions', { method: 'POST', headers: {
    Authorization: 'Bearer upstream-fixture', 'User-Agent': 'opencode/latest/2.1.4/cli',
    'x-opencode-project': 'private-project', 'x-opencode-org-id': 'private-organization',
  }, body: JSON.stringify({ model: 'deepseek-v4.1-flash-free',
    messages: [{ role: 'system', content: 'OpenCode instructions; directory /private/extract-project' }, { role: 'user', content: 'native probe' }],
    tools: ['shell', 'read', 'subagent'].map(name => ({ type: 'function', function: { name } })),
  }) }
  )
  let capture
  await Extract.setup({ app: { version: '2.1.4' }, session: { async hook(name, handler, filter) {
    assert.equal(name, 'http.request')
    assert.equal(filter.providerID, 'opencode')
    capture = handler
  } } })
  await assert.rejects(capture({ request }), /RELAY_CAPTURE_COMPLETE_NO_NETWORK/)
  const raw = readFileSync(process.env.RELAY_ENVELOPE_OUTPUT, 'utf8')
  const saved = JSON.parse(raw)
  assert.deepEqual(saved.body.messages, [{ role: 'system', content: 'OpenCode instructions; directory {{RELAY_WORKSPACE}}' }])
  assert.deepEqual(saved.body.tools.map(tool => tool.function.name), ['shell', 'read', 'subagent'])
  assert.equal(saved.version, '2.1.4')
  assert.equal(saved.headers.authorization, undefined)
  assert.ok(!raw.includes('upstream-fixture') && !raw.includes('/private/extract-project') && !raw.includes('private-organization') && !raw.includes('private-project') && !raw.includes('native probe'))
  assert.equal((await request.json()).messages[0].content, 'OpenCode instructions; directory /private/extract-project')
})
