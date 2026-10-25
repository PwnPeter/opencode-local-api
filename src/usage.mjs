// Observe provider counters without buffering or rewriting the response body.
export function trackUsage(response, record) {
  if (!response.body) return response
  const reader = response.body.getReader(), decoder = new TextDecoder()
  let buffer = '', skipping = false, limited = false, done = false, finished = false, invalid = false
  let usage = null, cancelled = false, reported
  function line(value) {
    if (!value.startsWith('data:')) return
    const data = value.slice(5).trim()
    if (data === '[DONE]') { done = true; return }
    if (!data) return
    try {
      const chunk = JSON.parse(data)
      if (chunk?.usage && typeof chunk.usage === 'object' && !Array.isArray(chunk.usage)) usage = chunk.usage
      if (chunk?.choices?.some(choice => choice.finish_reason != null)) finished = true
      if (chunk?.error) invalid = true
    } catch { invalid = true }
  }
  function consume(text) {
    let start = 0, end
    while ((end = text.indexOf('\n', start)) >= 0) {
      if (!skipping) {
        if (buffer.length + end - start <= 65536) line(buffer + text.slice(start, end))
        else limited = true
      }
      buffer = ''; skipping = false; start = end + 1
    }
    if (!skipping) {
      // shortcut: observe metadata lines up to 64 KiB; larger-line metadata stays unknown.
      if (buffer.length + text.length - start > 65536) { buffer = ''; skipping = true; limited = true }
      else buffer += text.slice(start)
    }
  }
  function report(error_type = null) {
    let stream_complete = done && finished && !invalid && !cancelled && !error_type
    if (done && limited && !finished && !invalid && !cancelled && !error_type) stream_complete = null
    reported ??= Promise.resolve().then(() => record({ usage,
      stream_complete, error_type })).catch(() => {})
    return reported
  }
  const body = new ReadableStream({
    async pull(controller) {
      try {
        const result = await reader.read()
        if (cancelled) return
        if (result.done) {
          consume(decoder.decode())
          if (buffer && !skipping) line(buffer)
          await report()
          controller.close()
        } else {
          consume(decoder.decode(result.value, { stream: true }))
          controller.enqueue(result.value)
        }
      } catch (error) {
        if (cancelled) return
        await report('StreamReadError')
        controller.error(error)
      }
    },
    async cancel(reason) {
      cancelled = true
      try { await reader.cancel(reason) }
      finally { await report('StreamCancelled') }
    },
  })
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
}
