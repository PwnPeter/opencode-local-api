import { writeFileSync } from 'node:fs'

// OpenCode 2's supported HTTP hook stops extraction before any provider request.
export default {
  id: 'relay.local-capture',
  async setup(ctx) {
    await ctx.session.hook('http.request', async ({ request }) => {
      let body = await request.clone().json()
      const url = new URL(request.url)
      if (url.origin !== 'https://opencode.ai' || !url.pathname.endsWith('/chat/completions') ||
          body.model !== 'deepseek-v4.1-flash-free') throw new Error('Unexpected extraction request')
      body.messages = body.messages.filter(message => message.role === 'system')
      let template = JSON.stringify(body)
      for (const [path, replacement] of [[process.env.RELAY_CAPTURE_DIRECTORY || process.cwd(), '{{RELAY_WORKSPACE}}'], [process.env.HOME, '{{RELAY_HOME}}']])
        if (path) template = template.replaceAll(path, replacement)
      body = JSON.parse(template)
      const headers = Object.fromEntries([...request.headers].filter(([name]) =>
        ['content-type', 'accept', 'user-agent', 'x-opencode-client'].includes(name)))
      writeFileSync(process.env.RELAY_ENVELOPE_OUTPUT,
        JSON.stringify({ version: ctx.app.version, url: request.url, headers, body }), { mode: 0o600 })
      throw new Error('RELAY_CAPTURE_COMPLETE_NO_NETWORK')
    }, { providerID: 'opencode' })
  },
}
