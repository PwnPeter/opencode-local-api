import { assemble, identifier, prepareRequest } from './protocol.mjs'

export function createTransport(envelope, apiKey, fetchRequest = fetch) {
  const url = new URL(envelope.url)
  if (url.protocol !== 'https:' || url.hostname !== 'opencode.ai' || !url.pathname.endsWith('/chat/completions'))
    throw new Error('The extracted endpoint must belong to https://opencode.ai')
  if (!apiKey || !envelope.headers?.['user-agent']?.startsWith('opencode/')) throw new Error('Missing OpenCode credentials or protocol')

  return async (body, signal) => {
    const session = identifier('ses', true)
    const response = await fetchRequest(url, {
      method: 'POST', redirect: 'error', signal,
      headers: {
        ...envelope.headers, authorization: `Bearer ${apiKey}`,
        'x-opencode-session': session, 'x-opencode-session-id': session,
        'x-opencode-request': identifier('msg', false),
      },
      body: JSON.stringify(prepareRequest(envelope.body, body)),
    })
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
