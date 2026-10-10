import { execFile } from 'node:child_process'
import { hostname } from 'node:os'
import { promisify } from 'node:util'
import { basename } from 'node:path'
import { runtimeReport } from './api/agent-profile-contract'
import { redact } from './session-redaction'
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
