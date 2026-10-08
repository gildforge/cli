import { lookup } from 'node:dns/promises'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { Readable } from 'node:stream'
import { isIP } from 'node:net'
import { publicAddress } from '../public-address'
/** Source REST stays on validated public addresses, including DNS rebinding.
 * No redirects or forge-supplied pagination destinations are followed. */
export const publicFetch = async (
  input: RequestInfo | URL,
  init?: RequestInit,
) => {
  const url = new URL(
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : input.url,
  )
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw Error('Invalid source API URL')
  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  const answers = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) }]
    : await lookup(hostname, { all: true })
  if (!answers.length || answers.some((a) => !publicAddress(a.address)))
    throw Error('Source API DNS must resolve exclusively to public addresses')
  const address = answers.find((a) => a.family === 4) ?? answers[0]
  return new Promise<Response>((resolve, reject) => {
    const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
      url,
      {
        method: 'GET',
        headers: Object.fromEntries(new Headers(init?.headers)),
        signal: init?.signal ?? undefined,
        lookup: (_host, options, callback) => {
          if (options.all) callback(null, [address])
          else callback(null, address.address, address.family)
        },
      },
      (response) => {
        const headers = new Headers()
        for (const [key, value] of Object.entries(response.headers))
          if (value !== undefined)
            headers.set(key, Array.isArray(value) ? value.join(', ') : value)
        const status = response.statusCode ?? 500
        resolve(
          new Response(
            [204, 304].includes(status)
              ? null
              : (Readable.toWeb(response) as unknown as BodyInit),
            { status, headers },
          ),
        )
      },
    )
    req.on('error', () =>
      reject(Error('Source API transfer failed; check access and retry')),
    )
    req.end()
  })
}
