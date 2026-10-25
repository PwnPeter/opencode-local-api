import http from 'node:http'
import net from 'node:net'
import tls from 'node:tls'
import { lookup } from 'node:dns/promises'
import { once } from 'node:events'

function receive(socket, boundary) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0)
    function clear() { socket.pause(); socket.off('data', data); socket.off('error', error); socket.off('end', ended); socket.off('close', ended) }
    function error(value) { clear(); reject(value) }
    function ended() { error(new Error('Proxy tunnel closed during negotiation')) }
    function data(chunk) {
      buffer = Buffer.concat([buffer, chunk])
      const end = typeof boundary === 'number' ? (buffer.length >= boundary ? boundary : 0) : boundary(buffer)
      if (end) { clear(); if (buffer.length > end) socket.unshift(buffer.subarray(end)); resolve(buffer.subarray(0, end)) }
      else if (buffer.length > 65536) error(new Error('Oversized proxy negotiation'))
    }
    socket.on('data', data); socket.on('error', error); socket.on('end', ended); socket.on('close', ended); socket.resume()
  })
}

// Only TCP is relayed here. Bun performs and verifies the provider's TLS handshake.
export async function createTunnel(targetURL, proxyURL) {
  const target = new URL(targetURL)
  if (target.protocol !== 'https:') throw new Error('Native transport requires HTTPS')
  const proxy = proxyURL ? new URL(proxyURL) : null
  if (proxy && !['http:', 'https:', 'socks5:', 'socks5h:'].includes(proxy.protocol)) throw new Error('Unsupported proxy protocol')
  const sockets = new Set()
  let closed = false
  const track = socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {}); return socket }
  const server = http.createServer((_request, response) => response.writeHead(405).end())
  server.on('connect', async (request, client, head) => {
    track(client)
    let remote
    try {
      const requested = new URL('https://' + request.url)
      if (requested.hostname !== target.hostname || Number(requested.port || 443) !== Number(target.port || 443))
        throw new Error('Unexpected CONNECT destination')
      const { address } = await lookup(target.hostname, { family: 4 })
      if (closed || client.destroyed) return
      const port = Number(target.port || 443)
      const options = proxy ? { host: proxy.hostname, port: Number(proxy.port || (proxy.protocol === 'https:' ? 443 : 1080)) } : { host: address, port }
      if (proxy?.protocol === 'http:' && !proxy.port) options.port = 80
      remote = track(proxy?.protocol === 'https:' ? tls.connect({ ...options, servername: net.isIP(options.host) ? undefined : options.host, family: 4 }) : net.connect({ ...options, family: 4 }))
      remote.setTimeout(8000, () => remote.destroy(new Error('Proxy negotiation timed out')))
      await once(remote, proxy?.protocol === 'https:' ? 'secureConnect' : 'connect')
      remote.pause()
      if (proxy?.protocol.startsWith('socks5')) {
        remote.write(proxy.username ? Buffer.from([5, 2, 0, 2]) : Buffer.from([5, 1, 0]))
        const greeting = await receive(remote, 2)
        if (greeting[0] !== 5 || ![0, 2].includes(greeting[1])) throw new Error('SOCKS authentication rejected')
        if (greeting[1] === 2) {
          const user = Buffer.from(decodeURIComponent(proxy.username)), password = Buffer.from(decodeURIComponent(proxy.password))
          if (!user.length || user.length > 255 || password.length > 255) throw new Error('Invalid SOCKS credentials')
          remote.write(Buffer.concat([Buffer.from([1, user.length]), user, Buffer.from([password.length]), password]))
          const auth = await receive(remote, 2)
          if (auth[0] !== 1 || auth[1] !== 0) throw new Error('SOCKS authentication rejected')
        }
        remote.write(Buffer.from([5, 1, 0, 1, ...address.split('.').map(Number), port >> 8, port & 255]))
        const reply = await receive(remote, 4)
        if (reply[0] !== 5 || reply[1] !== 0) throw new Error('SOCKS CONNECT rejected')
        const length = reply[3] === 1 ? 4 : reply[3] === 4 ? 16 : reply[3] === 3 ? (await receive(remote, 1))[0] : 0
        if (!length) throw new Error('Invalid SOCKS CONNECT reply')
        await receive(remote, length + 2)
      } else if (proxy) {
        const auth = proxy.username ? 'Proxy-Authorization: Basic ' + Buffer.from(decodeURIComponent(proxy.username) + ':' + decodeURIComponent(proxy.password)).toString('base64') + '\r\n' : ''
        remote.write(`CONNECT ${address}:${port} HTTP/1.1\r\nHost: ${address}:${port}\r\n${auth}\r\n`)
        const reply = await receive(remote, bytes => { const end = bytes.indexOf('\r\n\r\n'); return end < 0 ? 0 : end + 4 })
        if (!/^HTTP\/1\.[01] 2\d\d[ \r]/.test(reply.toString('latin1'))) throw new Error('HTTP CONNECT rejected')
      }
      if (closed || client.destroyed) { remote.destroy(); return }
      remote.setTimeout(0)
      client.write('HTTP/1.1 200 Connection established\r\n\r\n')
      if (head.length) remote.write(head)
      client.on('close', () => remote.destroy()); remote.on('close', () => client.destroy())
      client.pipe(remote).pipe(client)
    } catch { remote?.destroy(); client.destroy() }
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  return { url: `http://127.0.0.1:${server.address().port}`, close() { closed = true; for (const socket of sockets) socket.destroy(); server.close() } }
}
