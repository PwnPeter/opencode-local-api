import { assemble, identifier, prepareRequest } from './protocol.mjs'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { setTimeout } from 'node:timers/promises'
import { fetchIpv4 } from './http.mjs'
import { createProxyPool, createProxyRefresher, proxiesFromEnv } from './proxy.mjs'
import { createProjectStore, IPOwnershipError, ProxyExitError } from './projects.mjs'
import { createNativeFetch } from './native.mjs'

export function apiKeysFromEnv(env = process.env) {
  return [env.OPENCODE_API_KEY, env.OPENCODE_API_KEY_BACKUP, ...(env.OPENCODE_API_KEYS || '').split(',').map(key => key.trim())]
}

export function createTransport(envelope, apiKey, fetchRequest, proxies = proxiesFromEnv(), refreshProxies = createProxyRefresher(), projectFor = createProjectStore(), audit) {
  const apiKeys = [...new Set([apiKey].flat().filter(Boolean))]
  const pool = proxies === null ? null : createProxyPool(proxies, {
    canUse: (index, ip) => projectFor.canUse?.(apiKeys[index], ip) ?? true,
    claim: (index, ip) => projectFor.reserve?.(apiKeys[index], ip) ?? true,
  })
  const url = new URL(envelope.url)
  if (url.protocol !== 'https:' || url.hostname !== 'opencode.ai' || !url.pathname.endsWith('/chat/completions'))
    throw new Error('The extracted endpoint must belong to https://opencode.ai')
  if (!apiKeys.length || apiKeys.some(key => typeof key !== 'string') || !envelope.headers?.['user-agent']?.startsWith('opencode/'))
    throw new Error('Missing OpenCode credentials or protocol')
  const baseHeaders = Object.fromEntries([...new Headers(envelope.headers)].filter(([name]) =>
    ['content-type', 'accept', 'user-agent', 'x-opencode-client'].includes(name)))
  const v2 = /^v?2\./.test(envelope.version || '')
  fetchRequest ??= v2 ? createNativeFetch() : fetchIpv4
  const scopes = new Map()

  const sessions = new Map()
  function sessionFor(headers, body, apiKey, route, project) {
    const incoming = headers?.get('x-opencode-session') || headers?.get('x-opencode-session-id') || headers?.get('x-dsh-session-id')
    const firstUser = body.messages.find(message => message.role === 'user')
    // shortcut: identical opening messages share routing affinity when no conversation ID is supplied.
    const identity = incoming ? `header:${incoming}` : firstUser ? `prompt:${JSON.stringify(firstUser.content)}` : null
    if (!identity) return identifier('ses', true)
    const key = createHash('sha256').update(JSON.stringify([apiKey, identity, route?.ip, project])).digest('hex')
    const now = Date.now()
    const current = sessions.get(key)
    if (current && now - current.created < 30 * 60_000) return current.id
    if (sessions.size >= 512) sessions.delete(sessions.keys().next().value)
    const id = identifier('ses', true)
    sessions.set(key, { id, created: now })
    return id
  }

  let activeKey = 0
  return async (body, signal, clientHeaders, context = {}) => {
    const requestID = context.request_id || randomUUID()
    let index = activeKey
    const tried = new Set()
    const visitedIPs = new Set()
    const rejected = new Set()
    let response
    while (true) {
      signal?.throwIfAborted()
      const route = pool?.current(index, visitedIPs)
      if (pool && !route) {
        if (!refreshProxies) {
          if (response) break
          throw new Error('No proxy exit is currently available')
        }
        try {
          const excluded = [...new Set([...pool.excluded(), ...(projectFor.excluded?.() || [])])]
          const added = pool.add(await refreshProxies(excluded, signal))
          if (added) console.info(`Proxy pool replenished (+${added} exit IPs)`)
          else await setTimeout(5000, undefined, { signal })
        } catch (error) {
          if (signal?.aborted) throw signal.reason
          await setTimeout(5000, undefined, { signal })
        }
        continue
      }
      const key = apiKeys[index]
      tried.add(index)
      if (route) visitedIPs.add(route.ip)
      let project, verifiedIP = null
      const record = fields => audit?.({ ...context, request_id: requestID, key, model: body.model,
        proxy_url: route?.url || context.proxy_url || null, public_ip: verifiedIP, expected_public_ip: route?.ip || null, ...fields })
      const send = async (target, init, phase) => {
        const started = Date.now()
        let result
        try { result = await fetchRequest(target, init) }
        catch (error) {
          await record({ phase, started_at: started, status: null, quota_reached: null, error_type: error.name })
          throw error
        }
        if (audit) {
          const error = result.ok ? null : (await result.clone().json().catch(() => null))?.error?.type
          await record({ phase, started_at: started, status: result.status, error_type: error,
            quota_reached: error === 'FreeUsageLimitError' ? true : phase === 'configuration' || (result.status === 429 && !error) ? null : false,
            retry_after: result.headers.get('retry-after') })
        }
        return result
      }
      const projectStarted = Date.now()
      try {
        project = await projectFor(key, route?.ip, signal, route?.url)
        verifiedIP = route?.ip || projectFor.ipFor?.(project) || context.public_ip || null
      }
      catch (error) {
        await record({ phase: 'exit_check', started_at: projectStarted, status: null, quota_reached: null, error_type: error.name })
        if (!pool || !(error instanceof IPOwnershipError || error instanceof ProxyExitError)) throw error
        pool.failed(index, route, 60)
        if (!pool.current(index, visitedIPs) && !refreshProxies) {
          if (response) break
          throw error
        }
        continue
      }
      const session = sessionFor(clientHeaders, body, key, route, project)
      try {
        if (v2 && !scopes.has(key)) {
          const configurationResponse = await send('https://opencode.ai/console/api/v2/config', {
            method: 'GET', redirect: 'error', signal, ...(route ? { proxy: route.url } : {}),
            headers: { authorization: 'Bearer ' + key, accept: 'application/json' },
          }, 'configuration')
          if (configurationResponse.ok) {
            const configuration = await configurationResponse.json()
            const org = configuration.providers?.opencode?.headers?.['x-opencode-org-id']
            if (org !== undefined && (typeof org !== 'string' || !org || org.length > 256 || /[\r\n]/.test(org)))
              throw new Error('Invalid provider organization scope')
            scopes.set(key, org ? Object.fromEntries(new Headers({ 'x-opencode-org-id': org })) : {})
          } else response = configurationResponse
        }
        if (!v2 || scopes.has(key))
        for (let attempt = 0; attempt < 4; attempt++) {
          const trace = randomBytes(16).toString('hex'), span = randomBytes(8).toString('hex')
          response = await send(url, {
            method: 'POST', redirect: 'error', signal, ...(route ? { proxy: route.url } : {}),
            headers: {
              ...baseHeaders, ...scopes.get(key), authorization: 'Bearer ' + key,
              'x-opencode-project': project,
              'x-opencode-session': session, 'x-opencode-session-id': session,
              'x-session-affinity': session, 'x-session-id': session,
              ...(v2 ? {} : { 'x-opencode-request': identifier('msg', false) }),
              traceparent: '00-' + trace + '-' + span + '-01', b3: trace + '-' + span + '-1',
            },
            body: JSON.stringify(prepareRequest(envelope.body, body, project)),
          }, 'inference')
          if (response.status !== 503 || attempt === 3 || response.headers.has('retry-after')) break
          await response.body?.cancel()
          await setTimeout(500 * 2 ** attempt, undefined, { signal })
        }
      } catch (error) {
        if (!pool || signal?.aborted) throw error
        pool.failed(index, route, 60)
        if (!pool.current(index, visitedIPs) && !refreshProxies) throw error
        continue
      }
      const quota = response.status === 429 && (await response.clone().json().catch(() => null))?.error?.type === 'FreeUsageLimitError'
      const invalid = [401, 403].includes(response.status)
      if (!invalid && !quota) break
      if (!pool && projectFor.persistent) break
      if (invalid) rejected.add(index)
      if (quota && pool) {
        const retry = response.headers.get('retry-after')
        const seconds = retry && /^\d+$/.test(retry) ? Number(retry) : retry ? (Date.parse(retry) - Date.now()) / 1000 : NaN
        pool.failed(index, route, seconds > 0 ? seconds : 3600)
      }
      let next
      for (let step = 1; step <= apiKeys.length; step++) {
        const candidate = (index + step) % apiKeys.length
        if (!rejected.has(candidate)) { next = candidate; break }
      }
      if (next === undefined) break
      if (activeKey === index) activeKey = next
      if ((!pool && tried.has(next)) || (pool && !pool.current(next, visitedIPs) && !refreshProxies)) break
      index = next
      // Drain the error connection but retain a readable fallback if every later exit fails.
      response = new Response(await response.arrayBuffer(), { status: response.status, headers: response.headers })
    }
    const headers = new Headers({ 'Cache-Control': 'no-store' })
    for (const name of ['content-type', 'retry-after', 'x-opencode-log-id'])
      if (response.headers.has(name)) headers.set(name, response.headers.get(name))
    if (!response.ok || body.stream) return new Response(response.body, { status: response.status, headers })
    try { return Response.json(assemble(await readChunks(response))) }
    catch (error) { return Response.json({ error: { type: 'upstream_stream_error', message: error.message } }, { status: 502 }) }
  }
}

export async function readChunks(response) {
  const decoder = new TextDecoder()
  const chunks = []
  let buffer = ''
  let done = false
  function line(value) {
    if (!value.startsWith('data:')) return
    const data = value.slice(5).trim()
    if (data === '[DONE]') { done = true; return }
    if (!data) return
    const chunk = JSON.parse(data)
    if (chunk.error) throw new Error(chunk.error.message ?? 'Upstream inference failed')
    chunks.push(chunk)
  }
  for await (const bytes of response.body) {
    buffer += decoder.decode(bytes, { stream: true })
    let end
    while ((end = buffer.indexOf('\n')) >= 0) {
      line(buffer.slice(0, end))
      buffer = buffer.slice(end + 1)
    }
  }
  line(buffer + decoder.decode())
  if (!done || !chunks.some(chunk => chunk.choices?.some(choice => choice.finish_reason != null)))
    throw new Error('Incomplete or empty upstream stream')
  return chunks
}
