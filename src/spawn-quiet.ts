/** Terminal text without escape sequences or whitespace, so a dialog's words
 * match however the TUI positioned them on screen. */
export function screenText(data: string) {
  return data
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC (titles)
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '') // CSI (cursor, colour)
    .replace(/\x1b[@-_]/g, '')
    .replace(/[\x00-\x20\x7f]+/g, '')
}

/**
 * Readiness for a runtime that reports only the end of a turn (Codex):
 * - a fresh session is idle once its first screen has been quiet for
 *   `startupMs`;
 * - a busy state gild inferred itself (an Enter it typed or saw typed) falls
 *   back to idle after `busyMs` of silence, because a working Codex redraws
 *   its timer every second, while an Enter that answered a dialog or a prompt
 *   the TUI dropped would otherwise hold every later message forever;
 * - never while the text drawn since the last keystroke shows one of the
 *   runtime's dialogs: a channel message must not answer "Trust this folder?".
 *   The worker also clears that text on every Enter it sees or types.
 */
export class QuietIdle {
  private timer?: ReturnType<typeof setTimeout>
  private text = ''
  constructor(
    private readonly opts: {
      startupMs: number
      busyMs: number
      dialogs?: RegExp
      /** 'startup', 'busy' or null when the agent's own report is in charge. */
      phase: () => 'startup' | 'busy' | null
      idle: () => void
    },
  ) {}
  output(data: string | Buffer) {
    this.text = (this.text + screenText(data.toString())).slice(-16384)
    this.arm()
  }
  /** A keystroke changes the screen's context; old dialog text no longer applies. */
  input() {
    this.text = ''
    this.arm()
  }
  /** Re-evaluate after a state change (e.g. gild just typed a prompt). */
  changed() {
    this.arm()
  }
  close() {
    clearTimeout(this.timer)
    this.timer = undefined
  }
  private arm() {
    clearTimeout(this.timer)
    this.timer = undefined
    const phase = this.opts.phase()
    if (!phase) return
    this.timer = setTimeout(
      () => {
        this.timer = undefined
        if (this.opts.phase() !== phase) return
        if (this.opts.dialogs?.test(this.text)) return
        this.opts.idle()
      },
      phase === 'startup' ? this.opts.startupMs : this.opts.busyMs,
    )
    this.timer.unref?.()
  }
}
