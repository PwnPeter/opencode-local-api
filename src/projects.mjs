import { createHash, createHmac, randomBytes } from 'node:crypto'
import { chmodSync, closeSync, constants, fchmodSync, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { isIP } from 'node:net'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fetchIpv4 } from './http.mjs'
import { canonicalIP, createIPOwnership } from './ownership.mjs'

export class IPOwnershipError extends Error {
  constructor() { super('Exit IP is reserved for another key or retired'); this.name = 'IPOwnershipError' }
}

export class ProxyExitError extends Error {
  constructor(message = 'Unable to verify proxy exit IP') { super(message); this.name = 'ProxyExitError' }
}

export function projectStoreFile(env = process.env) {
  return join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'opencode-local-api', 'projects.jsonl')
}

function readRegistry(raw) {
  const invalid = () => new Error('Invalid project registry; existing file preserved')
  if (raw && !raw.endsWith('\n')) throw invalid()
  const bindings = new Map(), owners = new Map(), ips = new Set()
  for (const line of raw.split('\n').filter(line => line.trim())) {
    let row
    try { row = JSON.parse(line) } catch { throw invalid() }
    if (!row || typeof row.key_fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(row.key_fingerprint) ||
        typeof row.public_ip !== 'string' || !isIP(row.public_ip) || typeof row.x_opencode_project !== 'string' ||
        !/^[a-f0-9]{40}$/.test(row.x_opencode_project)) throw invalid()
    const ip = canonicalIP(row.public_ip)
    const binding = JSON.stringify([row.key_fingerprint, ip])
    if ((bindings.has(binding) && bindings.get(binding) !== row.x_opencode_project) ||
        (owners.has(row.x_opencode_project) && owners.get(row.x_opencode_project) !== binding)) throw invalid()
    bindings.set(binding, row.x_opencode_project)
    owners.set(row.x_opencode_project, binding)
    ips.add(ip)
  }
  return { bindings, owners, ips }
}

export function createProjectStore(file, fetchRequest = fetchIpv4, legacyIPs = []) {
  const verifiedIPs = new Map()
  function remember(project, ip) {
    if (verifiedIPs.size >= 512) verifiedIPs.delete(verifiedIPs.keys().next().value)
    verifiedIPs.set(project, ip)
    return project
  }
  function openRegistry() {
    const fd = openSync(file, constants.O_CREAT | constants.O_APPEND | constants.O_RDWR | constants.O_NOFOLLOW, 0o600)
    try {
      if (!fstatSync(fd).isFile()) throw new Error('Project registry must be a regular file')
      fchmodSync(fd, 0o600)
      return fd
    } catch (error) { closeSync(fd); throw error }
  }
  let recordedIPs = []
  if (file) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    chmodSync(dirname(file), 0o700)
    closeSync(openRegistry())
    recordedIPs = [...readRegistry(readFileSync(file, 'utf8')).ips]
  }
  const ownership = createIPOwnership(file ? join(dirname(file), 'ip-owners.sqlite') : undefined, [...legacyIPs, ...recordedIPs])
  const getProject = async (key, ip, signal, proxy) => {
    signal?.throwIfAborted()
    if (typeof key !== 'string' || !key) throw new Error('Project assignment requires an API key')
    const expected = ip === undefined ? undefined : canonicalIP(ip)
    if (!file && expected === undefined) return randomBytes(20).toString('hex')
    if (file && (proxy || expected === undefined)) {
      try {
        const response = await fetchRequest('https://api.ipify.org?format=json', {
          method: 'GET', signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(8000)]),
          ...(proxy ? { proxy } : {}),
        })
        if (!response.ok) { await response.body?.cancel(); throw new Error('Unable to verify public IP') }
        const observed = (await response.json()).ip
        if (typeof observed !== 'string' || !isIP(observed)) throw new Error('Unable to verify public IP')
        ip = canonicalIP(observed)
        if (proxy && expected !== ip) throw new ProxyExitError('Proxy exit IP changed; credentials were not sent')
      } catch (error) {
        if (signal?.aborted) throw signal.reason
        if (proxy) throw error instanceof ProxyExitError ? error : new ProxyExitError()
        throw error
      }
    } else {
      ip = expected
    }
    signal?.throwIfAborted()
    if (typeof ip !== 'string' || !isIP(ip)) throw new Error('Project assignment requires a verified public IP')
    const fingerprint = createHash('sha256').update(key).digest('hex')
    const owner = JSON.stringify([fingerprint, ip])
    const project = createHmac('sha256', key).update(`opencode-local-project:${ip}`).digest('hex').slice(0, 40)
    if (!file) {
      if (!ownership.claim(key, ip)) throw new IPOwnershipError()
      return remember(project, ip)
    }
    const fd = openRegistry()
    try {
      const { bindings, owners } = readRegistry(readFileSync(fd, 'utf8'))
      // shortcut: reread the small registry per lookup; index it if measured lookup cost becomes significant.
      if (!ownership.claim(key, ip)) throw new IPOwnershipError()
      if (bindings.has(owner)) return remember(bindings.get(owner), ip)
      if (owners.has(project)) throw new Error('Invalid project registry; existing file preserved')
      // Append one deterministic record so concurrent writers neither overwrite history nor assign conflicting IDs.
      writeFileSync(fd, JSON.stringify({ key_fingerprint: fingerprint, public_ip: ip, x_opencode_project: project }) + '\n')
      fsyncSync(fd)
      return remember(project, ip)
    } finally { closeSync(fd) }
  }
  return Object.assign(getProject, { canUse: ownership.canUse, reserve: ownership.claim, excluded: ownership.excluded,
    retire: ownership.retire, close: ownership.close, persistent: Boolean(file), ipFor: project => verifiedIPs.get(project) || null })
}
