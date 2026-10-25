import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { chooseRoute, routeIdentity, writeRoute } from '../src/routes.mjs'

const first = { name: 'wifi', key_fingerprint: '1'.repeat(64), interface: 'wlan0', connection_uuid: '00000000-0000-0000-0000-000000000001' }
const second = { name: 'proxy', key_fingerprint: '2'.repeat(64), proxy: { url: 'socks5h://192.0.2.2:1080', ip: '198.51.100.2' } }
const ok = name => ({ name, status: 200, stream_complete: true, expected_text: true })

test('selection retains a healthy current route and only promotes a complete successful generation', () => {
  assert.equal(routeIdentity(chooseRoute([first, second], [ok('wifi'), ok('proxy')], second)), routeIdentity(second))
  assert.equal(routeIdentity(chooseRoute([first, second], [ok('wifi'), { name: 'proxy', status: 429 }], second)), routeIdentity(first))
  assert.equal(chooseRoute([first, second], [{ name: 'wifi', status: 200, stream_complete: false }, { name: 'proxy', status: 429 }], second), null)
})

test('a successful diagnostic-only key cannot be promoted into production', () => {
  assert.equal(chooseRoute([first, second], [ok('proxy')], first, new Set([first.key_fingerprint])), null)
})

test('selected route storage strips unrelated data and replaces the file with private permissions', t => {
  const directory = mkdtempSync(join(tmpdir(), 'relay-selection-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const file = join(directory, 'selected.json')
  writeRoute(file, { ...first, api_key: 'private-fixture-secret', messages: ['private prompt'] })
  assert.equal(routeIdentity(JSON.parse(readFileSync(file, 'utf8'))), routeIdentity(first))
  writeRoute(file, second)
  assert.equal(routeIdentity(JSON.parse(readFileSync(file, 'utf8'))), routeIdentity(second))
  assert.equal(statSync(file).mode & 0o777, 0o600)
  assert.ok(!readFileSync(file, 'utf8').includes('private'))
  const snapshot = JSON.stringify(first, null, 2).replaceAll('\n', '\r\n') + '\r\n'
  writeFileSync(file, snapshot)
  assert.equal(writeRoute(file, second, snapshot), true)
  assert.equal(routeIdentity(JSON.parse(readFileSync(file, 'utf8'))), routeIdentity(second))
})

test('concurrent route publications cannot overwrite another verified selection from the same snapshot', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'relay-selection-race-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const file = join(directory, 'selected.json')
  writeRoute(file, first)
  const snapshot = readFileSync(file, 'utf8')
  const other = { ...second, key_fingerprint: '3'.repeat(64) }
  const script = `import { writeRoute } from ${JSON.stringify(new URL('../src/routes.mjs', import.meta.url).href)}; console.log(writeRoute(process.argv[1], JSON.parse(process.argv[2]), process.argv[3]));`
  const results = await Promise.all([second, other].map(route => promisify(execFile)(process.execPath,
    ['--input-type=module', '-e', script, file, JSON.stringify(route), snapshot])))
  assert.equal(results.filter(result => result.stdout.trim() === 'true').length, 1)
  assert.equal(results.filter(result => result.stdout.trim() === 'false').length, 1)
})
