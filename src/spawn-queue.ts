import { InputLine } from './spawn-input'
/** No terminal controls may come from a message source. User input is untouched. */
export function injectedInput(message: string): string {
  const text = message.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '')
  return (text.includes('\n') ? `\x1b[200~${text}\x1b[201~` : text) + '\r'
}

/** Sources enqueue text; only this queue decides when to type it. A future
 * channel stream uses enqueue(), and screen-based busy detection uses ready(). */
export class InjectionQueue {
  readonly input = new InputLine()
  private buffered: Buffer[] = []
  private pending: {
    data: string
    typed?: () => void
    held?: (reason: string) => void
  }[] = []
  private bytes = 0
  private lastInput = Date.now()
  private timer?: ReturnType<typeof setTimeout>
  private escapeTimer?: ReturnType<typeof setTimeout>
  private submitTimer?: ReturnType<typeof setTimeout>
  constructor(
    private readonly write: (data: string | Buffer) => void,
    private readonly idleMs: number,
    private readonly ready: () => boolean = () => true,
    private readonly structured = false,
    private readonly submitted: () => void = () => {},
  ) {}
  userInput(data?: Buffer) {
    if (data && this.submitTimer) {
      this.buffered.push(Buffer.from(data))
      return
    }
    this.lastInput = Date.now()
    clearTimeout(this.escapeTimer)
    if (data) {
      if (this.input.feed(data) && this.structured) this.submitted()
      this.write(data)
      this.escapeTimer = setTimeout(() => {
        this.input.settleEscape()
        this.schedule()
      }, 50)
    }
    this.schedule()
  }
  changed() {
    this.schedule()
  }
  /** Why queued messages are not being typed yet, for `gild status`. */
  get held() {
    if (!this.pending.length) return undefined
    return {
      queued: this.pending.length,
      reason: this.submitTimer
        ? 'submitting'
        : !this.ready()
          ? 'agent not idle'
          : this.structured && this.input.unsent
            ? "unsent draft in the agent's input"
            : 'scheduled',
    }
  }
  /** `typed` runs once the prompt and its Enter have been written to the agent. */
  enqueue(
    message: string,
    typed?: () => void,
    held?: (reason: string) => void,
  ) {
    const data = injectedInput(message)
    if (
      this.pending.length >= 128 ||
      this.bytes + Buffer.byteLength(data) > 1024 * 1024
    )
      throw new Error('Session message queue is full')
    this.pending.push({ data, typed, held })
    this.bytes += Buffer.byteLength(data)
    this.schedule()
  }
  close() {
    clearTimeout(this.timer)
    clearTimeout(this.submitTimer)
    clearTimeout(this.escapeTimer)
    this.buffered = []
    this.pending = []
    this.bytes = 0
  }
  private schedule() {
    clearTimeout(this.timer)
    const reason = this.held?.reason
    if (reason) for (const item of this.pending) item.held?.(reason)
    if (!this.pending.length || this.submitTimer) return
    this.timer = setTimeout(
      () => {
        if (!this.ready() || (this.structured && this.input.unsent)) {
          if (!this.structured) this.schedule()
          return
        }
        const { data, typed } = this.pending.shift()!
        this.bytes -= Buffer.byteLength(data)
        // TUIs detect a burst of text as paste. Enter must arrive as a subsequent
        // input event, otherwise Claude/Codex may paste it instead of submitting.
        this.write(data.slice(0, -1))
        this.submitTimer = setTimeout(() => {
          this.submitTimer = undefined
          this.write('\r')
          if (this.structured) this.submitted()
          typed?.()
          for (const input of this.buffered.splice(0)) this.userInput(input)
          this.lastInput = Date.now()
          this.schedule()
        }, 80)
      },
      Math.max(
        10,
        (this.structured ? 0 : this.idleMs) - (Date.now() - this.lastInput),
      ),
    )
  }
}
