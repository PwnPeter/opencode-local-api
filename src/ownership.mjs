import { createHash } from 'node:crypto'
import { closeSync, constants, fchmodSync, fstatSync, mkdirSync, openSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { canonicalIP } from './ip.mjs'
export { canonicalIP } from './ip.mjs'

function fingerprint(key) {
  if (typeof key !== 'string' || !key) throw new Error('An API key is required for IP ownership')
  return createHash('sha256').update(key).digest('hex')
}

export function createIPOwnership(file, legacyIPs = []) {
  if (file) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    const fd = openSync(file, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600)
    try {
      if (!fstatSync(fd).isFile()) throw new Error('IP ownership storage must be a regular file')
      fchmodSync(fd, 0o600)
    } finally { closeSync(fd) }
  }
  const db = new DatabaseSync(file || ':memory:')
  db.exec('PRAGMA busy_timeout=5000')
  let find, insert, retire
  db.exec('BEGIN IMMEDIATE')
  try {
    db.exec('CREATE TABLE IF NOT EXISTS ip_ownership (public_ip TEXT PRIMARY KEY, key_fingerprint TEXT)')
    find = db.prepare('SELECT key_fingerprint FROM ip_ownership WHERE public_ip = ?')
    insert = db.prepare('INSERT OR IGNORE INTO ip_ownership (public_ip, key_fingerprint) VALUES (?, ?)')
    retire = db.prepare('INSERT INTO ip_ownership (public_ip, key_fingerprint) VALUES (?, NULL) ON CONFLICT(public_ip) DO UPDATE SET key_fingerprint = NULL')
    const version = db.prepare('PRAGMA user_version').get().user_version
    if (version > 1) throw new Error('Unsupported IP ownership storage version')
    if (!version) {
      for (const ip of legacyIPs) retire.run(canonicalIP(ip))
      db.exec('PRAGMA user_version=1')
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    db.close()
    throw error
  }
  return {
    canUse(key, ip) {
      const owner = fingerprint(key)
      const row = find.get(canonicalIP(ip))
      return !row || row.key_fingerprint === owner
    },
    claim(key, ip) {
      const address = canonicalIP(ip), owner = fingerprint(key)
      insert.run(address, owner)
      return find.get(address)?.key_fingerprint === owner
    },
    excluded: () => db.prepare('SELECT public_ip FROM ip_ownership ORDER BY public_ip').all().map(row => row.public_ip),
    retire(ips) {
      db.exec('BEGIN IMMEDIATE')
      try {
        for (const ip of ips) retire.run(canonicalIP(ip))
        db.exec('COMMIT')
      } catch (error) { db.exec('ROLLBACK'); throw error }
    },
    close: () => db.close(),
  }
}
