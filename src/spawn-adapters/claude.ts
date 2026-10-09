import { mkdir, writeFile } from 'node:fs/promises'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import {
  event,
  payload,
  shellQuote,
  nativeOptions,
  type AgentAdapter,
} from './types'
const types = {
  SessionStart: 'busy',
  UserPromptSubmit: 'busy',
  PreToolUse: 'tool_start',
  PostToolUse: 'tool_end',
  PostToolUseFailure: 'tool_end',
  Notification: 'waiting',
  PermissionRequest: 'waiting',
  Stop: 'idle',
} as const
export const claudeAdapter: AgentAdapter = {
  name: 'claude',
  profileArgs({ model, effort }) {
    if (effort && !['low', 'medium', 'high', 'xhigh', 'max'].includes(effort))
      throw Error('Claude effort must be low, medium, high, xhigh or max')
    return [
      ...(model ? ['--model', model] : []),
      ...(effort ? ['--effort', effort] : []),
    ]
  },
  async prepare(context, args) {
    // Modes explicitly disabling hooks must retain their native semantics.
    if (nativeOptions(args).some((a) => ['--bare', '--safe-mode'].includes(a)))
      return { args, cleanup() {} }
    const directory = join(context.directory, context.id)
    await mkdir(directory, { mode: 0o700 })
    const file = join(directory, 'settings.json')
    try {
      context.onCleanup?.(() =>
        rmSync(directory, { recursive: true, force: true }),
      )
      const command = [...context.command, 'hook', '--session', context.id]
        .map(shellQuote)
        .join(' ')
      const hooks = Object.fromEntries(
        Object.keys(types).map((name) => [
          name,
          [{ hooks: [{ type: 'command', command, timeout: 1 }] }],
        ]),
      )
      await writeFile(file, JSON.stringify({ hooks }), {
        mode: 0o600,
        flag: 'wx',
      })
      // Installed Claude accepts only the last --settings. If the caller has
      // one, additive plugin hooks preserve their entire settings source.
      const extra: string[] = []
      if (
        nativeOptions(args).some(
          (a) => a === '--settings' || a.startsWith('--settings='),
        )
      ) {
        await mkdir(join(directory, '.claude-plugin'), { mode: 0o700 })
        await mkdir(join(directory, 'hooks'), { mode: 0o700 })
        await writeFile(
          join(directory, '.claude-plugin', 'plugin.json'),
          JSON.stringify({ name: 'gild-session-observer', version: '1.0.0' }),
          { mode: 0o600 },
        )
        await writeFile(
          join(directory, 'hooks', 'hooks.json'),
          JSON.stringify({ hooks }),
          { mode: 0o600 },
        )
        extra.push('--plugin-dir', directory)
      }
      return {
        args: ['--settings', file, ...extra, ...args],
        cleanup: () => rmSync(directory, { recursive: true, force: true }),
      }
    } catch (error) {
      rmSync(directory, { recursive: true, force: true })
      throw error
    }
  },
  translate(session, raw) {
    const p = payload(raw)
    if (
      !p ||
      typeof p.hook_event_name !== 'string' ||
      typeof p.agent_id === 'string'
    )
      return null
    const type = types[p.hook_event_name as keyof typeof types]
    return type
      ? event(
          session,
          'claude',
          type,
          raw,
          typeof p.tool_name === 'string' ? p.tool_name : undefined,
        )
      : null
  },
}
