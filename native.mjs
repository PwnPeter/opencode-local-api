const encoder = new TextEncoder()

export function createNativeTransport({ serverUrl, directory }) {
  let active
  let queue = Promise.resolve()
  const headers = {
    Authorization: `Basic ${Buffer.from(`opencode:${process.env.OPENCODE_SERVER_PASSWORD}`).toString('base64')}`,
    'Content-Type': 'application/json', 'x-opencode-directory': directory,
  }
  async function api(path, body, method = 'POST', signal, timeout = 10_000) {
    const response = await fetch(new URL(path, serverUrl), {
      method, headers, body: body && JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout),
    })
    if (!response.ok) throw new Error(`Native OpenCode API failed: ${response.status}`)
    return response.json()
  }

  function complete(body, signal) {
    const ready = Promise.withResolvers()
    let abort = () => ready.resolve(errorResponse(499, 'Request cancelled'))
    const onAbort = () => abort()
    signal.addEventListener('abort', onAbort, { once: true })
    const run = queue.then(async () => {
      if (signal.aborted) return ready.resolve(errorResponse(499, 'Request cancelled'))
      const chunks = []
      let controller
      const turn = { body, chunks, done: false, sessionID: undefined }
      const stream = new ReadableStream({
        start(c) { controller = c },
        cancel() { turn.cancelled = true; abort() },
      })
      abort = () => {
        turn.finish({ statusCode: 499, message: 'Request cancelled' })
        if (turn.sessionID) api(`/session/${turn.sessionID}/abort`, {}).catch(() => {})
      }
      turn.finish = error => {
        if (turn.done) return
        if (!error && !chunks.length) error = { statusCode: 502, message: 'Native inference returned an empty stream' }
        turn.done = true
        if (error && (!body.stream || !turn.started)) {
          ready.resolve(errorResponse(error.statusCode ?? 502, error.message ?? 'Native inference failed'))
          if (!turn.cancelled) controller.close()
          return
        }
        if (turn.cancelled) return
        if (body.stream) {
          if (error) controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: { message: error.message } })}\n\n`))
          controller.enqueue(encoder.encode('data: [DONE]\n\n'))
          controller.close()
        } else ready.resolve(Response.json(assemble(chunks)))
      }
      turn.chunk = chunk => {
        if (turn.done) return
        if (chunk.error) return turn.finish({ statusCode: 502, ...chunk.error })
        chunks.push(chunk)
        if (body.stream) {
          if (!turn.started) {
            turn.started = true
            ready.resolve(new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' } }))
          }
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`))
        }
      }
      active = turn
      try {
        const session = await api('/session', { title: 'Local API request' }, 'POST', signal)
        turn.sessionID = session.id
        if (signal.aborted) { abort(); return }
        const result = await api(`/session/${session.id}/message`, {
          model: { providerID: 'opencode', modelID: body.model },
          parts: [{ type: 'text', text: 'Local API inference request.' }],
        }, 'POST', signal, 300_000)
        turn.finish(result.info?.error?.data ?? (chunks.length ? undefined : { message: 'Native inference returned no data' }))
      } catch (error) { turn.finish(error) }
      finally {
        active = undefined
        if (turn.sessionID) await api(`/session/${turn.sessionID}`, undefined, 'DELETE').catch(() => {})
      }
    }).finally(() => signal.removeEventListener('abort', onAbort))
    // shortcut: native SDK hooks are shared; serialize until per-session SDK configuration is available.
    queue = run.catch(error => ready.resolve(errorResponse(502, error.message)))
    return ready.promise
  }

  const hooks = {
    config(cfg) {
      cfg.provider ??= {}
      cfg.provider.opencode ??= {}
      cfg.provider.opencode.options ??= {}
      Object.assign(cfg.provider.opencode.options, {
        transformRequestBody(native) {
          if (!active || active.done) throw new Error('Local API inference already complete')
          return prepareRequest(native, active.body)
        },
        metadataExtractor: {
          createStreamExtractor() {
            const turn = active
            return {
              processChunk(chunk) { turn.chunk(chunk) },
              buildMetadata() { turn.finish(); return {} },
            }
          },
        },
      })
    },
    async 'tool.execute.before'() {
      throw new Error('Tools are executed by DeepSeek Harness')
    },
  }
  return { complete, hooks }
}

export function prepareRequest(native, body) {
  const names = new Set((body.tools ?? []).map(x => x.function.name))
  return {
    ...native, ...body, stream: true, stream_options: { include_usage: true },
    messages: [...native.messages.filter(x => x.role === 'system'), ...body.messages],
    tools: [...(native.tools ?? []).filter(x => !names.has(x.function.name)), ...(body.tools ?? [])],
  }
}

export function assemble(chunks) {
  const first = chunks[0] ?? {}
  const message = { role: 'assistant', content: '' }
  const calls = new Map()
  let reason = 'stop'
  let usage
  for (const chunk of chunks) {
    usage = chunk.usage ?? usage
    const choice = chunk.choices?.[0]
    if (!choice) continue
    reason = choice.finish_reason ?? reason
    const delta = choice.delta ?? {}
    message.content += delta.content ?? ''
    if (delta.reasoning_content) message.reasoning_content = (message.reasoning_content ?? '') + delta.reasoning_content
    for (const part of delta.tool_calls ?? []) {
      const call = calls.get(part.index) ?? { id: '', type: 'function', function: { name: '', arguments: '' } }
      if (part.id) call.id = part.id
      call.function.name += part.function?.name ?? ''
      call.function.arguments += part.function?.arguments ?? ''
      calls.set(part.index, call)
    }
  }
  if (calls.size) message.tool_calls = [...calls.values()]
  return { id: first.id, object: 'chat.completion', created: first.created, model: first.model,
    choices: [{ index: 0, message, finish_reason: reason }], ...(usage ? { usage } : {}) }
}

function errorResponse(status, message) {
  return Response.json({ error: { message, type: 'native_opencode_error' } }, { status })
}
