import { write } from 'node:fs'
/** Async fd writes keep the socket/signal loop responsive when a TTY reader stalls. */
export class TerminalOutput {
  private pending: Buffer[] = []
  private active = false
  private waiters: (() => void)[] = []
  constructor(
    private readonly fd: number,
    private readonly pause: () => void,
    private readonly resume: () => void,
    private readonly failed: (error: Error) => void,
  ) {}
  push(data: string | Buffer) {
    this.pending.push(Buffer.isBuffer(data) ? data : Buffer.from(data))
    this.pause()
    this.pump()
  }
  flush(): Promise<void> {
    return !this.active && !this.pending.length
      ? Promise.resolve()
      : new Promise((resolve) => this.waiters.push(resolve))
  }
  private pump() {
    if (this.active) return
    const data = this.pending[0]
    if (!data) {
      for (const done of this.waiters.splice(0)) done()
      this.resume()
      return
    }
    this.active = true
    write(this.fd, data, 0, data.length, null, (error, written) => {
      this.active = false
      if (error) {
        this.pending = []
        for (const done of this.waiters.splice(0)) done()
        this.failed(error)
        return
      }
      if (written === data.length) this.pending.shift()
      else this.pending[0] = data.subarray(written)
      this.pump()
    })
  }
}
