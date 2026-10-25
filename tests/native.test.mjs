import assert from 'node:assert/strict'
import { test } from 'node:test'
import http from 'node:http'
import net from 'node:net'
import https from 'node:https'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { createTunnel } from '../src/tunnel.mjs'
import { createNativeFetch, nativeRuntimeFile } from '../src/native.mjs'

test('invalid headers fail before starting a native worker or listening tunnel', async t => {
  await nextTurn()
  const before = new Set(process._getActiveHandles())
  const controller = new AbortController()
  t.after(() => controller.abort())
  await assert.rejects(createNativeFetch(process.execPath)('https://localhost', {
    headers: { 'x-opencode-org-id': 'invalid\0scope' }, signal: controller.signal,
  }), TypeError)
  await nextTurn()
  const leaked = process._getActiveHandles().filter(handle => !before.has(handle) && ['Server', 'ChildProcess'].includes(handle.constructor.name))
  assert.equal(leaked.length, 0)
})

test('native tunnel resolves IPv4 and separates proxy authentication from provider TLS', async t => {
  const sockets = new Set()
  const target = net.createServer(socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.pipe(socket) })
  await new Promise(resolve => target.listen(0, '127.0.0.1', resolve))
  const requests = []
  const proxy = http.createServer()
  proxy.on('connect', (request, client, head) => {
    requests.push(request)
    const remote = net.connect(target.address().port, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 OK\r\n\r\n')
      if (head.length) remote.write(head)
      client.pipe(remote).pipe(client)
    })
    remote.on('error', () => client.destroy()); client.on('error', () => remote.destroy())
    client.on('close', () => remote.destroy())
  })
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve))
  const tunnel = await createTunnel(`https://localhost:${target.address().port}`, `http://user:password@127.0.0.1:${proxy.address().port}`)
  t.after(async () => { tunnel.close(); for (const socket of sockets) socket.destroy(); await Promise.all([target, proxy].map(s => new Promise(r => s.close(r)))) })
  const address = new URL(tunnel.url)
  const socket = net.connect(Number(address.port), address.hostname)
  t.after(() => socket.destroy())
  socket.write(`CONNECT localhost:${target.address().port} HTTP/1.1\r\nHost: localhost\r\n\r\n`)
  const received = await new Promise(resolve => socket.once('data', resolve))
  assert.match(received.toString(), /^HTTP\/1.1 200/)
  assert.equal(requests[0].url, '127.0.0.1:' + target.address().port)
  assert.equal(requests[0].headers['proxy-authorization'], 'Basic ' + Buffer.from('user:password').toString('base64'))
  assert.equal(requests[0].headers.authorization, undefined)
})

test('native fetch preserves streaming, verifies TLS and cancels without a direct fallback', async t => {
  const runtime = process.env.RELAY_TEST_NATIVE_BINARY || nativeRuntimeFile()
  if (!existsSync(runtime)) { t.skip('Install the verified native runtime to run this local TLS integration test'); return }
  const directory = mkdtempSync(join(tmpdir(), 'relay-native-tls-'))
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost', '-keyout', join(directory, 'key.pem'), '-out', join(directory, 'cert.pem')], { stdio: 'ignore' })
  const previous = process.env.SSL_CERT_FILE
  process.env.SSL_CERT_FILE = join(directory, 'cert.pem')
  let finish
  const sockets = new Set()
  const upstream = https.createServer({ key: readFileSync(join(directory, 'key.pem')), cert: readFileSync(join(directory, 'cert.pem')) }, (request, response) => {
    assert.equal(request.headers.authorization, 'Bearer provider-fixture')
    if (request.url === '/redirect') { response.writeHead(302, { location: '/stream' }); response.end(); return }
    if (request.url === '/hold') return
    response.write('first'); finish = () => response.end('second')
  })
  upstream.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    if (previous === undefined) delete process.env.SSL_CERT_FILE; else process.env.SSL_CERT_FILE = previous
    for (const socket of sockets) socket.destroy()
    await new Promise(resolve => upstream.close(resolve)); rmSync(directory, { recursive: true, force: true })
  })
  const fetchRequest = createNativeFetch(runtime)
  const url = `https://localhost:${upstream.address().port}`
  const init = { method: 'GET', headers: { authorization: 'Bearer provider-fixture' }, signal: AbortSignal.timeout(5000) }
  const response = await fetchRequest(url + '/stream', init)
  const reader = response.body.getReader()
  assert.equal(new TextDecoder().decode((await reader.read()).value), 'first')
  finish()
  assert.equal(new TextDecoder().decode((await reader.read()).value), 'second')
  assert.equal((await reader.read()).done, true)
  await assert.rejects(fetchRequest(url + '/redirect', init))
  await assert.rejects(fetchRequest(url + '/stream', { ...init, proxy: 'http://127.0.0.1:1' }))
  const controller = new AbortController()
  const pending = fetchRequest(url + '/hold', { ...init, signal: controller.signal })
  setTimeout(() => controller.abort(), 50)
  await assert.rejects(pending, { name: 'AbortError' })
  delete process.env.SSL_CERT_FILE
  await assert.rejects(fetchRequest(url + '/stream', init))
})

test('SOCKS tunnels use literal IPv4 and support private proxy credentials', async t => {
  const sockets = new Set(), seen = [], tunnels = []
  const target = net.createServer(socket => socket.pipe(socket))
  const socks = net.createServer(socket => {
    let buffer = Buffer.alloc(0), phase = 'greeting', remote
    const record = {}
    function input(chunk) {
      buffer = Buffer.concat([buffer, chunk])
      while (true) {
        if (phase === 'greeting') {
          if (buffer.length < 2 || buffer.length < 2 + buffer[1]) return
          const auth = buffer.subarray(2, 2 + buffer[1]).includes(2)
          buffer = buffer.subarray(2 + buffer[1]); socket.write(Buffer.from([5, auth ? 2 : 0])); phase = auth ? 'auth' : 'connect'
        } else if (phase === 'auth') {
          if (buffer.length < 2 || buffer.length < 3 + buffer[1]) return
          const userLength = buffer[1], passwordLength = buffer[2 + userLength]
          if (buffer.length < 3 + userLength + passwordLength) return
          record.credentials = [buffer.subarray(2, 2 + userLength).toString(), buffer.subarray(3 + userLength, 3 + userLength + passwordLength).toString()]
          buffer = buffer.subarray(3 + userLength + passwordLength); socket.write(Buffer.from([1, 0])); phase = 'connect'
        } else {
          if (buffer.length < 10) return
          record.addressType = buffer[3]; record.ip = [...buffer.subarray(4, 8)].join('.')
          record.port = buffer.readUInt16BE(8); seen.push(record)
          buffer = buffer.subarray(10); socket.off('data', input); socket.pause()
          remote = net.connect(record.port, record.ip, () => {
            socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]))
            if (buffer.length) remote.write(buffer)
            socket.pipe(remote).pipe(socket)
          })
          remote.on('error', () => socket.destroy()); socket.on('close', () => remote.destroy())
          return
        }
      }
    }
    socket.on('data', input)
  })
  for (const server of [target, socks]) {
    server.on('connection', socket => { sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket)) })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  }
  t.after(async () => { for (const tunnel of tunnels) tunnel.close(); for (const socket of sockets) socket.destroy(); await Promise.all([target, socks].map(s => new Promise(r => s.close(r)))) })
  for (const auth of ['', 'user:password@']) {
    const tunnel = await createTunnel(`https://localhost:${target.address().port}`, `socks5h://${auth}127.0.0.1:${socks.address().port}`)
    tunnels.push(tunnel)
    const socket = net.connect(Number(new URL(tunnel.url).port), '127.0.0.1')
    socket.write(`CONNECT localhost:${target.address().port} HTTP/1.1\r\nHost: localhost\r\n\r\n`)
    assert.match((await new Promise(resolve => socket.once('data', resolve))).toString(), /^HTTP\/1.1 200/)
    socket.write('payload')
    assert.equal((await new Promise(resolve => socket.once('data', resolve))).toString(), 'payload')
    socket.destroy()
  }
  assert.deepEqual(seen.map(record => [record.addressType, record.ip, record.port]), [[1, '127.0.0.1', target.address().port], [1, '127.0.0.1', target.address().port]])
  assert.deepEqual(seen[1].credentials, ['user', 'password'])
})
