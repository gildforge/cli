import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
/** Only metadata reads use this credential. Never serialize it into a job. */
export async function githubReadToken(
  anonymous = false,
  env = process.env,
  run: () => Promise<string> = async () =>
    (
      await promisify(execFile)('gh', ['auth', 'token'], {
        timeout: 10000,
        maxBuffer: 65536,
      })
    ).stdout,
) {
  if (anonymous) return undefined
  return (
    env.GH_TOKEN?.trim() ||
    env.GITHUB_TOKEN?.trim() ||
    (await run()
      .then((s) => s.trim() || undefined)
      .catch(() => undefined))
  )
}
