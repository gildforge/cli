import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
/** Cache list pages for this import attempt. Finished items never need another
 * source read on resume. No headers or credentials are written to disk. */
type SourceFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>
export async function snapshotFetch(
  directory: string,
  resume: boolean,
  fetcher: SourceFetch,
): Promise<SourceFetch> {
  if (!resume) await rm(directory, { recursive: true, force: true })
  await mkdir(directory, { recursive: true, mode: 0o700 })
  return async (input, init) => {
    const url = new URL(String(input))
    if (!url.searchParams.has('per_page')) return fetcher(input, init)
    const file = join(
      directory,
      createHash('sha256').update(url.href).digest('hex') + '.json',
    )
    const saved = await readFile(file, 'utf8').catch(() => null)
    if (saved !== null)
      return new Response(saved, {
        headers: { 'content-type': 'application/json' },
      })
    const response = await fetcher(input, init)
    if (response.ok) {
      const text = await response.clone().text()
      // Validate before persisting a successful page. Tokens and headers are excluded.
      if (!Array.isArray(JSON.parse(text)))
        throw Error('Source API list is not an array')
      await writeFile(file + '.pending', text, { mode: 0o600 })
      await rename(file + '.pending', file)
    }
    return response
  }
}
