import { basename } from 'node:path'
import { claudeAdapter } from './claude'
import { codexAdapter } from './codex'
import { nativeOptions, type AgentAdapter } from './types'
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
