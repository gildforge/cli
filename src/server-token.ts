import { z } from 'zod'

export function forgeServer(value: string) {
  const url = new URL(value)
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  )
    throw Error(
      '--server must be a forge origin, without credentials or a path',
    )
  if (
    url.protocol !== 'https:' &&
    !(
      url.protocol === 'http:' &&
      ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    )
  )
    throw Error('forge server requires HTTPS (or localhost for development)')
  return url.origin
}

const boundToken = z.object({
  server: z.string().transform(forgeServer),
  token: z.string(),
})
export type ServerToken = z.infer<typeof boundToken>
// Legacy tokens have no trustworthy issuer. Discard them and prove the key again.
export const serverTokenSchema = z
  .union([boundToken, z.string().transform(() => null)])
  .nullable()
  .default(null)
export function tokenForServer(
  cached: ServerToken | null | undefined,
  server: string,
) {
  if (!cached || cached.server !== forgeServer(server))
    throw Error(
      'Run gild auth token --server ' +
        forgeServer(server) +
        ' first: no token minted for this server',
    )
  return cached.token
}
