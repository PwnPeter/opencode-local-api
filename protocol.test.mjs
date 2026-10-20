import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assemble, identifier, prepareRequest } from './protocol.mjs'

test('identifiers retain native time encoding and format', () => {
  const msg = identifier('msg', false, 1_700_000_000_000)
  const session = identifier('ses', true, 1_700_000_000_000)
  assert.match(msg, /^msg_[a-f0-9]{12}[A-Za-z0-9]{14}$/)
  assert.match(session, /^ses_[a-f0-9]{12}[A-Za-z0-9]{14}$/)
  assert.equal(BigInt('0x' + msg.slice(4, 16)) >> 12n, 1_700_000_000_000n & ((1n << 36n) - 1n))
  assert.notEqual(msg, identifier('msg', false, 1_700_000_000_000))
})

test('Harness messages and tools override matching native definitions', () => {
  const native = { messages: [{ role: 'system', content: 'native' }], tools: [{ function: { name: 'read', description: 'native' } }, { function: { name: 'skill' } }] }
  const body = { model: 'deepseek-v4.1-flash-free', messages: [{ role: 'tool', tool_call_id: 'a', content: 'result' }], tools: [{ function: { name: 'read', description: 'Harness' } }], stream: false, max_tokens: 20 }
  const result = prepareRequest(native, body)
  assert.equal(result.stream, true)
  assert.equal(result.max_tokens, 20)
  assert.deepEqual(result.messages, [...native.messages, ...body.messages])
  assert.deepEqual(result.tools, [{ function: { name: 'skill' } }, ...body.tools])
  assert.equal(native.tools[0].function.description, 'native')
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
