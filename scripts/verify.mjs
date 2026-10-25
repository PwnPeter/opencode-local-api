import { readFileSync } from 'node:fs'
import { apiKeysFromEnv, createTransport, readChunks } from '../src/transport.mjs'
import { createProjectStore, projectStoreFile } from '../src/projects.mjs'
import { proxiesFromEnv } from '../src/proxy.mjs'
import { createPreferredTransport } from '../src/preferred.mjs'
import { createAttemptLogger } from '../src/audit.mjs'

const envelope = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const proxies = proxiesFromEnv()
const projects = createProjectStore(projectStoreFile(), undefined, proxies?.map(proxy => proxy.ip))
const keys = apiKeysFromEnv()
const audit = createAttemptLogger(keys)
const fallback = createTransport(envelope, keys, undefined, proxies, undefined, projects, audit)
const complete = await createPreferredTransport(envelope, keys, fallback, projects, process.env, undefined, audit)
const model = 'deepseek-v4.1-flash-free'
const nonce = `RELAY_${crypto.randomUUID().replaceAll('-', '')}`
const base = { model, thinking: { type: 'disabled' }, max_tokens: 256 }
async function call(body) {
  const response = await complete({ ...base, ...body }, AbortSignal.timeout(90_000), undefined, { source: 'verification' })
  if (!response.ok) throw new Error(`OpenCode rejected the extracted protocol: HTTP ${response.status}`)
  return body.stream ? assembleStream(response) : response.json()
}
async function assembleStream(response) {
  const chunks = await readChunks(response)
  return chunks.flatMap(chunk => chunk.choices ?? []).map(choice => choice.delta?.content ?? '').join('')
}
console.log('Check: text')
const text = await call({ messages: [{ role: 'user', content: `Reply exactly ${nonce}. Do not call tools.` }] })
if (!text.choices?.[0]?.message.content?.includes(nonce)) throw new Error('Text response check failed')
const tools = [{ type: 'function', function: { name: 'relay_probe', description: 'Return a value', parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] } } }]
const messages = [{ role: 'user', content: 'Call relay_probe with value test.' }]
console.log('Check: tool call')
const result = await call({ messages, tools, tool_choice: { type: 'function', function: { name: 'relay_probe' } } })
const assistant = result.choices?.[0]?.message
const tool = assistant?.tool_calls?.[0]
if (tool?.function.name !== 'relay_probe' || JSON.parse(tool.function.arguments).value !== 'test') throw new Error('Tool-call check failed')
console.log('Check: streaming tool result')
const streamed = await call({ stream: true, tools, tool_choice: 'none', messages: [...messages, assistant,
  { role: 'tool', tool_call_id: tool.id, content: JSON.stringify({ result: nonce }) },
  { role: 'user', content: 'Reply exactly the result value. Do not call tools.' },
] })
if (!streamed.includes(nonce)) throw new Error('Streaming tool round-trip check failed')
console.log('Verified: text, native identifiers, tool call, tool result, complete SSE stream')
await complete.close?.()
