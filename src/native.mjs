import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { createTunnel } from './tunnel.mjs'

export function nativeRuntimeFile(env = process.env) {
  return env.RELAY_NATIVE_RUNTIME_FILE || join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'opencode-local-api', 'native-runtime')
}

export function createNativeFetch(runtime = nativeRuntimeFile()) {
  return async (url, { method = 'GET', headers, body, signal, proxy }) => {
    signal?.throwIfAborted()
    const requestHeaders = Object.fromEntries(new Headers(headers))
    const tunnel = await createTunnel(url, proxy)
    if (signal?.aborted) { tunnel.close(); throw signal.reason }
    return new Promise((resolve, reject) => {
      const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => ['PATH', 'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS'].includes(name)))
      const child = spawn(runtime, [fileURLToPath(new URL('./native-worker.mjs', import.meta.url))], {
        env: { ...environment, BUN_BE_BUN: '1' }, stdio: ['pipe', 'pipe', 'pipe'],
      })
      let ready = false, buffer = Buffer.alloc(0)
      const output = new Transform({ transform(chunk, _encoding, callback) {
        if (ready) { callback(null, chunk); return }
        buffer = Buffer.concat([buffer, chunk])
        const newline = buffer.indexOf('\n')
        if (newline < 0) {
          if (buffer.length > 65536) { const error = new Error('Oversized native response headers'); fail(error); callback(error) }
          else callback()
          return
        }
        try {
          if (newline > 65536) throw new Error('Oversized native response headers')
          const metadata = JSON.parse(buffer.subarray(0, newline).toString())
          const empty = [204, 205, 304].includes(metadata.status)
          const response = new Response(empty ? null : Readable.toWeb(output), { status: metadata.status, headers: metadata.headers })
          if (empty) output.resume()
          ready = true; resolve(response)
          callback(null, buffer.subarray(newline + 1)); buffer = Buffer.alloc(0)
        } catch (error) { fail(error); callback(error) }
      } })
      function stop() { signal?.removeEventListener('abort', abort); tunnel.close(); if (child.exitCode === null) child.kill() }
      function fail(error) { reject(error); output.destroy(error); stop() }
      const abort = () => fail(signal.reason)
      output.on('error', () => {}); output.on('close', stop)
      child.on('error', fail); child.stderr.resume(); child.stdin.on('error', () => {})
      child.stdout.on('error', fail); child.stdout.pipe(output, { end: false })
      child.on('close', code => {
        signal?.removeEventListener('abort', abort); tunnel.close()
        if (code !== 0 || !ready) fail(new Error('Native HTTPS request failed'))
        else output.end()
      })
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
      // Credentials and proxy routing never appear in argv or the worker environment.
      try { child.stdin.end(JSON.stringify({ url: String(url), init: { method, headers: requestHeaders, body, proxy: tunnel.url } })) }
      catch (error) { fail(error) }
    })
  }
}
