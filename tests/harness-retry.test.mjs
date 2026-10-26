import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import { createHandler } from '../src/relay.mjs'

test('Harness retries quota beyond five failures through the local relay without ending or changing the conversation',
  { skip: !process.env.DSH_BIN && 'Set DSH_BIN to an installed Harness executable', timeout: 180000 }, async t => {
    const dsh = realpathSync(process.env.DSH_BIN)
    const YAML = createRequire(dsh)('yaml')
    const directory = mkdtempSync(join(tmpdir(), 'harness-continuous-retry-'))
    t.after(() => rmSync(directory, { recursive: true, force: true }))
    const home = join(directory, 'dsh')
    mkdirSync(home)
    const conversations = []
    const handle = createHandler({ token: 'fixture-client-token', complete: async body => {
      conversations.push(JSON.stringify(body.messages.filter(message => !['system', 'developer'].includes(message.role))))
      if (conversations.length <= 7) return Response.json({ error: {
        type: 'FreeUsageLimitError', message: 'Request quota exhausted.' },
      }, { status: 429, headers: { 'Retry-After': '1' } })
      const chunk = { id: 'fixture-recovered', object: 'chat.completion.chunk', created: 1,
        model: 'deepseek-v4.1-flash-free', choices: [{ index: 0,
          delta: { role: 'assistant', content: 'CONTINUOUS_RETRY_OK' }, finish_reason: 'stop' }] }
      return new Response('data: ' + JSON.stringify(chunk) + '\n\ndata: [DONE]\n\n',
        { headers: { 'Content-Type': 'text/event-stream' } })
    } })
    const server = createServer(async (request, response) => {
      try {
        const result = await handle(new Request(`http://127.0.0.1${request.url}`, {
          method: request.method, headers: request.headers, body: Readable.toWeb(request), duplex: 'half',
        }))
        response.writeHead(result.status, Object.fromEntries(result.headers))
        Readable.fromWeb(result.body).pipe(response)
      } catch { response.writeHead(500).end() }
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }))
    const patches = YAML.parse(readFileSync(new URL('../config/dsh.patch.yml', import.meta.url), 'utf8'))
    patches.find(row => row.id === 'llm-pi-ai').config.providers.opencode.baseURL = `http://127.0.0.1:${server.address().port}/v1`
    patches.push({ id: 'session-title-llm', disabled: true })
    const patch = join(directory, 'relay.patch.yml')
    writeFileSync(patch, YAML.stringify(patches))
    const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => ['PATH', 'HOME', 'USER', 'LANG', 'TZ'].includes(name)))
    Object.assign(environment, { DSH_HOME: home, OPENCODE_LOCAL_API_KEY: 'fixture-client-token' })
    const child = spawn(dsh, ['headless', '--patch', patch, 'Reply exactly CONTINUOUS_RETRY_OK. Do not call tools.'],
      { env: environment, cwd: directory, stdio: ['ignore', 'pipe', 'pipe'] })
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') })
    let output = '', diagnostics = ''
    child.stdout.on('data', data => { output += data })
    child.stderr.on('data', data => { diagnostics += data })
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
    assert.equal(code, 0, diagnostics.slice(-2000))
    assert.equal(output.trim(), 'CONTINUOUS_RETRY_OK')
    assert.equal(conversations.length, 8)
    assert.equal(new Set(conversations).size, 1, 'Retries must preserve the original conversation')
    const sessionFiles = readdirSync(join(home, 'sessions'), { recursive: true })
      .filter(file => file.endsWith('.jsonl.zstd'))
    const events = sessionFiles.flatMap(file => execFileSync('zstd', ['-qdc', join(home, 'sessions', file)], { encoding: 'utf8' })
      .trim().split('\n').map(JSON.parse))
    const retries = events.filter(event => event.type === 'llm/retry' && event.data.provider === 'opencode')
    assert.equal(retries.length, 7)
    assert.ok(retries.every(event => event.data.failure.code === 'QUOTA'))
    assert.equal(new Set(retries.map(event => event.data.turn)).size, 1)
    assert.equal(events.filter(event => event.type === 'turn/end').length, 1, 'The turn must end only after recovery')
  })
