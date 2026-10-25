import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createProjectStore } from '../src/projects.mjs'

function registry(t) {
  const directory = mkdtempSync(join(tmpdir(), 'relay-projects-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return join(directory, 'private', 'projects.jsonl')
}

test('persists separate key/IP projects across store reloads without copying plaintext keys', async t => {
  const file = registry(t)
  const first = createProjectStore(file)
  const second = createProjectStore(file)
  const project = await first('first-key-fixture', '198.51.100.1')
  assert.equal(await second('first-key-fixture', '198.51.100.1'), project)
  await assert.rejects(second('second-key-fixture', '198.51.100.1'), /reserved|ownership/i)
  const otherKey = await second('second-key-fixture', '198.51.100.2')
  const otherIP = await first('first-key-fixture', '198.51.100.3')
  assert.equal(new Set([project, otherKey, otherIP]).size, 3)
  assert.equal(await createProjectStore(file)('first-key-fixture', '198.51.100.1'), project)
  const raw = readFileSync(file, 'utf8')
  const entries = raw.trim().split('\n').map(line => JSON.parse(line))
  assert.equal(entries.length, 3)
  assert.deepEqual(entries.map(entry => entry.public_ip), ['198.51.100.1', '198.51.100.2', '198.51.100.3'])
  for (const entry of entries) {
    assert.match(entry.key_fingerprint, /^[a-f0-9]{64}$/)
    assert.match(entry.x_opencode_project, /^[a-f0-9]{40}$/)
  }
  assert.ok(!raw.includes('first-key-fixture') && !raw.includes('second-key-fixture'))
  assert.equal(statSync(file).mode & 0o777, 0o600)
  assert.equal(statSync(join(file, '..')).mode & 0o777, 0o700)
})

test('observes the direct public IP before reusing a project and sends no credentials to the IP service', async t => {
  const file = registry(t)
  const ips = ['203.0.113.1', '203.0.113.2', '203.0.113.1']
  const projects = createProjectStore(file, async (url, init) => {
    assert.equal(url, 'https://api.ipify.org?format=json')
    assert.equal(init.method, 'GET')
    assert.equal(new Headers(init.headers).has('authorization'), false)
    assert.equal(init.body, undefined)
    return Response.json({ ip: ips.shift() })
  })
  const first = await projects('key-fixture', undefined, AbortSignal.timeout(2000))
  const second = await projects('key-fixture', undefined, AbortSignal.timeout(2000))
  assert.notEqual(second, first)
  assert.equal(await projects('key-fixture', undefined, AbortSignal.timeout(2000)), first)
  assert.equal(readFileSync(file, 'utf8').trim().split('\n').length, 2)
})

test('keeps the same projects across processes without losing concurrent additions', async t => {
  const file = registry(t)
  const script = `
    import { createProjectStore } from ${JSON.stringify(new URL('../src/projects.mjs', import.meta.url).href)}
    const projects = createProjectStore(process.argv[1])
    for (let i = 1; i <= 8; i++) await projects(process.argv[2], '198.51.100.' + (i + Number(process.argv[3])))
    console.log(await projects('shared-key-fixture', '203.0.113.1'))
  `
  const results = await Promise.all(['first-key-fixture', 'second-key-fixture'].map((key, index) =>
    promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, file, key, String(index * 16)])))
  assert.equal(results[0].stdout.trim(), results[1].stdout.trim())
  const entries = readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  assert.equal(new Set(entries.map(row => JSON.stringify([row.key_fingerprint, row.public_ip]))).size, 17)
  assert.equal(new Set(entries.map(row => row.x_opencode_project)).size, 17)
})

test('preserves a damaged or conflicting registry and refuses to assign projects', async t => {
  const file = registry(t)
  const projects = createProjectStore(file)
  await projects('key-fixture', '198.51.100.1')
  const row = JSON.parse(readFileSync(file, 'utf8').trim())
  for (const content of ['{"partial":', JSON.stringify(row), '{}\n',
    [row, { ...row, public_ip: '198.51.100.2' }].map(value => JSON.stringify(value)).join('\n') + '\n']) {
    writeFileSync(file, content)
    await assert.rejects(projects('key-fixture', '198.51.100.1'), /project registry/i)
    assert.equal(readFileSync(file, 'utf8'), content)
  }
})

test('does not save an unknown exit when discovery fails or the request is cancelled', async t => {
  const file = registry(t)
  let calls = 0
  const projects = createProjectStore(file, async () => {
    calls++
    return Response.json({ ip: 'not-an-ip' })
  })
  await assert.rejects(projects('key-fixture'), /public IP/i)
  assert.equal(readFileSync(file, 'utf8'), '')
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(projects('key-fixture', '198.51.100.1', controller.signal), { name: 'AbortError' })
  assert.equal(calls, 1)
  assert.equal(readFileSync(file, 'utf8'), '')
})

test('verifies a proxy exit before assigning a project and refuses an unexpected exit', async t => {
  const file = registry(t)
  let observed = '198.51.100.1'
  const projects = createProjectStore(file, async (_url, init) => {
    assert.equal(init.proxy, 'http://127.0.0.1:18081')
    assert.equal(new Headers(init.headers).has('authorization'), false)
    return Response.json({ ip: observed })
  })
  const first = await projects('first-key-fixture', '198.51.100.1', AbortSignal.timeout(2000), 'http://127.0.0.1:18081')
  observed = '198.51.100.2'
  await assert.rejects(projects('first-key-fixture', '198.51.100.1', AbortSignal.timeout(2000), 'http://127.0.0.1:18081'), /exit.*changed/i)
  assert.equal(readFileSync(file, 'utf8').trim().split('\n').length, 1)
  observed = '198.51.100.1'
  assert.equal(await projects('first-key-fixture', observed, AbortSignal.timeout(2000), 'http://127.0.0.1:18081'), first)
})
