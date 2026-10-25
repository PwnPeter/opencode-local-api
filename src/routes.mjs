import { spawnSync } from 'node:child_process'
import { isIP } from 'node:net'
import { fileURLToPath } from 'node:url'

export function routeConfig(route) {
  if (!route || !/^[a-f0-9]{64}$/.test(route.key_fingerprint || '') || Boolean(route.proxy) === Boolean(route.interface))
    throw new Error('Invalid pinned route')
  const result = { key_fingerprint: route.key_fingerprint }
  if (route.name !== undefined) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(route.name)) throw new Error('Invalid route name')
    result.name = route.name
  }
  if (route.proxy) {
    if (typeof route.proxy.url !== 'string' || /[\0\r\n]/.test(route.proxy.url) || isIP(route.proxy.ip || '') !== 4 ||
        !['http:', 'https:', 'socks5:', 'socks5h:'].includes(new URL(route.proxy.url).protocol))
      throw new Error('Invalid pinned proxy')
    result.proxy = { url: route.proxy.url, ip: route.proxy.ip }
  } else {
    if (!/^[A-Za-z0-9_.:-]{1,15}$/.test(route.interface) || !/^[a-f0-9-]{36}$/.test(route.connection_uuid || ''))
      throw new Error('Invalid pinned interface')
    result.interface = route.interface
    result.connection_uuid = route.connection_uuid
  }
  return result
}

export function routeIdentity(route) {
  const value = routeConfig(route)
  return JSON.stringify([value.key_fingerprint, value.proxy ? ['proxy', value.proxy.url, value.proxy.ip]
    : ['interface', value.interface, value.connection_uuid]])
}

export function writeRoute(file, route, expected) {
  const content = JSON.stringify(routeConfig(route), null, 2) + '\n'
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => ['PATH', 'LANG', 'LC_ALL'].includes(name)))
  const result = spawnSync('python3', [fileURLToPath(new URL('../scripts/write_route.py', import.meta.url))], {
    input: JSON.stringify({ file, content, expected }), encoding: 'utf8', env, timeout: 10000,
  })
  if (result.status !== 0) throw new Error('Unable to publish selected route')
  return result.stdout.trim() === 'committed'
}

export function chooseRoute(routes, results, current, productionFingerprints = null) {
  const verified = routes.filter(route => (!productionFingerprints || productionFingerprints.has(route.key_fingerprint)) &&
    results.some(result => result.name === route.name && result.status === 200 &&
    result.stream_complete === true && result.expected_text === true))
  return verified.find(route => routeIdentity(route) === routeIdentity(current)) || verified[0] || null
}
