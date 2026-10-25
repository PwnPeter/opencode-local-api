import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { fetchIpv4 } from '../src/http.mjs'

const dir = mkdtempSync(join(tmpdir(), 'relay-tls-'))
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
  '-addext', 'subjectAltName=DNS:localhost', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem')], { stdio: 'ignore' })
const ca = readFileSync(join(dir, 'cert.pem'))
const oldCA = process.env.CURL_CA_BUNDLE
process.env.CURL_CA_BUNDLE = join(dir, 'cert.pem')
https.globalAgent.options.ca = ca
const connections = []
const sockets = new Set()
let finish
const upstream = https.createServer({ key: readFileSync(join(dir, 'key.pem')), cert: ca }, async (req, res) => {
  if (req.url === '/stream') { res.write('first'); finish = () => res.end('second'); return }
  if (req.url === '/hold') return
  if (req.url === '/redirect') { res.writeHead(302, { Location: '/target' }).end(); return }
  if (req.url === '/truncated') { res.writeHead(200, { 'Content-Length': '1000' }); res.write('partial'); setImmediate(() => res.destroy()); return }
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const body = Buffer.concat(chunks).toString('utf8')
  res.writeHead(req.url === '/quota' ? 429 : 200, { 'Retry-After': '120' })
  res.end(JSON.stringify({ authorization: req.headers.authorization, body }))
})
const proxy = http.createServer()
proxy.on('connect', (req, client, head) => {
  connections.push({ ...req.headers, target: req.url })
  const remote = net.connect(upstream.address().port, '127.0.0.1', () => {
    client.write('HTTP/1.1 200 Connection established\r\n\r\n')
    if (head.length) remote.write(head)
    client.pipe(remote).pipe(client)
  })
  remote.on('error', () => client.destroy())
  client.on('error', () => remote.destroy())
  client.on('close', () => remote.destroy())
})
for (const server of [upstream, proxy]) {
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
}
const url = `https://localhost:${upstream.address().port}`
const init = { proxy: `http://127.0.0.1:${proxy.address().port}`, method: 'POST', headers: { Authorization: 'Bearer private-fixture' }, body: '{"probe":"ok"}' }
after(async () => {
  for (const socket of sockets) socket.destroy()
  await Promise.all([upstream, proxy].map(server => new Promise(resolve => server.close(resolve))))
  delete https.globalAgent.options.ca
  if (oldCA === undefined) delete process.env.CURL_CA_BUNDLE
  else process.env.CURL_CA_BUNDLE = oldCA
  rmSync(dir, { recursive: true, force: true })
})

test('HTTPS proxy transport tunnels TLS and keeps API credentials out of CONNECT', async () => {
  const before = connections.length
  const response = await fetchIpv4(url, init)
  assert.deepEqual(await response.json(), { authorization: 'Bearer private-fixture', body: '{"probe":"ok"}' })
  assert.equal(connections.length, before + 1)
  assert.equal(connections.at(-1).authorization, undefined)
  assert.equal(connections.at(-1).target, '127.0.0.1:' + upstream.address().port)
})

test('proxy transport streams immediately, preserves HTTP errors and rejects redirects and truncated bodies', async () => {
  const response = await fetchIpv4(url + '/stream', init)
  const reader = response.body.getReader()
  assert.equal(new TextDecoder().decode((await reader.read()).value), 'first')
  finish()
  assert.equal(new TextDecoder().decode((await reader.read()).value), 'second')
  assert.equal((await reader.read()).done, true)
  const quota = await fetchIpv4(url + '/quota', init)
  assert.equal(quota.status, 429)
  assert.equal(quota.headers.get('retry-after'), '120')
  await quota.text()
  await assert.rejects(fetchIpv4(url + '/redirect', init), /redirect/i)
  await assert.rejects(async () => (await fetchIpv4(url + '/truncated', init)).text())
})

test('proxy transport never falls back to direct access and respects cancellation', async () => {
  await assert.rejects(fetchIpv4(url, { ...init, proxy: 'http://127.0.0.1:1' }))
  const controller = new AbortController()
  const pending = fetchIpv4(url + '/hold', { ...init, signal: controller.signal })
  setTimeout(() => controller.abort(), 50)
  await assert.rejects(pending, { name: 'AbortError' })
})

test('proxy transport rejects an untrusted TLS certificate before sending the API credential', async () => {
  const saved = process.env.CURL_CA_BUNDLE
  delete process.env.CURL_CA_BUNDLE
  delete https.globalAgent.options.ca
  try { await assert.rejects(fetchIpv4(url, init)) }
  finally { process.env.CURL_CA_BUNDLE = saved; https.globalAgent.options.ca = ca }
})

test('proxy transport preserves large JSON conversations and cancellation after streaming headers', async () => {
  const body = JSON.stringify({ text: 'é\\n"'.repeat(3 * 1024 * 1024) })
  const response = await fetchIpv4(url, { ...init, body })
  assert.ok((await response.json()).body === body, 'Large UTF-8 request body must arrive unchanged')
  const controller = new AbortController()
  const streaming = await fetchIpv4(url + '/stream', { ...init, signal: controller.signal })
  const pending = streaming.text()
  controller.abort()
  await assert.rejects(pending)
})
