import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { isIP } from 'node:net'
import { dirname, join } from 'node:path'
import { createAttemptLogger } from '../src/audit.mjs'
import { createPreferredTransport } from '../src/preferred.mjs'
import { createProjectStore, projectStoreFile } from '../src/projects.mjs'
import { apiKeysFromEnv } from '../src/transport.mjs'
import { chooseRoute, routeConfig, routeIdentity, writeRoute } from '../src/routes.mjs'

async function main() {
  const plan = JSON.parse(readFileSync(process.argv[2], 'utf8'))
  const productionKeys = [...new Set(apiKeysFromEnv().filter(Boolean))]
  const keys = [...productionKeys]
  for (const file of plan.extra_key_files || []) if (existsSync(file)) {
    const key = readFileSync(file, 'utf8').trim()
    if (!key || /[\0\r\n]/.test(key)) throw new Error('Invalid additional key file')
    if (!keys.includes(key)) keys.push(key)
  }
  const fingerprint = key => createHash('sha256').update(key).digest('hex')
  const productionFingerprints = new Set(productionKeys.map(fingerprint))
  if (!Array.isArray(plan.routes) || !plan.routes.length || plan.routes.length > 8 ||
      typeof plan.output_directory !== 'string' || !plan.output_directory ||
      new Set(plan.routes.map(route => route.name)).size !== plan.routes.length) throw new Error('Invalid retest plan')
  for (const route of plan.routes) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(route.name) || !/^[a-f0-9]{64}$/.test(route.key_fingerprint) ||
        Boolean(route.proxy) === Boolean(route.interface)) throw new Error('Invalid retest route')
    if (route.proxy && (isIP(route.proxy.ip || '') !== 4 ||
        !['http:', 'https:', 'socks5:', 'socks5h:'].includes(new URL(route.proxy.url).protocol)))
      throw new Error('Invalid retest proxy')
    if (route.interface && (!/^[A-Za-z0-9_.:-]{1,15}$/.test(route.interface) || !/^[a-f0-9-]{36}$/.test(route.connection_uuid || '')))
      throw new Error('Invalid retest interface')
  }
  const selecting = process.argv.includes('--select')
  const selectionFile = selecting ? process.env.RELAY_PINNED_ROUTE_FILE : null
  if (selecting && !selectionFile) throw new Error('Automatic selection requires a production route file')
  const selectionSnapshot = selecting ? readFileSync(selectionFile, 'utf8') : null
  const current = selecting ? routeConfig(JSON.parse(selectionSnapshot)) : null
  const routes = [...plan.routes]
  if (selecting && !routes.some(route => routeIdentity(route) === routeIdentity(current)))
    throw new Error('The active production route must be listed in the automatic plan')
  if (selecting) routes.sort((a, b) => Number(routeIdentity(b) === routeIdentity(current)) - Number(routeIdentity(a) === routeIdentity(current)))
  if (process.argv.includes('--check')) {
    if (plan.routes.some(route => !keys.some(key => fingerprint(key) === route.key_fingerprint))) throw new Error('Missing retest key')
    console.log(JSON.stringify({ routes: routes.length, configured_keys: keys.length, offline_check: true, automatic_selection: selecting }))
    return
  }
  const run = new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8)
  const directory = join(plan.output_directory, run)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const config = dirname(projectStoreFile())
  const envelope = JSON.parse(readFileSync(process.env.RELAY_ENVELOPE_FILE || join(config, 'envelope.json'), 'utf8'))
  const projects = createProjectStore(projectStoreFile())
  const audit = createAttemptLogger(keys)
  const results = []
  let selected = null, changed = false, selectionChangedExternally = false
  try {
    for (const route of routes) {
      const key = keys.find(value => fingerprint(value) === route.key_fingerprint)
      const requestID = 'retest-' + run + '-' + route.name
      const started = Date.now()
      let complete, publicIP = null, result
      const record = async entry => { if (entry.public_ip) publicIP = entry.public_ip; await audit(entry) }
      try {
        if (!key) throw Object.assign(new Error('Missing retest key'), { name: 'RetestKeyUnavailable' })
        let env
        if (route.proxy) {
          const file = join(directory, route.name + '-route.json')
          writeFileSync(file, JSON.stringify({ key_fingerprint: route.key_fingerprint, proxy: route.proxy }) + '\n', { mode: 0o600 })
          env = { RELAY_PINNED_ROUTE_FILE: file }
        } else env = { RELAY_PINNED_ROUTE_FILE: '', RELAY_PREFERRED_INTERFACE: route.interface,
          RELAY_PREFERRED_CONNECTION_UUID: route.connection_uuid, RELAY_PREFERRED_KEY_FINGERPRINT: route.key_fingerprint,
          RELAY_PREFERRED_REQUIRED: '1' }
        complete = await createPreferredTransport(envelope, keys, async () => { throw new Error('Retest fallback refused') },
          projects, env, undefined, record)
        const response = await complete({ model: 'deepseek-v4.1-flash-free', thinking: { type: 'disabled' }, max_tokens: 128,
          messages: [{ role: 'user', content: 'Reply exactly SCHEDULED_RETEST_OK. Do not call tools.' }], stream: false },
          AbortSignal.timeout(35000), undefined, { request_id: requestID, source: 'probe' })
        const data = await response.json().catch(() => null)
        const type = data?.error?.type
        result = { status: response.status, quota_reached: type === 'FreeUsageLimitError' ? true : response.ok ? false : null,
          error_type: typeof type === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(type) && !keys.some(key => type.includes(key)) ? type : null,
          retry_after: response.headers.get('retry-after'),
          stream_complete: response.ok && data?.choices?.[0]?.finish_reason != null,
          expected_text: response.ok && data?.choices?.[0]?.message?.content?.includes('SCHEDULED_RETEST_OK') === true }
      } catch (error) { result = { status: null, quota_reached: null, error_type: error.name, stream_complete: false } }
      finally { await complete?.close?.() }
      const entry = { name: route.name, request_id: requestID, timestamp: new Date(started).toISOString(),
        key_number: key ? keys.indexOf(key) + 1 : null, public_ip: publicIP, proxy_used: Boolean(route.proxy),
        eligible_for_production: productionFingerprints.has(route.key_fingerprint),
        seconds: (Date.now() - started) / 1000, ...result }
      results.push(entry)
      await audit({ request_id: requestID, key, public_ip: publicIP, proxy_url: route.proxy?.url || null,
        interface: route.interface, connection_uuid: route.connection_uuid, source: 'probe', phase: 'retest_result', started_at: started, ...result })
      if (selecting && !selected) {
        const candidate = chooseRoute(routes, results, current, productionFingerprints)
        if (candidate) {
          selected = routeConfig(candidate)
          if (routeIdentity(selected) !== routeIdentity(current)) {
            changed = writeRoute(selectionFile, selected, selectionSnapshot)
            selectionChangedExternally = !changed
          }
        }
      }
      writeFileSync(join(directory, 'results.json'), JSON.stringify({ run, results, selected, changed,
        selection_changed_externally: selectionChangedExternally }, null, 2) + '\n', { mode: 0o600 })
      console.log(JSON.stringify(entry))
    }
  } finally { projects.close() }
  console.log('Retest report: ' + join(directory, 'results.json'))
}

main().catch(() => { console.error('Retest configuration or storage unavailable'); process.exitCode = 1 })
