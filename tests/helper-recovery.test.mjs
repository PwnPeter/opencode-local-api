import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'

test('a cached interface route recovers after its helper process exits', async t => {
  const original = childProcess.spawn
  const helpers = []
  childProcess.spawn = () => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), exitCode: null, signalCode: null, port: 22000 + helpers.length })
    child.kill = () => { child.exitCode = 0; queueMicrotask(() => { child.emit('exit', 0); child.emit('close', 0) }); return true }
    helpers.push(child)
    queueMicrotask(() => child.stdout.write(JSON.stringify({ url: 'http://127.0.0.1:' + child.port }) + '\n'))
    return child
  }
  syncBuiltinESMExports()
  t.after(() => { childProcess.spawn = original; syncBuiltinESMExports() })
  const { createPreferredTransport } = await import('../src/preferred.mjs')
  const directory = mkdtempSync(join(tmpdir(), 'relay-helper-recovery-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const file = join(directory, 'pin.json')
  writeFileSync(file, JSON.stringify({ key_fingerprint: createHash('sha256').update('fixture-key').digest('hex'),
    interface: 'lo', connection_uuid: '00000000-0000-0000-0000-000000000001' }))
  const stream = 'data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
  const complete = await createPreferredTransport({ url: 'https://opencode.ai/inference/openai/v1/chat/completions',
    headers: { 'user-agent': 'opencode/fixture' }, body: {} }, ['fixture-key'], async () => { throw Error('Fallback forbidden') },
    Object.assign(async () => 'project', { canUse: () => true, persistent: true }), { RELAY_PINNED_ROUTE_FILE: file },
    async (url, init) => {
      const helper = helpers.find(child => String(child.port) === new URL(init.proxy).port)
      if (helper?.exitCode !== null) throw Error('Connection refused')
      return String(url).includes('ipify') ? Response.json({ ip: '198.51.100.1' }) : new Response(stream)
    })
  t.after(() => complete.close?.())
  await (await complete({ messages: [], stream: true }, AbortSignal.timeout(3000))).body.cancel()
  helpers[0].exitCode = 1; helpers[0].emit('exit', 1); helpers[0].emit('close', 1)
  const recovered = await Promise.all(Array.from({ length: 3 }, () => complete({ messages: [], stream: true }, AbortSignal.timeout(3000))))
  for (const response of recovered) {
    assert.equal(response.status, 200)
    assert.equal(await response.text(), stream)
  }
  assert.equal(helpers.length, 2)
})
