import assert from 'node:assert/strict'
import dns from 'node:dns'
import http from 'node:http'
import https from 'node:https'
import { after, beforeEach, test } from 'node:test'
import { gzipSync } from 'node:zlib'
import { fetchIpv4 } from '../src/http.mjs'

let finishStream
let entered
let closed
let redirects = 0
const server = http.createServer(async (request, response) => {
  if (request.url === '/hold' || request.url === '/stream') {
    response.on('close', () => closed?.())
    if (request.url === '/stream') {
      response.setHeader('Content-Type', 'text/event-stream')
      response.write('first')
      finishStream = () => response.end('second')
    }
    entered?.()
    return
  }
  if (request.url === '/redirect') {
    response.writeHead(302, { Location: '/target' }).end()
    return
  }
  if (request.url === '/target') redirects++
  if (request.url === '/gzip') {
    response.writeHead(200, { 'Content-Encoding': 'gzip' }).end(gzipSync('encoded'))
    return
  }
  if (request.url === '/truncated') {
    response.writeHead(200, { 'Content-Length': '1000' })
    response.write('partial')
    setImmediate(() => response.destroy())
    return
  }
  if (request.url === '/quota') {
    response.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '123' })
    response.end('{"error":{"type":"FreeUsageLimitError"}}')
    return
  }
  if (request.url === '/empty') {
    response.writeHead(204).end()
    return
  }
  let body = ''
  for await (const chunk of request) body += chunk
  response.end(JSON.stringify({ peer: request.socket.remoteAddress, encoding: request.headers['accept-encoding'], authorization: request.headers.authorization, body }))
})
await new Promise(resolve => server.listen(0, '::', resolve))
after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }))
const url = `http://localhost:${server.address().port}`
beforeEach(t => {
  // Exercise real TCP and streams without a TLS certificate fixture.
  t.mock.method(https, 'request', http.request)
})

test('uses IPv4 even when DNS prefers IPv6, preserving the request body', async t => {
  const order = dns.getDefaultResultOrder()
  t.after(() => dns.setDefaultResultOrder(order))
  dns.setDefaultResultOrder('ipv6first')
  const response = await fetchIpv4(url, { method: 'POST', headers: new Headers({ Authorization: 'Bearer fixture', 'Content-Type': 'application/json' }), body: '{"probe":"ok"}' })
  assert.deepEqual(await response.json(), { peer: '::ffff:127.0.0.1', encoding: 'identity', authorization: 'Bearer fixture', body: '{"probe":"ok"}' })
})

test('does not fall back to an IPv6-only listener', async t => {
  let reached = false
  const ipv6 = http.createServer((_request, response) => { reached = true; response.end('IPv6') })
  await new Promise(resolve => ipv6.listen(0, '::1', resolve))
  t.after(() => new Promise(resolve => { ipv6.closeAllConnections(); ipv6.close(resolve) }))
  await assert.rejects(fetchIpv4(`http://localhost:${ipv6.address().port}`, {}), { code: 'ECONNREFUSED' })
  assert.equal(reached, false)
})

test('delivers streaming bytes before the upstream response finishes', async () => {
  const response = await fetchIpv4(url + '/stream', {})
  const reader = response.body.getReader()
  assert.equal(new TextDecoder().decode((await reader.read()).value), 'first')
  finishStream()
  assert.equal(new TextDecoder().decode((await reader.read()).value), 'second')
  assert.equal((await reader.read()).done, true)
})

test('preserves quota errors and retry headers and handles empty responses', async () => {
  const response = await fetchIpv4(url + '/quota', {})
  assert.equal(response.status, 429)
  assert.equal(response.headers.get('retry-after'), '123')
  assert.deepEqual(await response.json(), { error: { type: 'FreeUsageLimitError' } })
  const empty = await fetchIpv4(url + '/empty', {})
  assert.equal(empty.status, 204)
  assert.equal(empty.body, null)
})

test('rejects redirects without following them and rejects unexpected compression', async () => {
  await assert.rejects(fetchIpv4(url + '/redirect', { redirect: 'error' }), /redirect/i)
  assert.equal(redirects, 0)
  await assert.rejects(fetchIpv4(url + '/gzip', {}), /encoding/i)
})

test('cancellation before headers closes the upstream connection', { timeout: 3000 }, async () => {
  const controller = new AbortController()
  const arrived = new Promise(resolve => { entered = resolve })
  const disconnected = new Promise(resolve => { closed = resolve })
  const pending = fetchIpv4(url + '/hold', { signal: controller.signal })
  await arrived
  controller.abort()
  await assert.rejects(pending, { name: 'AbortError' })
  await disconnected
})

test('cancelling the response body closes the upstream stream', { timeout: 3000 }, async () => {
  const disconnected = new Promise(resolve => { closed = resolve })
  const response = await fetchIpv4(url + '/stream', {})
  await response.body.cancel()
  await disconnected
})

test('an abort after headers interrupts the response stream', { timeout: 3000 }, async () => {
  const controller = new AbortController()
  const disconnected = new Promise(resolve => { closed = resolve })
  const response = await fetchIpv4(url + '/stream', { signal: controller.signal })
  const pending = response.text()
  controller.abort()
  await assert.rejects(pending)
  await disconnected
})

test('truncated upstream bodies never resolve as complete responses', async () => {
  await assert.rejects(async () => {
    const response = await fetchIpv4(url + '/truncated', {})
    await response.text()
  })
})
