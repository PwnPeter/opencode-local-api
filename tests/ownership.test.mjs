import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { createIPOwnership } from '../src/ownership.mjs'

function database(t) {
  const directory = mkdtempSync(join(tmpdir(), 'relay-ip-owner-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return join(directory, 'private', 'ip-owners.sqlite')
}

test('an IP keeps its first key across reloads and equivalent address spellings', t => {
  const file = database(t)
  const first = createIPOwnership(file)
  assert.equal(first.claim('first-key-fixture', '198.51.100.1'), true)
  assert.equal(first.claim('second-key-fixture', '198.51.100.1'), false)
  assert.equal(first.claim('second-key-fixture', '::ffff:198.51.100.1'), false)
  assert.equal(first.canUse('first-key-fixture', '::ffff:c633:6401'), true)
  assert.equal(first.claim('first-key-fixture', '2001:db8::1'), true)
  first.close()
  const reopened = createIPOwnership(file)
  assert.equal(reopened.claim('second-key-fixture', '2001:0db8:0:0:0:0:0:1'), false)
  assert.equal(reopened.claim('first-key-fixture', '198.51.100.1'), true)
  assert.equal(reopened.claim('second-key-fixture', '198.51.100.2'), true)
  assert.deepEqual(reopened.excluded(), ['198.51.100.1', '198.51.100.2', '2001:db8::1'])
  reopened.close()
  const raw = readFileSync(file)
  assert.ok(!raw.includes(Buffer.from('first-key-fixture')) && !raw.includes(Buffer.from('second-key-fixture')))
  assert.equal(statSync(file).mode & 0o777, 0o600)
})

test('concurrent processes cannot both acquire the same unowned IP', async t => {
  const file = database(t)
  const initial = createIPOwnership(file)
  initial.close()
  const script = [
    'import { createIPOwnership } from ' + JSON.stringify(new URL('../src/ownership.mjs', import.meta.url).href),
    "const owners = createIPOwnership(process.argv[1])",
    "console.log(JSON.stringify({ claimed: owners.claim(process.argv[2], '198.51.100.1') }))",
    'owners.close()',
  ].join('\n')
  const results = await Promise.all(['first-key-fixture', 'second-key-fixture'].map(key =>
    promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, file, key])))
  assert.equal(results.filter(result => JSON.parse(result.stdout).claimed).length, 1)
})

test('legacy exits and retired addresses are never reassigned, including after restart', t => {
  const file = database(t)
  const owners = createIPOwnership(file, ['198.51.100.1'])
  assert.equal(owners.canUse('first-key-fixture', '198.51.100.1'), false)
  assert.equal(owners.claim('second-key-fixture', '198.51.100.1'), false)
  assert.equal(owners.claim('first-key-fixture', '198.51.100.2'), true)
  owners.close()
  const reopened = createIPOwnership(file, ['198.51.100.2'])
  assert.equal(reopened.claim('first-key-fixture', '198.51.100.2'), true)
  reopened.retire(['198.51.100.2'])
  assert.equal(reopened.claim('first-key-fixture', '198.51.100.2'), false)
  assert.equal(reopened.claim('second-key-fixture', '198.51.100.2'), false)
  reopened.close()
})
