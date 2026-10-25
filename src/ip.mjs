import { isIP } from 'node:net'

export function canonicalIP(value) {
  if (typeof value !== 'string' || !isIP(value)) throw new Error('A valid exit IP is required')
  if (isIP(value) === 4) return value
  const normalized = new URL('http://[' + value + ']/').hostname.slice(1, -1)
  const mapped = normalized.match(/^::ffff:([a-f0-9]{1,4}):([a-f0-9]{1,4})$/)
  if (!mapped) return normalized
  const address = parseInt(mapped[1], 16) * 65536 + parseInt(mapped[2], 16)
  return [24, 16, 8, 0].map(bits => (address >>> bits) & 255).join('.')
}
