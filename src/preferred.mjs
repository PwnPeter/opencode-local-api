import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { isIP } from 'node:net'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { createNativeFetch } from './native.mjs'
import { createTransport } from './transport.mjs'
import { routeConfig, routeIdentity } from './routes.mjs'

export async function createPreferredTransport(envelope, keys, fallback, projects, env = process.env, fetchRequest = createNativeFetch(), audit) {
  if (env.RELAY_PINNED_ROUTE_FILE) {
    const delegates = new Map()
    const load = async () => {
      const pinned = routeConfig(JSON.parse(readFileSync(env.RELAY_PINNED_ROUTE_FILE, 'utf8')))
      const id = routeIdentity(pinned)
      const previous = delegates.get(id)
      if (previous && (await previous).isAvailable?.() === false && delegates.get(id) === previous) delegates.delete(id)
      if (!delegates.has(id)) {
        const pending = (async () => {
          const key = keys.filter(Boolean).find(value => createHash('sha256').update(value).digest('hex') === pinned.key_fingerprint)
          if (!key) throw new Error('Invalid pinned key')
          if (pinned.interface) return createPreferredTransport(envelope, keys, fallback, projects,
            { RELAY_PINNED_ROUTE_FILE: '', RELAY_PREFERRED_INTERFACE: pinned.interface,
              RELAY_PREFERRED_CONNECTION_UUID: pinned.connection_uuid, RELAY_PREFERRED_KEY_FINGERPRINT: pinned.key_fingerprint,
              RELAY_PREFERRED_REQUIRED: '1' }, fetchRequest, audit)
          const proxy = pinned.proxy
          const projectFor = Object.assign((_key, _ip, requestSignal) => projects(key, proxy.ip, requestSignal, proxy.url), { persistent: true })
          const fetchPinned = (url, init) => fetchRequest(url, { ...init, proxy: proxy.url })
          const complete = createTransport(envelope, key, fetchPinned, null, null, projectFor, audit)
          return (body, signal, headers, context = {}) => complete(body, signal, headers,
            { ...context, public_ip: proxy.ip, proxy_url: proxy.url })
        })()
        delegates.set(id, pending)
        pending.catch(() => { if (delegates.get(id) === pending) delegates.delete(id) })
      }
      return delegates.get(id)
    }
    await load()
    // shortcut: retain the configured delegates until exit so route changes cannot close an active stream.
    return Object.assign(async (...args) => (await load())(...args), {
      async close() { await Promise.allSettled([...delegates.values()].map(async entry => (await entry).close?.())) },
    })
  }
  const required = env.RELAY_PREFERRED_REQUIRED === '1'
  if (required && !env.RELAY_PREFERRED_INTERFACE) throw new Error('Required mobile interface is missing')
  if (!env.RELAY_PREFERRED_INTERFACE) return fallback
  const key = [...new Set(keys.filter(Boolean))].find(value => createHash('sha256').update(value).digest('hex') === env.RELAY_PREFERRED_KEY_FINGERPRINT)
  if (!key || !/^[A-Za-z0-9_.:-]{1,15}$/.test(env.RELAY_PREFERRED_INTERFACE) ||
      (env.RELAY_PREFERRED_CONNECTION_UUID && !/^[a-f0-9-]{36}$/.test(env.RELAY_PREFERRED_CONNECTION_UUID)))
    throw new Error('Invalid preferred interface or key fingerprint')
  const args = [fileURLToPath(new URL('../scripts/interface_proxy.py', import.meta.url)), '--interface', env.RELAY_PREFERRED_INTERFACE]
  if (env.RELAY_PREFERRED_CONNECTION_UUID) args.push('--connection', env.RELAY_PREFERRED_CONNECTION_UUID)
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => ['PATH', 'LANG', 'LC_ALL', 'TZ'].includes(name)))
  const child = spawn('python3', args, { env: environment, stdio: ['ignore', 'pipe', 'ignore'] })
  const stop = () => child.kill()
  process.once('exit', stop)
  child.once('close', () => process.off('exit', stop))
  const proxy = await new Promise((resolve, reject) => {
    const lines = createInterface({ input: child.stdout })
    const timer = setTimeout(() => { stop(); reject(new Error('Preferred interface proxy did not start')) }, 8000)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('exit', () => { clearTimeout(timer); reject(new Error('Preferred interface proxy stopped')) })
    lines.once('line', line => {
      clearTimeout(timer); lines.close(); child.stdout.resume()
      try { const url = new URL(JSON.parse(line).url); if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') throw new Error('Invalid local proxy'); resolve(url.href) }
      catch (error) { stop(); reject(error) }
    })
  })
  const routes = new Map()
  const fetchBound = (url, init) => fetchRequest(url, { ...init, proxy })
  const complete = async (body, signal, headers, context = {}) => {
    const requestID = context.request_id || randomUUID()
    const started = Date.now()
    const connection = { ...context, request_id: requestID, interface: env.RELAY_PREFERRED_INTERFACE,
      connection_uuid: env.RELAY_PREFERRED_CONNECTION_UUID || null }
    let dispatched = false
    try {
      const observed = await fetchBound('https://api.ipify.org?format=json', {
        method: 'GET', signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(8000)]),
      })
      if (!observed.ok) { await observed.body?.cancel(); throw new Error('Preferred exit verification failed') }
      const { ip } = await observed.json()
      if (isIP(ip) !== 4 || !projects.canUse(key, ip)) throw new Error('Preferred exit is not permitted for this key')
      let route = routes.get(ip)
      if (!route) {
        if (routes.size >= 64) routes.delete(routes.keys().next().value)
        const projectFor = Object.assign((_key, _ip, requestSignal) => projects(key, ip, requestSignal, proxy), { persistent: true })
        route = { complete: createTransport(envelope, key, fetchBound, null, null, projectFor, audit), blockedUntil: 0 }
        routes.set(ip, route)
      }
      if (route.blockedUntil <= Date.now()) {
        dispatched = true
        const response = await route.complete(body, signal, headers, { ...connection, public_ip: ip })
        const quota = response.status === 429 && (await response.clone().json().catch(() => null))?.error?.type === 'FreeUsageLimitError'
        if (required || (!quota && ![401, 403].includes(response.status))) {
          console.info(`Preferred interface ${env.RELAY_PREFERRED_INTERFACE}: HTTP ${response.status} via ${ip}`)
          return response
        }
        const retry = response.headers.get('retry-after')
        const seconds = retry && /^\d+$/.test(retry) ? Number(retry) : retry ? (Date.parse(retry) - Date.now()) / 1000 : NaN
        route.blockedUntil = Date.now() + (seconds > 0 ? seconds : 3600) * 1000
        route.blockedQuota = quota
        await response.body?.cancel()
      } else await audit?.({ ...connection, key, model: body.model, public_ip: ip, proxy_url: null,
        phase: 'cooldown', started_at: started, status: null, quota_reached: route.blockedQuota,
        retry_after: String(Math.ceil((route.blockedUntil - Date.now()) / 1000)) })
    } catch (error) {
      if (!dispatched) await audit?.({ ...connection, key, model: body.model, public_ip: null, proxy_url: null,
        phase: 'exit_check', started_at: started, status: null, quota_reached: null, error_type: error.name })
      if (signal?.aborted) throw signal.reason
    }
    if (required) return Response.json({ error: { type: 'mobile_route_unavailable', message: 'The configured mobile connection is unavailable.' } },
      { status: 503, headers: { 'Cache-Control': 'no-store', 'Retry-After': '5' } })
    return fallback(body, signal, headers, { ...context, request_id: requestID })
  }
  return Object.assign(complete, { isAvailable: () => !child.killed && child.exitCode === null && child.signalCode === null,
    async close() { process.off('exit', stop); if (child.exitCode === null && child.signalCode === null) { stop(); await once(child, 'close') } } })
}
