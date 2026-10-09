import { homedir } from 'node:os'
import { join } from 'node:path'
import { originalNotify } from './codex-notify'
import { CodexLogs } from './codex-logs'
import { event, payload, type AgentAdapter } from './types'
export const codexAdapter: AgentAdapter = {
  name: 'codex',
  async prepare(context, args) {
    const original = await originalNotify(args)
    const command = [
      ...context.command,
      'hook',
      '--session',
      context.id,
      '--agent',
      'codex',
      ...(original.command.length
        ? ['--notify-command', JSON.stringify(original.command)]
        : []),
    ]
    const logs = context.emit
      ? new CodexLogs(
          join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'sessions'),
          context.id,
          context.emit,
        )
      : undefined
    context.onCleanup?.(() => logs?.close())
    // JSON array syntax is also a TOML array of quoted strings.
    return {
      args: ['-c', `notify=${JSON.stringify(command)}`, ...original.args],
      cleanup: () => logs?.close(),
      receive: (raw) => {
        void logs?.bind(raw)
      },
    }
  },
  translate(session, raw) {
    const p = payload(raw)
    return p?.type === 'agent-turn-complete'
      ? event(session, 'codex', 'idle', raw)
      : null
  },
}
