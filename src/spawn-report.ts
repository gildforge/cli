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
  private async send() {
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
        {
          id: this.id,
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
        },
        undefined,
        { signal: AbortSignal.timeout(1000) },
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
    await this.send()
  }
}
