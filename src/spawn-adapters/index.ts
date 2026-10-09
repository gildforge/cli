import { basename } from 'node:path'
import { claudeAdapter } from './claude'
import { codexAdapter } from './codex'
import {
  nativeOptions,
  type AgentAdapter,
  type RuntimeSettings,
  type RuntimeFlags,
} from './types'
const adapters: AgentAdapter[] = [claudeAdapter, codexAdapter]
export function adapterFor(
  agent: string,
  args: string[],
): AgentAdapter | undefined {
  if (
    basename(agent) === 'claude' &&
    nativeOptions(args).some((a) => ['--bare', '--safe-mode'].includes(a))
  )
    return undefined
  return adapters.find((adapter) => adapter.name === basename(agent))
}

// Kimi has no structured event observer yet. Its verified flags share the
// runtime registry; absent effort support is an error, never a guessed flag.
const runtimeFlags = new Map<string, RuntimeFlags>(
  adapters.map((a) => [a.name, a.profileArgs]),
)
runtimeFlags.set('kimi', ({ model, effort }) => {
  if (effort)
    throw Error(
      'Kimi --help exposes no effort flag; omit effort and use native args',
    )
  return model ? ['--model', model] : []
})
export function profileArguments(
  runtime: string,
  settings: RuntimeSettings,
): string[] {
  return runtimeFlags.get(basename(runtime))?.(settings) ?? []
}
