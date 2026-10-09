/** Conservative composer tracking; unknown editing controls never authorize injection. */
export class InputLine {
  dirty = false
  private cause = ''
  private paste = false
  private escape = ''
  private pasteDirty = false
  // Terminal replies (OSC colour, DCS version, APC…) arrive on stdin when the
  // agent queries the terminal. They are not typing, so they never dirty the
  // line; they end at BEL or ESC \, and a line break ends a malformed one.
  private string: '' | 'body' | 'escape' = ''
  feed(data: Buffer | string): boolean {
    let submitted = false
    for (const byte of typeof data === 'string' ? Buffer.from(data) : data) {
      if (this.string && byte !== 10 && byte !== 13) {
        if (byte === 7 || (this.string === 'escape' && byte === 92))
          this.string = ''
        else this.string = byte === 27 ? 'escape' : 'body'
        continue
      }
      this.string = ''
      if (!this.paste && [3, 21, 10, 13].includes(byte)) {
        this.escape = ''
        this.dirty = false
        if (byte === 10 || byte === 13) submitted = true
        continue
      }
      if (this.escape === '\x1b' && [93, 80, 95, 94, 88].includes(byte)) {
        this.escape = ''
        this.string = 'body'
        continue
      }
      if (this.escape) {
        this.escape += String.fromCharCode(byte)
        if (
          '\x1b[200~'.startsWith(this.escape) ||
          '\x1b[201~'.startsWith(this.escape)
        ) {
          if (this.escape === '\x1b[200~') {
            this.paste = true
            this.escape = ''
            this.pasteDirty = false
          } else if (this.escape === '\x1b[201~') {
            this.paste = false
            this.dirty ||= this.pasteDirty
            this.escape = ''
          }
          continue
        }
        // CSI / SS3 cursor and function keys can arrive in separate chunks.
        if (this.escape === '\x1b[' || this.escape === '\x1bO') continue
        if (/^\x1b[\[O][0-9;?]*$/.test(this.escape)) continue
        const sequence = this.escape
        this.escape = ''
        // Esc cancels dialogs, but does not reliably erase or precede a draft.
        if (
          !sequence.startsWith('\x1b[') &&
          !sequence.startsWith('\x1bO') &&
          byte >= 32 &&
          byte !== 127
        ) {
          this.dirty = true
          this.cause = sequence
        }
        continue
      }
      if (byte === 27) {
        this.escape = '\x1b'
        continue
      }
      if (this.paste) {
        this.pasteDirty = true
        this.dirty = true
        continue
      }
      if (byte === 13 || byte === 10) {
        this.dirty = false
        submitted = true
      } else if (byte === 21 || byte === 3) this.dirty = false
      // Backspace/delete and cursor editing are intentionally conservative.
      else if ((byte >= 32 && byte !== 127) || byte === 9) {
        this.dirty = true
        this.cause = byte === 9 ? 'tab' : 'typed'
      }
    }
    return submitted
  }
  settleEscape() {
    if (this.escape === '\x1b') this.escape = ''
  }
  get why() {
    return {
      dirty: this.dirty && this.cause,
      paste: this.paste,
      escape: this.escape,
      string: this.string,
    }
  }
  get unsent() {
    return (
      this.dirty || this.paste || this.escape.length > 0 || this.string !== ''
    )
  }
}
