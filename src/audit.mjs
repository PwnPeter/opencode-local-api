import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, constants, fchmodSync, fstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { isIP } from 'node:net'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { projectStoreFile } from './projects.mjs'

const exec = promisify(execFile)
const paris = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Paris', dateStyle: 'short', timeStyle: 'medium' })

async function networkFor(entry, labels) {
  let device = entry.interface || null, connection = entry.connection_uuid || null
  const bound = Boolean(device)
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => ['PATH', 'LANG', 'LC_ALL'].includes(name)))
  try {
    if (!device) {
      const host = entry.proxy_url ? new URL(entry.proxy_url).hostname : ''
      const target = isIP(host) === 4 && !host.startsWith('127.') ? host : '1.1.1.1'
      const { stdout } = await exec('ip', ['-j', '-4', 'route', 'get', target], { env, timeout: 1000 })
      device = JSON.parse(stdout)[0]?.dev || null
    }
    if (device && !connection) {
      const { stdout } = await exec('nmcli', ['-g', 'GENERAL.CON-UUID', 'device', 'show', device], { env, timeout: 1000 })
      connection = stdout.trim() || null
    }
  } catch {}
  const label = labels[connection] || {}
  return { interface: device, connection_uuid: connection,
    network_evidence: bound ? (isIP(entry.public_ip || '') ? 'bound_interface' : 'configured_interface') : 'route_snapshot',
    usb_4g: typeof label.usb_4g === 'boolean' ? label.usb_4g : null,
    mobile_data: typeof label.mobile_data === 'boolean' ? label.mobile_data : null }
}

export function createAttemptLogger(keys, file = join(dirname(projectStoreFile()), 'attempts.jsonl')) {
  const known = [...new Set(keys.filter(Boolean))]
  let labels = {}
  try { labels = JSON.parse(readFileSync(join(dirname(file), 'network-labels.json'), 'utf8')) }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  if (!labels || typeof labels !== 'object' || Array.isArray(labels)) throw new Error('Invalid network labels')
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  function open() {
    const fd = openSync(file, constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600)
    try {
      if (!fstatSync(fd).isFile()) throw new Error('Attempt log must be a regular file')
      fchmodSync(fd, 0o600)
      return fd
    } catch (error) { closeSync(fd); throw error }
  }
  closeSync(open())
  const safe = (value, length = 128) => typeof value === 'string' && value.length <= length &&
    !/[\x00-\x1f]/.test(value) && !known.some(key => value.includes(key)) ? value : null
  const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null
  return async entry => {
    try {
      const now = new Date()
      let proxy = null
      if (entry.proxy_url) { const url = new URL(entry.proxy_url); proxy = safe(url.protocol + '//' + url.host) }
      const retry = safe(entry.retry_after)
      const retryTime = retry && /^\d+$/.test(retry) ? now.getTime() + Number(retry) * 1000 : Date.parse(retry)
      const snapshot = entry.network_snapshot
      const network = snapshot && typeof snapshot === 'object' ? {
        interface: safe(snapshot.interface), connection_uuid: safe(snapshot.connection_uuid),
        network_evidence: ['bound_interface', 'configured_interface', 'route_snapshot'].includes(snapshot.network_evidence) ? snapshot.network_evidence : null,
        usb_4g: typeof snapshot.usb_4g === 'boolean' ? snapshot.usb_4g : null,
        mobile_data: typeof snapshot.mobile_data === 'boolean' ? snapshot.mobile_data : null,
      } : await networkFor(entry, labels)
      const row = {
        timestamp: now.toISOString(), time_paris: paris.format(now) + ' Europe/Paris',
        started_at: new Date(entry.started_at ?? now.getTime()).toISOString(),
        duration_ms: Math.max(0, now.getTime() - (entry.started_at ?? now.getTime())),
        request_id: safe(entry.request_id), phase: safe(entry.phase), model: safe(entry.model),
        source: ['relay', 'probe', 'verification'].includes(entry.source) ? entry.source : null,
        key_number: known.indexOf(entry.key) < 0 ? null : known.indexOf(entry.key) + 1,
        key_id: typeof entry.key === 'string' ? createHash('sha256').update(entry.key).digest('hex').slice(0, 12) : null,
        public_ip: isIP(entry.public_ip || '') ? entry.public_ip : null,
        expected_public_ip: isIP(entry.expected_public_ip || '') ? entry.expected_public_ip : null,
        proxy_used: Boolean(entry.proxy_url), proxy_url: proxy,
        ...network,
        status: Number.isInteger(entry.status) ? entry.status : null,
        quota_reached: typeof entry.quota_reached === 'boolean' ? entry.quota_reached : null,
        error_type: safe(entry.error_type, 80), retry_after: retry,
        retry_at: Number.isFinite(retryTime) && Math.abs(retryTime) <= 8.64e15 ? new Date(retryTime).toISOString() : null,
        stream_complete: typeof entry.stream_complete === 'boolean' ? entry.stream_complete : null,
        usage: entry.usage && typeof entry.usage === 'object' && !Array.isArray(entry.usage) ? {
          prompt_tokens: count(entry.usage.prompt_tokens), completion_tokens: count(entry.usage.completion_tokens),
          total_tokens: count(entry.usage.total_tokens),
          cached_tokens: count(entry.usage.prompt_tokens_details?.cached_tokens ?? entry.usage.opencode?.tokens?.cache_read),
          reasoning_tokens: count(entry.usage.completion_tokens_details?.reasoning_tokens ?? entry.usage.opencode?.tokens?.reasoning),
        } : null,
      }
      const fd = open()
      try { writeFileSync(fd, JSON.stringify(row) + '\n') } finally { closeSync(fd) }
      return network
    } catch { console.error('Attempt audit write failed; request handling continues') }
  }
}
