import { timingSafeEqual } from 'node:crypto'

const MODEL = 'deepseek-v4.1-flash-free'
const MAX_BODY = 32 * 1024 * 1024

export function createHandler({ token, complete }) {
  if (!token || typeof complete !== 'function') throw new Error('Local credential and native transport are required')
  const expected = Buffer.from(`Bearer ${token}`)

  return async request => {
    const auth = Buffer.from(request.headers.get('authorization') ?? '')
    if (auth.length !== expected.length || !timingSafeEqual(auth, expected))
      return failure(401, 'Local API authentication required')

    const path = new URL(request.url).pathname
    if (request.method === 'GET' && path === '/v1/models')
      return Response.json({ object: 'list', data: [{ id: MODEL, object: 'model', owned_by: 'opencode' }] })
    if (request.method !== 'POST' || path !== '/v1/chat/completions')
      return failure(404, 'Unknown API route')

    let body
    try {
      if (Number(request.headers.get('content-length')) > MAX_BODY) return failure(413, 'Request too large')
      const chunks = []
      let size = 0
      for await (const chunk of request.body ?? []) {
        size += chunk.byteLength
        if (size > MAX_BODY) return failure(413, 'Request too large')
        chunks.push(chunk)
      }
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      return failure(400, 'Invalid JSON')
    }
    if (!body || body.model !== MODEL || !Array.isArray(body.messages) || !body.messages.length)
      return failure(400, `Use ${MODEL} and a nonempty messages array`)
    if (!body.messages.every(message => message && typeof message === 'object' && typeof message.role === 'string') ||
        (body.stream !== undefined && typeof body.stream !== 'boolean') ||
        (body.tools !== undefined && (!Array.isArray(body.tools) || !body.tools.every(tool =>
          tool?.type === 'function' && typeof tool.function?.name === 'string' && tool.function.name.length > 0))))
      return failure(400, 'Invalid messages, stream flag or function tools')

    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(300_000)])
    try {
      return await complete(body, signal, request.headers)
    } catch (error) {
      return failure(error.name === 'TimeoutError' || signal.reason?.name === 'TimeoutError' ? 504 : 502, 'OpenCode upstream request failed')
    }
  }
}

function failure(status, message) {
  return Response.json({ error: { message, type: 'local_api_error' } }, { status })
}
