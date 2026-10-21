import { randomBytes } from 'node:crypto'

let lastTimestamp = 0
let counter = 0

// Native ID encoding from opencode v1.19.3, packages/schema/src/identifier.ts (MIT).
export function identifier(prefix, descending, timestamp = Date.now()) {
  if (timestamp !== lastTimestamp) { lastTimestamp = timestamp; counter = 0 }
  const current = BigInt(timestamp) * 4096n + BigInt(++counter)
  const time = BigInt.asUintN(48, descending ? ~current : current).toString(16).padStart(12, '0')
  return `${prefix}_${time}${Array.from(randomBytes(14), byte => '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'[byte % 62]).join('')}`
}

export function prepareRequest(native, body) {
  const names = new Set((body.tools ?? []).map(tool => tool.function.name))
  return {
    ...native, ...body, stream: true, stream_options: { include_usage: true },
    messages: body.messages,
    // shortcut: the current gate accepts bash/read; refresh probes detect future incompatibilities.
    tools: [...(native.tools ?? []).filter(tool => ['bash', 'read'].includes(tool.function.name) && !names.has(tool.function.name)), ...(body.tools ?? [])],
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
