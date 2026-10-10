import { homedir } from 'node:os'
import { join } from 'node:path'
import { originalNotify } from './codex-notify'
import { CodexLogs } from './codex-logs'
import { event, payload, type AgentAdapter } from './types'
/** Codex settings every gild session needs, because gild types its prompts.
 * - The startup "Update available" menu would swallow the first prompt (its
 *   Enter picks "Update now").
 * - Paste-burst detection treats typed prompt text as a paste and the Enter
 *   that follows it as part of the paste, so the prompt sat in the composer
 *   unsent: 0 of 3 fresh sessions answered on 10 Oct, 3 of 3 with it off.
 * Profile args come later on the command line, so a profile can still turn
 * either back on. */
export const SESSION_CONFIG = [
  '-c',
  'check_for_update_on_startup=false',
  '-c',
  'tui.disable_paste_burst=true',
]
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
        ...SESSION_CONFIG,
        ...original.args,
      ],
      cleanup: () => logs?.close(),
      receive: (raw) => {
        void logs?.bind(raw)
      },
    }
  },
  // Codex's notify fires only after a turn, and its SessionStart hook only on
  // the first prompt, so nothing says a fresh TUI is ready; without this a
  // mention to a new Codex session waits forever as "agent not idle". A busy
  // Codex redraws its "Working (Ns)" timer every second, so 5 s of silence
  // after an Enter means no turn is running. Its startup dialogs (trust,
  // update) must be answered by a person, never by a channel message.
  quiet: {
    startupMs: 1500,
    busyMs: 5000,
    dialogs: /Trustthisfolder|Updateavailable|Updatenow/i,
  },
  translate(session, raw) {
    const p = payload(raw)
    return p?.type === 'agent-turn-complete'
      ? event(session, 'codex', 'idle', raw)
      : null
  },
}
