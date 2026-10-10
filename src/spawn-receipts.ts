import type { GildClient } from './api/client'
import type { ChannelReceiptInput } from './api/channel-contract'
/** Ordered, debounced receipt reports. The PTY never waits for the forge. */
export class ReceiptReporter {
  private pending: {
    repo: string
    cursor: string
    input: ChannelReceiptInput
  }[] = []
  private last = new Map<string, ChannelReceiptInput>()
  private timer?: ReturnType<typeof setTimeout>
  private sending?: Promise<void>
  constructor(private client: Pick<GildClient, 'request'>) {}
  report(repo: string, cursor: string, input: ChannelReceiptInput) {
    const key = repo + ':' + cursor,
      old = this.last.get(key),
      rank = { held: 0, delivered: 1, read: 2 }
    if (
      old &&
      (rank[input.state] < rank[old.state] ||
        JSON.stringify(old) === JSON.stringify(input))
    )
      return
    this.last.set(key, input)
    // Rapid held-reason changes collapse to the latest reason; delivery/read
    // remain distinct so the forge observes delivered before read.
    const prev = this.pending.at(-1)
    if (
      input.state === 'held' &&
      prev?.input.state === 'held' &&
      prev.repo === repo &&
      prev.cursor === cursor
    )
      prev.input = input
    else this.pending.push({ repo, cursor, input })
    this.schedule()
  }
  private schedule() {
    if (this.sending || this.timer || !this.pending.length) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.send()
    }, 50)
  }
  private async send() {
    if (this.sending) return this.sending
    this.sending = (async () => {
      while (this.pending.length) {
        const { repo, cursor, input } = this.pending.shift()!,
          [owner, name] = repo.split('/')
        try {
          await this.client.request(
            'channelReceipt',
            { owner, repo: name, cursor },
            input,
            undefined,
            { signal: AbortSignal.timeout(1000) },
          )
        } catch {
          /* Receipt outages must never interrupt the agent. */
        }
      }
    })()
    await this.sending
    this.sending = undefined
    this.schedule()
  }
  async flush() {
    clearTimeout(this.timer)
    this.timer = undefined
    await this.sending
    await this.send()
  }
}
