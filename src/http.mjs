import { lookup } from 'node:dns'
import https from 'node:https'
import { Readable } from 'node:stream'

export function fetchIpv4(url, { method, headers, body, signal }) {
  return new Promise((resolve, reject) => {
    const request = https.request(url, {
      method, signal, family: 4, headers: { ...Object.fromEntries(new Headers(headers)), 'accept-encoding': 'identity' },
      // Bun's HTTPS client needs an explicit lookup to enforce the address family.
      lookup: (host, options, callback) => lookup(host, { ...options, family: 4 }, callback),
    }, response => {
      try {
        if ([301, 302, 303, 307, 308].includes(response.statusCode)) throw new Error('Upstream redirects are not allowed')
        const encoding = response.headers['content-encoding']
        if (encoding && encoding !== 'identity') throw new Error('Unexpected upstream content encoding')
        const empty = [204, 205, 304].includes(response.statusCode)
        if (empty) response.resume()
        resolve(new Response(empty ? null : Readable.toWeb(response), { status: response.statusCode, headers: response.headers }))
      } catch (error) {
        response.destroy()
        reject(error)
      }
    })
    request.on('error', reject)
    request.end(body)
  })
}
