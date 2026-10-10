import { execFile } from 'node:child_process'
import { hostname } from 'node:os'
import { promisify } from 'node:util'
import { basename } from 'node:path'
import { runtimeReport } from './api/agent-profile-contract'
import { redact } from './session-redaction'
export function launchSettings(
  args: string[],
  defaults: { model?: string; effort?: string } = {},
) {
  const settings = { ...defaults }
  for (let i = 0; i < args.length && args[i] !== '--'; i++) {
    const arg = args[i]!
    if (arg === '--model' || arg === '-m') settings.model = args[++i]
    else if (arg.startsWith('--model=')) settings.model = arg.slice(8)
    else if (arg === '--effort') settings.effort = args[++i]
    else if (arg.startsWith('--effort=')) settings.effort = arg.slice(9)
    else if (
      arg === '-c' ||
      arg === '--config' ||
      arg.startsWith('--config=')
    ) {
      const config = arg.startsWith('--config=') ? arg.slice(9) : args[++i]
      const match = config?.match(/^(model|model_reasoning_effort)=(.*)$/)
      if (match) {
        let value = match[2]!
        try {
          value = JSON.parse(value)
        } catch {}
        if (typeof value === 'string')
          settings[match[1] === 'model' ? 'model' : 'effort'] = value
      }
    }
  }
  return settings
}
export async function describeRuntime(
  binary: string,
  settings: { model?: string; effort?: string },
  vm = false,
) {
  let version: string | undefined
  const runtime = basename(binary)
  // The guest image may carry a different binary from the host.
  if (!vm && (runtime === 'codex' || runtime === 'claude'))
    try {
      const output = await promisify(execFile)(binary, ['--version'], {
        timeout: 2000,
        maxBuffer: 4096,
      })
      version = redact(output.stdout.trim().split('\n')[0], 120)
    } catch {}
  return runtimeReport.parse({
    runtime: redact(runtime, 120),
    runtime_version: version,
    model: settings.model,
    effort: settings.effort,
    isolation: vm ? 'vm' : 'host',
    host: redact(hostname(), 120),
  })
}
