import { ApiRequestError } from '../api/client'
/** Retry resumable, deterministic import RPCs while the independent code index
 * catches up. Claims and creation never use this helper. */
export async function retryImport<T>(
  work: () => Promise<T>,
  signal: AbortSignal,
  log: (message: string) => void,
) {
  const until = Date.now() + 300000
  for (let attempt = 0; ; attempt++) {
    if (signal.aborted) throw Error('Import cancelled')
    try {
      return await work()
    } catch (error) {
      if (
        !(error instanceof ApiRequestError) ||
        !(
          [429, 500, 502, 503, 504].includes(error.status) ||
          (error.status === 409 &&
            error.message.includes('batch already running'))
        ) ||
        Date.now() >= until
      )
        throw error
      if (attempt === 0) log('Waiting for repository indexing or API capacity')
      await new Promise<void>((resolve, reject) => {
        const stopped = () => {
          clearTimeout(timer)
          reject(Error('Import cancelled'))
        }
        const timer = setTimeout(
          () => {
            signal.removeEventListener('abort', stopped)
            resolve()
          },
          Math.min(5000, 1000 * (attempt + 1)),
        )
        signal.addEventListener('abort', stopped, { once: true })
      })
    }
  }
}
