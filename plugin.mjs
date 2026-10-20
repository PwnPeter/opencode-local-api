import { createHandler } from './relay.mjs'
import { createNativeTransport } from './native.mjs'

let server

export default async function localAPI({ serverUrl, directory }) {
  const transport = createNativeTransport({ serverUrl, directory })
  if (!server) {
    server = Bun.serve({
      hostname: '127.0.0.1', port: 4097,
      maxRequestBodySize: 32 * 1024 * 1024,
      idleTimeout: 255,
      fetch: createHandler({
        token: process.env.OPENCODE_LOCAL_API_KEY,
        complete: transport.complete,
      }),
    })
    console.log('OpenCode local API listening on http://127.0.0.1:4097/v1')
  }
  return transport.hooks
}
