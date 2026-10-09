import { GildClient } from './api/client'
import type { BridgeTarget } from './spawn-bridge'
import { parseNudge, Watchdog, type NudgeEvent } from './spawn-nudge'

function pair(repo: string) {
  const [owner, name] = repo.split('/')
  return { owner, repo: name }
}

/** The worker's watchdog: channel notes and reply checks use the session's
 * own agent identity. gild-site has no system-note route for clients yet, so a
 * note is an ordinary message from the agent, prefixed `[gild nudge]`. */
export function startWatchdog(o: {
  specs: string[]
  session: string
  agent?: string
  channels: string[]
  target?: BridgeTarget
  enqueue: (text: string) => void
  emit: (event: NudgeEvent) => void
}) {
  if (!o.specs.length) return undefined
  const client = o.target
    ? new GildClient(o.target.server + '/api/v1', o.target.token)
    : undefined
  const agent = o.target?.agent ?? o.agent
  return new Watchdog({
    rules: o.specs.map(parseNudge),
    session: o.session,
    agent,
    enqueue: o.enqueue,
    emit: o.emit,
    note:
      client && o.channels.length
        ? async (text, repo) => {
            const own = o.channels.find(
              (c) => c.toLowerCase() === repo?.toLowerCase(),
            )
            for (const channel of own ? [own] : o.channels)
              await client.request('channelPost', pair(channel), { body: text })
          }
        : undefined,
    replied:
      client && agent
        ? async (repo, cursor) => {
            const page = await client.request(
              'channelMessages',
              pair(repo),
              undefined,
              { after: cursor, limit: 200 },
            )
            return page.messages.some(
              (m) =>
                m.kind === 'message' &&
                m.author.name.toLowerCase() === agent.toLowerCase() &&
                !m.body.startsWith('[gild nudge]'),
            )
          }
        : undefined,
  })
}
