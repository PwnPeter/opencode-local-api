import { assemble, identifier, prepareRequest } from './protocol.mjs'
import { createHash } from 'node:crypto'
import { setTimeout } from 'node:timers/promises'
import { fetchIpv4 } from './http.mjs'

export function apiKeysFromEnv(env = process.env) {
  return [env.OPENCODE_API_KEY, env.OPENCODE_API_KEY_BACKUP, ...(env.OPENCODE_API_KEYS || '').split(',').map(key => key.trim())]
}

export function createTransport(envelope, apiKey, fetchRequest = fetchIpv4) {
  const apiKeys = [...new Set([apiKey].flat().filter(Boolean))]
  const url = new URL(envelope.url)
  if (url.protocol !== 'https:' || url.hostname !== 'opencode.ai' || !url.pathname.endsWith('/chat/completions'))
    throw new Error('The extracted endpoint must belong to https://opencode.ai')
  if (!apiKeys.length || apiKeys.some(key => typeof key !== 'string') || !envelope.headers?.['user-agent']?.startsWith('opencode/'))
    throw new Error('Missing OpenCode credentials or protocol')

  const sessions = new Map()
  function sessionFor(headers, body, apiKey) {
    const incoming = headers?.get('x-opencode-session') || headers?.get('x-opencode-session-id') || headers?.get('x-dsh-session-id')
    const firstUser = body.messages.find(message => message.role === 'user')
    // shortcut: identical opening messages share routing affinity when no conversation ID is supplied.
    const identity = incoming ? `header:${incoming}` : firstUser ? `prompt:${JSON.stringify(firstUser.content)}` : null
    if (!identity) return identifier('ses', true)
    const key = createHash('sha256').update(JSON.stringify([apiKey, identity])).digest('hex')
    const now = Date.now()
    const current = sessions.get(key)
    if (current && now - current.created < 30 * 60_000) return current.id
    if (sessions.size >= 512) sessions.delete(sessions.keys().next().value)
    const id = identifier('ses', true)
    sessions.set(key, { id, created: now })
    return id
  }

  let activeKey = 0
  return async (body, signal, clientHeaders) => {
    const start = activeKey
    let response
    for (let offset = 0; offset < apiKeys.length; offset++) {
      const index = (start + offset) % apiKeys.length
      const key = apiKeys[index]
      const session = sessionFor(clientHeaders, body, key)
      for (let attempt = 0; attempt < 4; attempt++) {
        response = await fetchRequest(url, {
          method: 'POST', redirect: 'error', signal,
          headers: {
            ...envelope.headers, authorization: `Bearer ${key}`,
            'x-opencode-session': session, 'x-opencode-session-id': session,
            'x-opencode-request': identifier('msg', false),
          },
          body: JSON.stringify(prepareRequest(envelope.body, body)),
        })
        if (response.status !== 503 || attempt === 3 || response.headers.has('retry-after')) break
        await response.body?.cancel()
        await setTimeout(500 * 2 ** attempt, undefined, { signal })
      }
      if (![401, 403, 429].includes(response.status)) break
      if (response.status === 429) {
        const error = await response.clone().json().catch(() => null)
        if (error?.error?.type !== 'FreeUsageLimitError') break
      }
      if (activeKey === index) activeKey = (index + 1) % apiKeys.length
      if (offset === apiKeys.length - 1) break
      await response.body?.cancel()
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
