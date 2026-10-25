import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPreferredTransport } from '../src/preferred.mjs'

const envelope = { url: 'https://opencode.ai/inference/openai/v1/chat/completions', headers: { 'user-agent': 'opencode/fixture' }, body: {} }
const env = { RELAY_PREFERRED_INTERFACE: 'lo', RELAY_PREFERRED_KEY_FINGERPRINT: createHash('sha256').update('third').digest('hex') }
const stream = 'data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'

test('a pinned route keeps its selected key and proxy ahead of mobile preference, including after quotas', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'relay-pinned-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const file = join(directory, 'route.json')
  const proxy = { url: 'socks5h://192.0.2.2:1080', ip: '198.51.100.2' }
  writeFileSync(file, JSON.stringify({ key_fingerprint: createHash('sha256').update('second').digest('hex'), proxy }))
  let quota = false
  const entries = [], attempts = []
  const projects = Object.assign(async (key, ip, _signal, endpoint) => {
    assert.equal(key, 'second'); assert.equal(ip, proxy.ip); assert.equal(endpoint, proxy.url)
    return 'project'
  }, { persistent: true })
  const complete = await createPreferredTransport(envelope, ['first', 'second', 'third'],
    async () => { throw Error('Unexpected fallback') }, projects, { ...env, RELAY_PINNED_ROUTE_FILE: file }, async (_url, init) => {
      attempts.push(init)
      return quota ? Response.json({ error: { type: 'FreeUsageLimitError' } }, { status: 429, headers: { 'Retry-After': '120' } }) : new Response(stream)
    }, entry => entries.push(entry))
  t.after(() => complete.close?.())
  const body = { messages: [], stream: true }
  await (await complete(body, AbortSignal.timeout(3000))).body.cancel()
  quota = true
  for (let i = 0; i < 2; i++) {
    const response = await complete(body, AbortSignal.timeout(3000))
    assert.equal(response.status, 429)
    assert.equal(response.headers.get('retry-after'), '120')
    await response.body.cancel()
  }
  assert.equal(attempts.length, 3)
  assert.ok(attempts.every(init => init.proxy === proxy.url && init.headers.authorization === 'Bearer second'))
  assert.ok(entries.every(entry => entry.proxy_url === proxy.url && entry.public_ip === proxy.ip && entry.key === 'second'))
})

test('a pin referencing an unknown key is rejected without invoking a fallback', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'relay-pinned-invalid-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const file = join(directory, 'route.json')
  writeFileSync(file, JSON.stringify({ key_fingerprint: '0'.repeat(64), proxy: { url: 'socks5h://192.0.2.2:1080', ip: '198.51.100.2' } }))
  await assert.rejects(createPreferredTransport(envelope, ['third'], async () => { throw Error('Unexpected fallback') }, {},
    { RELAY_PINNED_ROUTE_FILE: file }), /pinned/i)
})

test('production route changes apply to new requests while an earlier response keeps streaming', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'relay-reload-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const file = join(directory, 'route.json')
  const route = key => ({ key_fingerprint: createHash('sha256').update(key).digest('hex'),
    proxy: { url: key === 'first' ? 'socks5h://192.0.2.1:1080' : 'socks5h://192.0.2.2:1080', ip: key === 'first' ? '198.51.100.1' : '198.51.100.2' } })
  writeFileSync(file, JSON.stringify(route('first')))
  let upstream
  const attempts = []
  const complete = await createPreferredTransport(envelope, ['first', 'second'], async () => { throw Error('Unexpected fallback') },
    Object.assign(async () => 'project', { persistent: true }), { RELAY_PINNED_ROUTE_FILE: file }, async (_url, init) => {
      attempts.push([init.headers.authorization, init.proxy])
      return attempts.length === 1 ? new Response(new ReadableStream({ start(controller) { upstream = controller } })) : new Response(stream)
    })
  t.after(() => complete.close?.())
  const previous = await complete({ messages: [], stream: true }, AbortSignal.timeout(3000))
  writeFileSync(file, JSON.stringify(route('second')))
  await (await complete({ messages: [], stream: true }, AbortSignal.timeout(3000))).body.cancel()
  upstream.enqueue(new TextEncoder().encode(stream)); upstream.close()
  assert.equal(await previous.text(), stream)
  assert.deepEqual(attempts.map(([authorization]) => authorization), ['Bearer first', 'Bearer second'])
})

test('a pinned interface uses its connection and shares one helper between simultaneous requests', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'relay-interface-pin-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const file = join(directory, 'route.json')
  writeFileSync(file, JSON.stringify({ key_fingerprint: env.RELAY_PREFERRED_KEY_FINGERPRINT, interface: 'lo',
    connection_uuid: '00000000-0000-0000-0000-000000000001' }))
  const endpoints = []
  const projects = Object.assign(async () => 'project', { canUse: () => true, persistent: true })
  const complete = await createPreferredTransport(envelope, ['third'], async () => { throw Error('Unexpected fallback') }, projects,
    { RELAY_PINNED_ROUTE_FILE: file }, async (url, init) => {
      endpoints.push(init.proxy)
      return String(url).includes('ipify') ? Response.json({ ip: '198.51.100.3' }) : new Response(stream)
    })
  t.after(() => complete.close?.())
  await Promise.all([1, 2, 3].map(async () => {
    const response = await complete({ messages: [], stream: true }, AbortSignal.timeout(3000))
    assert.equal(response.status, 200); await response.body.cancel()
  }))
  assert.equal(new Set(endpoints).size, 1)
})

test('records mobile success, quota cooldown and outage without treating the local bridge as an exit proxy', async t => {
  const entries = []
  let quota = false, broken = false
  const projects = Object.assign(async () => 'project', { canUse: () => true, persistent: true })
  const complete = await createPreferredTransport(envelope, ['first', 'second', 'third'], async () => new Response('fallback'), projects, env, async url => {
    if (String(url).includes('ipify')) {
      if (broken) throw new Error('Device unavailable')
      return Response.json({ ip: '198.51.100.9' })
    }
    return quota ? Response.json({ error: { type: 'FreeUsageLimitError' } }, { status: 429, headers: { 'Retry-After': '120' } }) : new Response(stream)
  }, entry => entries.push(entry))
  t.after(() => complete.close())
  const body = { messages: [{ role: 'user', content: 'test' }], stream: true }
  await (await complete(body, AbortSignal.timeout(3000))).body.cancel()
  quota = true
  await (await complete(body, AbortSignal.timeout(3000))).body.cancel()
  await (await complete(body, AbortSignal.timeout(3000))).body.cancel()
  broken = true
  await (await complete(body, AbortSignal.timeout(3000))).body.cancel()
  assert.deepEqual(entries.map(e => [e.phase, e.status, e.quota_reached]), [
    ['inference', 200, false], ['usage', 200, false], ['inference', 429, true], ['cooldown', null, true], ['exit_check', null, null],
  ])
  assert.ok(entries.every(e => e.key === 'third' && e.proxy_url === null && e.interface === 'lo'))
  assert.equal(entries[0].public_ip, '198.51.100.9')
  assert.equal(entries.at(-1).public_ip, null)
})

test('preferred interface keeps its key after reorder and renews context when its public IP changes', async t => {
  let ip = '198.51.100.1'
  const attempts = [], bindings = []
  const projects = Object.assign(async (key, address, _signal, proxy) => {
    assert.equal(key, 'third'); assert.equal(address, ip); assert.match(proxy, /^http:\/\/127\.0\.0\.1:/)
    bindings.push([key, address]); return address.replaceAll('.', '')
  }, { canUse: key => key === 'third', persistent: true })
  const complete = await createPreferredTransport(envelope, ['third', 'first', 'second'], async () => { throw Error('Unexpected fallback') }, projects, env, async (url, init) => {
    if (String(url).startsWith('https://api.ipify.org')) { assert.equal(init.headers?.authorization, undefined); return Response.json({ ip }) }
    attempts.push(init); return new Response(stream)
  })
  t.after(() => complete.close())
  const body = { messages: [{ role: 'user', content: 'same thread' }] }
  assert.equal((await (await complete(body, AbortSignal.timeout(3000))).json()).choices[0].message.content, 'OK')
  ip = '198.51.100.2'
  await (await complete(body, AbortSignal.timeout(3000))).json()
  assert.deepEqual(bindings, [['third', '198.51.100.1'], ['third', '198.51.100.2']])
  assert.equal(attempts[0].headers.authorization, 'Bearer third')
  assert.notEqual(attempts[0].headers['x-opencode-project'], attempts[1].headers['x-opencode-project'])
  assert.notEqual(attempts[0].headers['x-opencode-session'], attempts[1].headers['x-opencode-session'])
})

test('preferred route refuses another key owner and falls back after quota or interface failure', async t => {
  let allowed = false, broken = false, calls = 0, fallbacks = 0
  const projects = Object.assign(async () => 'project', { canUse: () => allowed, persistent: true })
  const complete = await createPreferredTransport(envelope, ['first', 'second', 'third'], async () => { fallbacks++; return new Response('fallback') }, projects, env, async (url) => {
    if (String(url).startsWith('https://api.ipify.org')) { if (broken) throw Error('Interface lost'); return Response.json({ ip: '198.51.100.3' }) }
    calls++; return Response.json({ error: { type: 'FreeUsageLimitError' } }, { status: 429 })
  })
  t.after(() => complete.close())
  const body = { messages: [{ role: 'user', content: 'test' }], stream: true }
  assert.equal(await (await complete(body, AbortSignal.timeout(3000))).text(), 'fallback')
  assert.equal(calls, 0)
  allowed = true
  assert.equal(await (await complete(body, AbortSignal.timeout(3000))).text(), 'fallback')
  assert.equal(calls, 1)
  assert.equal(await (await complete(body, AbortSignal.timeout(3000))).text(), 'fallback')
  assert.equal(calls, 1)
  broken = true
  assert.equal(await (await complete(body, AbortSignal.timeout(3000))).text(), 'fallback')
  assert.equal(fallbacks, 4)
})

test('required mobile route never uses the fallback on ownership conflict, outage or quota', async t => {
  let allowed = false, broken = false, fallbackCalls = 0, inferenceCalls = 0
  const projects = Object.assign(async () => 'project', { canUse: () => allowed, persistent: true })
  const complete = await createPreferredTransport(envelope, ['third'], async () => { fallbackCalls++; return new Response('forbidden') }, projects,
    { ...env, RELAY_PREFERRED_REQUIRED: '1' }, async url => {
      if (String(url).includes('ipify')) {
        if (broken) throw Error('Device unavailable')
        return Response.json({ ip: '198.51.100.8' })
      }
      inferenceCalls++
      return Response.json({ error: { type: 'FreeUsageLimitError' } }, { status: 429, headers: { 'Retry-After': '120' } })
    })
  t.after(() => complete.close())
  const body = { messages: [], stream: true }
  assert.equal((await complete(body, AbortSignal.timeout(3000))).status, 503)
  assert.equal(inferenceCalls, 0)
  allowed = true; broken = true
  assert.equal((await complete(body, AbortSignal.timeout(3000))).status, 503)
  broken = false
  const quota = await complete(body, AbortSignal.timeout(3000))
  assert.equal(quota.status, 429)
  assert.equal(quota.headers.get('retry-after'), '120')
  await quota.body.cancel()
  assert.equal(fallbackCalls, 0)
})

test('required mobile configuration cannot silently run without an interface', async () => {
  await assert.rejects(createPreferredTransport(envelope, ['third'], async () => new Response('forbidden'), {}, { RELAY_PREFERRED_REQUIRED: '1' }), /interface/i)
})

test('an authentication cooldown is not reported as an exhausted quota', async t => {
  const entries = []
  const projects = Object.assign(async () => 'project', { canUse: () => true, persistent: true })
  const complete = await createPreferredTransport(envelope, ['third'], async () => new Response('fallback'), projects, env,
    async url => String(url).includes('ipify') ? Response.json({ ip: '198.51.100.8' }) : new Response('invalid key', { status: 401 }),
    entry => entries.push(entry))
  t.after(() => complete.close())
  await (await complete({ messages: [], stream: true }, AbortSignal.timeout(3000))).body.cancel()
  await (await complete({ messages: [], stream: true }, AbortSignal.timeout(3000))).body.cancel()
  assert.equal(entries.at(-1).phase, 'cooldown')
  assert.equal(entries.at(-1).quota_reached, false)
})
