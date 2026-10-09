import { spawn } from 'node:child_process'
import { constants } from 'node:os'

export function agentEnvironment() {
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(process.env)) {
    if (
      value === undefined ||
      /^(CLAUDECODE|CLAUDE_PID|CLAUDE_CODE_CHILD_SESSION|CLAUDE_CODE_SESSION_ID|CLAUDE_CODE_PARENT_SESSION_ID|CLAUDE_CODE_BRIDGE_SESSION_ID|CLAUDE_CODE_MESSAGING_SOCKET|CLAUDE_CODE_MESSAGING_TOKEN|CLAUDE_CODE_SESSION_ATTENDED|CLAUDE_CODE_ENTRYPOINT|CODEX_SESSION_ID|CODEX_THREAD_ID)$/.test(
        name,
      )
    )
      continue
    env[name] = value
  }
  return env
}
export function debugFallback(reason: unknown) {
  if (process.env.GILD_DEBUG)
    console.error(`gild spawn: native fallback: ${String(reason)}`)
}
export function supportsPty(platform = process.platform) {
  return platform !== 'win32'
}
/** The child shares the foreground process group: terminal SIGINT already reaches it. */
export async function runNative(
  binary: string,
  args: string[],
  cwd = process.cwd(),
  env = agentEnvironment(),
) {
  const child = spawn(binary, args, { stdio: 'inherit', cwd, env })
  const interrupt = () => {}
  process.on('SIGINT', interrupt)
  const signals: NodeJS.Signals[] = ['SIGTERM', 'SIGHUP']
  const handlers = signals.map((signal) => () => child.kill(signal))
  signals.forEach((signal, i) => process.on(signal, handlers[i]))
  try {
    return await new Promise<number>((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', (code, signal) =>
        resolve(code ?? 128 + (signal ? constants.signals[signal] : 0)),
      )
    })
  } finally {
    process.off('SIGINT', interrupt)
    signals.forEach((signal, i) => process.off(signal, handlers[i]))
  }
}
