import { writeFileSync } from 'node:fs'

// Loaded only during regeneration, inside an isolated official OpenCode process.
export default async () => ({
  config(config) {
    config.provider ??= {}
    config.provider.opencode ??= {}
    config.provider.opencode.options ??= {}
    config.provider.opencode.options.fetch = async (url, init) => {
      const body = JSON.parse(init.body)
      if (body.model !== 'deepseek-v4.1-flash-free') throw new Error('Only the free model is allowed')
      body.messages = []
      body.tools = body.tools.filter(tool => ['bash', 'read'].includes(tool.function.name))
      const headers = Object.fromEntries([...new Headers(init.headers)].filter(([name]) => name !== 'authorization'))
      writeFileSync(process.env.RELAY_ENVELOPE_OUTPUT, JSON.stringify({ version: process.env.RELAY_VERSION, url: String(url), headers, body }), { mode: 0o600 })
      return fetch(url, init)
    }
  },
  async 'tool.execute.before'() { throw new Error('Tools are not executed during extraction') },
})
