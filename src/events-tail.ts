import { ApiRequestError, type GildClient } from './api/client'

export function waitForEvents(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', finish)
      resolve()
    }
    const timer = setTimeout(finish, ms)
    signal.addEventListener('abort', finish, { once: true })
    if (signal.aborted) finish()
  })
}
export async function tailEvents(
  client: Pick<GildClient, 'request'>,
  opts: { repo?: string; since?: string; once?: boolean; raw?: boolean },
  signal: AbortSignal,
  output: (line: string) => void = console.log,
  cursorOutput: (line: string) => void = console.error,
  pause: typeof waitForEvents = waitForEvents,
) {
  let since = opts.since,
    backoff = 500
  while (!signal.aborted) {
    try {
      const page = await client.request(
        'events',
        {},
        undefined,
        { repos: opts.repo, since, wait: opts.once ? 0 : 20000 },
        { signal },
      )
      for (const event of page.events)
        output(
          JSON.stringify(
            !opts.raw && event.event === 'agent_request'
              ? { ...event, payload: {} }
              : event,
          ),
        )
      since = page.cursor
      if (opts.once) {
        cursorOutput('cursor: ' + since)
        return
      }
      if (page.events.length) {
        backoff = 500
        continue
      }
    } catch (error) {
      if (signal.aborted) return
      if (!(
        error instanceof TypeError ||
        (error instanceof ApiRequestError &&
          (error.status >= 500 || error.status === 429 || error.status === 408))
      ))
        throw error
    }
    await pause(backoff, signal)
    backoff = Math.min(backoff * 2, 10000)
  }
}
