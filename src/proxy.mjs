import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { isIP } from 'node:net'
import { spawn, execFileSync } from 'node:child_process'
import { Transform, Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { canonicalIP } from './ip.mjs'
import { lookup } from 'node:dns/promises'

export async function fetchProxy(url, { method = 'GET', headers, body, signal, proxy }) {
  signal?.throwIfAborted()
  const target = new URL(url)
  if (target.protocol !== 'https:') throw new Error('Proxy requests require HTTPS')
  const { address: ipv4 } = await lookup(target.hostname, { family: 4 })
  signal?.throwIfAborted()
  const address = new URL(proxy)
  if (!['http:', 'https:', 'socks5:', 'socks5h:'].includes(address.protocol)) throw new Error('Unsupported proxy protocol')
  if (address.protocol === 'socks5:') address.protocol = 'socks5h:'
  return new Promise((resolve, reject) => {
    // Keep API keys and proxy credentials off the process command line.
    const config = [['url', String(url)], ['proxy', address.href], ['request', method],
      // Resolve before CONNECT so proxy-side DNS cannot select IPv6; keep TLS host validation.
      ['connect-to', `${target.hostname}:${target.port || 443}:${ipv4}:${target.port || 443}`],
      ...[...new Headers(headers)].map(([name, value]) => ['header', `${name}: ${value}`]),
      ['header', 'accept-encoding: identity']]
      .map(([name, value]) => `${name} = ${JSON.stringify(value)}\n`).join('') +
      // Read the body from the remaining stdin to avoid curl's config-line size limit.
      (body === undefined ? '' : 'data-binary = "@-"\n' + body)
    const child = spawn('curl', ['--disable', '--config', '-', '--silent', '--show-error', '--no-buffer',
      '--ipv4', '--noproxy', '', '--connect-timeout', '8', '--max-time', '300', '--proto', '=https',
      '--suppress-connect-headers', '--include'], { stdio: ['pipe', 'pipe', 'pipe'] })
    let ready = false
    let buffer = Buffer.alloc(0)
    const output = new Transform({ transform(chunk, _encoding, callback) {
      if (ready) { callback(null, chunk); return }
      buffer = Buffer.concat([buffer, chunk])
      let end
      while ((end = buffer.indexOf('\r\n\r\n')) >= 0) {
        const [statusLine, ...lines] = buffer.subarray(0, end).toString('latin1').split('\r\n')
        buffer = buffer.subarray(end + 4)
        const status = Number(statusLine.match(/^HTTP\/\S+ (\d{3})/)?.[1])
        if (status >= 100 && status < 200) continue
        try {
          if (end > 65536) throw new Error('Oversized proxy response headers')
          if ([301, 302, 303, 307, 308].includes(status)) throw new Error('Upstream redirects are not allowed')
          const responseHeaders = new Headers()
          for (const line of lines) {
            const colon = line.indexOf(':')
            if (colon > 0) responseHeaders.append(line.slice(0, colon), line.slice(colon + 1).trim())
          }
          if (responseHeaders.has('content-encoding') && responseHeaders.get('content-encoding') !== 'identity')
            throw new Error('Unexpected upstream content encoding')
          const empty = [204, 205, 304].includes(status)
          if (empty) output.resume()
          const response = new Response(empty ? null : Readable.toWeb(output), { status, headers: responseHeaders })
          ready = true
          resolve(response)
          callback(null, buffer)
          buffer = Buffer.alloc(0)
        } catch (error) { callback(error); fail(error) }
        return
      }
      if (buffer.length > 65536) { const error = new Error('Oversized proxy response headers'); callback(error); fail(error) }
      else callback()
    } })
    output.on('error', () => {})
    function fail(error) {
      reject(error)
      output.destroy(error)
      child.kill()
    }
    const abort = () => fail(signal.reason)
    child.on('error', fail)
    child.stderr.resume()
    child.stdout.on('error', fail)
    child.stdout.pipe(output, { end: false })
    output.on('close', () => child.kill())
    child.stdin.on('error', () => {})
    child.on('close', code => {
      signal?.removeEventListener('abort', abort)
      if (code !== 0 || !ready) fail(new Error('Proxy HTTPS request failed'))
      else output.end()
    })
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    child.stdin.end(config)
  })
}

export function proxiesFromEnv(env = process.env) {
  if (!env.RELAY_PROXIES_FILE) return undefined
  const proxies = JSON.parse(readFileSync(env.RELAY_PROXIES_FILE, 'utf8'))
  if (!Array.isArray(proxies) || !proxies.length) throw new Error('Proxy pool must not be empty')
  return proxies
}

function discoverProxies(file, excluded, signal) {
  signal = AbortSignal.any([signal, AbortSignal.timeout(60_000)])
  return new Promise((resolve, reject) => {
    const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('OPENCODE_')))
    const child = spawn('python3', [fileURLToPath(new URL('../scripts/proxies.py', import.meta.url)),
      '--refresh', '--output', file, '--exclude-ips', '-'], { env: environment, detached: true, stdio: ['pipe', 'ignore', 'ignore'] })
    child.stdin.on('error', () => {})
    child.stdin.end(JSON.stringify(excluded))
    const abort = () => {
      if (child.pid) { try { process.kill(-child.pid, 'SIGTERM') } catch { child.kill() } }
      reject(signal.reason)
    }
    child.on('error', reject)
    child.on('close', code => {
      signal.removeEventListener('abort', abort)
      if (signal.aborted) { reject(signal.reason); return }
      if (code !== 0) { reject(new Error('Proxy discovery did not find a fresh exit')); return }
      try { resolve(JSON.parse(readFileSync(file, 'utf8'))) } catch (error) { reject(error) }
    })
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
  })
}

export function createProxyRefresher(env = process.env) {
  if (!env.RELAY_PROXIES_FILE) return undefined
  let job
  return (excluded, signal) => {
    signal?.throwIfAborted()
    if (!job || job.controller.signal.aborted) {
      const current = { controller: new AbortController(), users: 0 }
      job = current
      current.promise = discoverProxies(env.RELAY_PROXIES_FILE, excluded, current.controller.signal)
        .finally(() => { if (job === current) job = undefined })
    }
    const current = job
    current.users++
    return new Promise((resolve, reject) => {
      let done = false
      function finish(callback, value) {
        if (done) return
        done = true
        signal?.removeEventListener('abort', abort)
        if (--current.users === 0 && job === current) current.controller.abort()
        callback(value)
      }
      const abort = () => finish(reject, signal.reason)
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
      current.promise.then(value => finish(resolve, value), error => finish(reject, error))
    })
  }
}

export function startProxyTunnels(entries) {
  const names = [...new Set((entries ?? []).filter(e => e.source === 'vpngate').map(e => e.container))]
  if (names.some(name => !/^opencode-egress-[a-f0-9]{12}$/.test(name))) throw new Error('Invalid VPN Gate container name')
  if (!names.length) return
  try { execFileSync('podman', ['start', ...names], { stdio: 'ignore', timeout: 30_000 }) }
  catch { console.warn('VPN Gate tunnel startup failed; proxy-only mode remains enabled') }
}

export function createProxyPool(entries, { canUse = () => true, claim = () => true } = {}) {
  if (entries === undefined) return null
  const proxies = new Map()
  function add(entries) {
    if (!Array.isArray(entries) || !entries.length) throw new Error('Proxy pool must not be empty')
    const additions = new Map()
    for (const entry of entries) {
      const url = new URL(entry.url)
      if (!['http:', 'https:', 'socks5:', 'socks5h:'].includes(url.protocol) || !isIP(entry.ip) ||
          !['', '/'].includes(url.pathname) || url.search || url.hash)
        throw new Error('Invalid proxy URL or exit IP')
      const ip = canonicalIP(entry.ip)
      additions.set(ip, { url: entry.url, ip })
    }
    const before = proxies.size
    for (const [ip, proxy] of additions) if (!proxies.has(ip)) proxies.set(ip, proxy)
    return proxies.size - before
  }
  add(entries)
  const routes = new Map()
  const blocked = new Map()
  const owners = new Map()
  return {
    add,
    excluded: () => [...proxies.keys()],
    current(index, excluded = new Set()) {
      const current = routes.get(index)
      if (current && !excluded.has(current.ip) && !(blocked.get(current.ip) > Date.now()) &&
          canUse(index, current.ip)) return current
      if (current) routes.delete(index)
      const assigned = new Set([...routes].filter(([key]) => key !== index).map(([, route]) => route.ip))
      const candidates = [...proxies.values()]
      const available = candidates.filter(p => !excluded.has(p.ip) && !(blocked.get(p.ip) > Date.now()) &&
        !assigned.has(p.ip) && (!owners.has(p.ip) || owners.get(p.ip) === index) && canUse(index, p.ip))
      const preferred = available.find(p => p === candidates[index])
      for (const proxy of preferred ? [preferred, ...available.filter(p => p !== preferred)] : available) {
        if (!claim(index, proxy.ip)) continue
        owners.set(proxy.ip, index)
        const route = { ...proxy, id: randomUUID() }
        routes.set(index, route)
        return route
      }
      return null
    },
    failed(index, route, seconds) {
      blocked.set(route.ip, Math.max(blocked.get(route.ip) || 0, Date.now() + seconds * 1000))
      if (routes.get(index) === route) routes.delete(index)
    },
  }
}
