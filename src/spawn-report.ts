import { redactSession } from './session-redaction'
import type { z } from 'zod'
import type { runtimeReport } from './api/agent-profile-contract'
import { randomUUID } from 'node:crypto'
import { GildClient } from './api/client'
import type { AgentEvent } from './spawn-events'
import { sessionState, type SessionInput } from './api/sessions-contract'
export type ReportTarget = {
  server: string
  token: string
  agent: string
  owner: string
  repo: string
  sha: string
}
/** gild.gg answered a commit-session receipt in 2–4.5 s on 10 Oct; a 1 s
 * abort dropped every report, so the channel never showed an agent's state.
 * Only one request is in flight and the latest state wins, so a slow answer
 * delays the next update rather than piling them up. */
export const REPORT_TIMEOUT_MS = 10_000
/** One in-flight update, latest state wins. No local content reaches the API. */
export class StateReporter {
  private readonly id = randomUUID()
  private readonly started = new Date().toISOString()
  private readonly client: GildClient
  private pending?: NonNullable<SessionInput['state']>
  private timer?: ReturnType<typeof setTimeout>
  private sending?: Promise<void>
  private lastSent = 0
  private ended = false
  constructor(
    private readonly target: ReportTarget,
    private readonly model: string,
    fetcher?: ConstructorParameters<typeof GildClient>[2],
    private readonly environment?: z.output<typeof runtimeReport>,
  ) {
    this.client = new GildClient(
      target.server + '/api/v1',
      target.token,
      fetcher,
    )
  }
  event(event: AgentEvent) {
    if (this.ended || event.type === 'message') return
    const parsedTool = sessionState.shape.tool.safeParse(event.tool)
    const tool = parsedTool.success ? parsedTool.data : undefined
    this.pending = {
      status: event.type,
      ...(tool ? { tool } : {}),
      last_activity: event.ts,
    }
    this.schedule()
  }
  private schedule() {
    if (this.sending || this.timer || !this.pending) return
    this.timer = setTimeout(
      () => {
        this.timer = undefined
        void this.send()
      },
      Math.max(0, 1000 - (Date.now() - this.lastSent)),
    )
  }
  private async send(timeoutMs = REPORT_TIMEOUT_MS) {
    if (this.sending || !this.pending) return
    const state = this.pending
    this.pending = undefined
    this.lastSent = Date.now()
    this.sending = this.client
      .request(
        'createCommitSession',
        {
          owner: this.target.owner,
          repo: this.target.repo,
          sha: this.target.sha,
        },
        redactSession({
          id: this.id,
          ...(this.environment
            ? {
                environment: this.environment,
                runtime: this.environment.runtime,
              }
            : {}),
          agent: this.target.agent,
          started_at: this.started,
          ended_at: state.status === 'ended' ? state.last_activity : null,
          model: this.model,
          state,
          tokens_in: 0,
          tokens_out: 0,
          currency: 'USD',
          commands: [],
          files: { read: [], written: [] },
          notes: '',
        }),
        undefined,
        { signal: AbortSignal.timeout(timeoutMs) },
      )
      .then(
        () => {},
        () => {},
      )
    await this.sending
    this.lastSent = Date.now()
    this.sending = undefined
    this.schedule()
  }
  async close() {
    this.ended = true
    clearTimeout(this.timer)
    this.timer = undefined
    this.pending = { status: 'ended', last_activity: new Date().toISOString() }
    await this.sending
    clearTimeout(this.timer)
    this.timer = undefined
    // Honor the same rate limit for the final update.
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, 1000 - (Date.now() - this.lastSent))),
    )
    // Exit waits for this one, so it gets less time than a live update.
    await this.send(5000)
  }
}
