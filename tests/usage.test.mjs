import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTransport } from '../src/transport.mjs'
import { createAttemptLogger } from '../src/audit.mjs'

const envelope = { url: 'https://opencode.ai/inference/openai/v1/chat/completions',
  headers: { 'user-agent': 'opencode/fixture' }, body: {} }
const finish = 'data: {"choices":[{"delta":{"content":"é"},"finish_reason":"stop"}]}\r\n\r\n'
const usage = 'data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":20,"total_tokens":120,"prompt_tokens_details":{"cached_tokens":60},"completion_tokens_details":{"reasoning_tokens":5}}}\r\n\r\n'
const done = 'data: [DONE]\r\n\r\n'
const bytes = new TextEncoder()

function fixture(response, entries) {
  return createTransport(envelope, 'fixture-key', async () => response, null, null,
    Object.assign(async () => 'project', { persistent: true, ipFor: () => '198.51.100.3' }), entry => entries.push(entry))
}

test('streamed usage keeps bytes intact and attributes the final counters to the actual key and route', async () => {
  const entries = [], wire = finish + usage + done
  const input = bytes.encode(wire)
  const source = new ReadableStream({ start(controller) {
    for (let i = 0; i < input.length; i += 7) controller.enqueue(input.slice(i, i + 7))
    controller.close()
  } })
  const complete = fixture(new Response(source), entries)
  const response = await complete({ model: 'fixture-model', messages: [], stream: true }, undefined, undefined,
    { source: 'relay', proxy_url: 'socks5h://192.0.2.3:1080', request_id: 'harness-request' })
  assert.equal(await response.text(), wire)
  const records = entries.filter(entry => entry.phase === 'usage')
  assert.equal(records.length, 1)
  assert.equal(records[0].usage.prompt_tokens, 100)
  assert.equal(records[0].usage.completion_tokens, 20)
  assert.equal(records[0].usage.total_tokens, 120)
  assert.equal(records[0].key, 'fixture-key')
  assert.equal(records[0].public_ip, '198.51.100.3')
  assert.equal(records[0].proxy_url, 'socks5h://192.0.2.3:1080')
  assert.equal(records[0].source, 'relay')
  assert.equal(records[0].request_id, 'harness-request')
  assert.equal(records[0].stream_complete, true)
})

test('nonstreamed responses record the last cumulative usage once and preserve client usage', async () => {
  const entries = []
  const complete = fixture(new Response(finish + 'data: {"usage":{"total_tokens":1}}\n\n' + usage + done), entries)
  const data = await (await complete({ messages: [], stream: false }, undefined, undefined, { source: 'probe' })).json()
  assert.equal(data.usage.total_tokens, 120)
  const records = entries.filter(entry => entry.phase === 'usage')
  assert.equal(records.length, 1)
  assert.equal(records[0].usage.total_tokens, 120)
  assert.equal(records[0].source, 'probe')
})

test('a complete stream without usage records unknown counters instead of zero', async () => {
  const entries = []
  await (await fixture(new Response(finish + done), entries)({ messages: [], stream: true })).text()
  const record = entries.find(entry => entry.phase === 'usage')
  assert.ok(record)
  assert.equal(record.usage, null)
  assert.equal(record.stream_complete, true)
})

test('cancelling a stream cancels its upstream and records missing usage once', async () => {
  const entries = []
  let cancelled = false
  const source = new ReadableStream({ start(controller) { controller.enqueue(bytes.encode(finish)) },
    cancel() { cancelled = true } })
  const response = await fixture(new Response(source), entries)({ messages: [], stream: true })
  const reader = response.body.getReader()
  await reader.read()
  await reader.cancel('client disconnected')
  assert.equal(cancelled, true)
  const records = entries.filter(entry => entry.phase === 'usage')
  assert.equal(records.length, 1)
  assert.equal(records[0].usage, null)
  assert.equal(records[0].stream_complete, false)
})

test('an interrupted upstream preserves its error and retains only the reported counters', async () => {
  const entries = []
  let source
  const response = await fixture(new Response(new ReadableStream({ start(controller) {
    source = controller; controller.enqueue(bytes.encode(finish + usage))
  } })), entries)({ messages: [], stream: true })
  const reader = response.body.getReader()
  await reader.read()
  source.error(new Error('fixture interruption'))
  await assert.rejects(reader.read(), /fixture interruption/)
  const record = entries.find(entry => entry.phase === 'usage')
  assert.ok(record)
  assert.equal(record.stream_complete, false)
  assert.equal(record.usage.total_tokens, 120)
})

test('large content frames cannot hide later usage or change streaming bytes', async () => {
  const entries = []
  const wire = 'data: ' + JSON.stringify({ choices: [{ delta: { content: 'x'.repeat(100000) } }] }) + '\n\n' + finish + usage + done
  const response = await fixture(new Response(wire), entries)({ messages: [], stream: true })
  assert.equal(await response.text(), wire)
  assert.equal(entries.find(entry => entry.phase === 'usage')?.usage.total_tokens, 120)
})

test('metadata beyond the observation limit is unknown instead of reporting an interrupted client stream', async () => {
  const entries = []
  const wire = 'data: ' + JSON.stringify({ choices: [{ delta: { content: 'x'.repeat(70000) }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } }) + '\n\n' + done
  const response = await fixture(new Response(wire), entries)({ messages: [], stream: true })
  assert.equal(await response.text(), wire)
  const record = entries.find(entry => entry.phase === 'usage')
  assert.equal(record.usage, null)
  assert.equal(record.stream_complete, null)
})

test('usage stays on the initial network snapshot when the network changes during a response', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'relay-network-usage-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const file = join(directory, 'attempts.jsonl')
  writeFileSync(join(directory, 'network-labels.json'), JSON.stringify({ wifi: { usb_4g: false, mobile_data: false }, usb: { usb_4g: true, mobile_data: true } }))
  const complete = createTransport(envelope, 'fixture-key', async () => new Response(finish + usage + done), null, null,
    Object.assign(async () => 'project', { persistent: true, ipFor: () => '198.51.100.3' }), createAttemptLogger(['fixture-key'], file))
  const context = { source: 'relay', interface: 'wifi-fixture', connection_uuid: 'wifi' }
  const response = await complete({ model: 'fixture', messages: [], stream: true }, undefined, undefined, context)
  context.interface = 'usb-fixture'; context.connection_uuid = 'usb'
  await response.text()
  const rows = readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse)
  assert.equal(rows[1].phase, 'usage')
  assert.equal(rows[1].usage.total_tokens, 120)
  assert.equal(rows[1].interface, 'wifi-fixture')
  assert.equal(rows[1].connection_uuid, 'wifi')
  assert.equal(rows[1].usb_4g, false)
})
