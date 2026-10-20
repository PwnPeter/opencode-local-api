import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { setTimeout } from 'node:timers/promises'
import { createHandler } from './relay.mjs'
import { createTransport } from './transport.mjs'

if (process.argv.includes('--check')) {
  let ready = false
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const response = await fetch('http://127.0.0.1:4097/v1/models', {
        headers: { authorization: `Bearer ${process.env.OPENCODE_LOCAL_API_KEY}` }, signal: AbortSignal.timeout(1000),
      })
      await response.body?.cancel()
      if (response.ok) { ready = true; break }
    } catch {}
    await setTimeout(250)
  }
  if (!ready) throw new Error('Local relay did not become ready')
} else {
  const envelope = JSON.parse(readFileSync(process.env.RELAY_ENVELOPE_FILE, 'utf8'))
  const handle = createHandler({ token: process.env.OPENCODE_LOCAL_API_KEY, complete: createTransport(envelope, process.env.OPENCODE_API_KEY) })
  const server = createServer(async (incoming, outgoing) => {
    const controller = new AbortController()
    outgoing.on('close', () => controller.abort())
    try {
      const request = new Request(`http://127.0.0.1:4097${incoming.url}`, {
        method: incoming.method, headers: incoming.headers, signal: controller.signal,
        ...(!['GET', 'HEAD'].includes(incoming.method) ? { body: Readable.toWeb(incoming), duplex: 'half' } : {}),
      })
      const response = await handle(request)
      outgoing.writeHead(response.status, Object.fromEntries(response.headers))
      if (response.body) await pipeline(Readable.fromWeb(response.body), outgoing)
      else outgoing.end()
    } catch {
      if (!outgoing.headersSent) outgoing.writeHead(502)
      outgoing.end()
    }
  })
  server.listen(4097, '127.0.0.1', () => console.log(`Local relay ready on 127.0.0.1:4097 (protocol ${envelope.version})`))
}
