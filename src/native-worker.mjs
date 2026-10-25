import { readFileSync } from 'node:fs'
import { once } from 'node:events'

try {
  const { url, init } = JSON.parse(readFileSync(0, 'utf8'))
  const response = await fetch(url, { ...init, proxy: { url: init.proxy, respectNoProxy: false }, redirect: 'error' })
  const headers = new Headers(response.headers)
  // Bun already decodes the body; the parent receives its decoded stream.
  for (const name of ['content-encoding', 'content-length', 'transfer-encoding']) headers.delete(name)
  process.stdout.write(JSON.stringify({ status: response.status, headers: Object.fromEntries(headers) }) + '\n')
  if (response.body) for await (const bytes of response.body)
    if (!process.stdout.write(bytes)) await once(process.stdout, 'drain')
} catch { process.exitCode = 1 }
