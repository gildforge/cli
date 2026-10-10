import { homedir } from 'node:os'
import { join } from 'node:path'
import { originalNotify } from './codex-notify'
import { CodexLogs } from './codex-logs'
import { event, payload, type AgentAdapter } from './types'
/** Keeps Codex's interactive update menu from blocking an injected session. */
export const NO_UPDATE_PROMPT = ['-c', 'check_for_update_on_startup=false']
export const codexAdapter: AgentAdapter = {
  name: 'codex',
  profileArgs({ model, effort }) {
    return [
      ...(model ? ['-m', model] : []),
      ...(effort
        ? ['-c', `model_reasoning_effort=${JSON.stringify(effort)}`]
        : []),
    ]
  },
  async prepare(context, args) {
    const environment = context.environment ?? process.env
    const original = await originalNotify(args, environment)
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
          join(
            environment.CODEX_HOME ??
              join(environment.HOME ?? homedir(), '.codex'),
            'sessions',
          ),
          context.id,
          context.emit,
        )
      : undefined
    context.onCleanup?.(() => logs?.close())
    // JSON array syntax is also a TOML array of quoted strings.
    return {
      args: [
        '-c',
        `notify=${JSON.stringify(command)}`,
        // A gild session is driven by injected prompts, often detached. Codex's
        // startup "Update available" menu would swallow the first prompt (its
        // Enter picks "Update now"), so the session never offers it. A later
        // `-c check_for_update_on_startup=true` in the profile args still wins.
        ...NO_UPDATE_PROMPT,
        ...original.args,
      ],
      cleanup: () => logs?.close(),
      receive: (raw) => {
        void logs?.bind(raw)
      },
    }
  },
  // Codex's notify fires only after a turn, and its SessionStart hook only on
  // the first prompt, so nothing says a fresh TUI is ready. Without this a
  // mention to a new Codex session waits forever as "agent not idle".
  startupQuietMs: 1500,
  translate(session, raw) {
    const p = payload(raw)
    return p?.type === 'agent-turn-complete'
      ? event(session, 'codex', 'idle', raw)
      : null
  },
}
