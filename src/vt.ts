// Test helper: just enough of a VT100 screen to read back what a full-screen
// program drew (cursor moves, erase, alternate screen, private modes). Text
// only; styles are checked on the raw bytes.
const segmenter = new Intl.Segmenter()

export class VirtualTerminal {
  private main: string[][]
  private alt: string[][]
  row = 0
  col = 0
  altScreen = false
  cursorVisible = true
  bracketedPaste = false
  constructor(
    public cols: number,
    public rows: number,
  ) {
    this.main = this.blank()
    this.alt = this.blank()
  }
  private blank() {
    return Array.from({ length: this.rows }, () =>
      Array<string>(this.cols).fill(' '),
    )
  }
  private get grid() {
    return this.altScreen ? this.alt : this.main
  }
  resize(cols: number, rows: number) {
    const fit = (g: string[][]) =>
      Array.from({ length: rows }, (_, r) =>
        Array.from({ length: cols }, (_, c) => g[r]?.[c] ?? ' '),
      )
    this.main = fit(this.main)
    this.alt = fit(this.alt)
    this.cols = cols
    this.rows = rows
    this.row = Math.min(this.row, rows - 1)
    this.col = Math.min(this.col, cols - 1)
  }
  private newline() {
    if (this.row < this.rows - 1) this.row++
    else {
      this.grid.shift()
      this.grid.push(Array<string>(this.cols).fill(' '))
    }
  }
  private csi(params: string, final: string) {
    const nums = params
      .replace(/^\?/, '')
      .split(';')
      .map((n) => (n === '' ? NaN : Number(n)))
    if (params.startsWith('?')) {
      const on = final === 'h'
      for (const n of nums) {
        if (n === 1049) {
          this.altScreen = on
          if (on) this.alt = this.blank()
        }
        if (n === 25) this.cursorVisible = on
        if (n === 2004) this.bracketedPaste = on
      }
      return
    }
    if (final === 'H' || final === 'f') {
      this.row = Math.min(this.rows - 1, (nums[0] || 1) - 1)
      this.col = Math.min(this.cols - 1, (nums[1] || 1) - 1)
    } else if (final === 'J' && nums[0] === 2) {
      for (const line of this.grid) line.fill(' ')
    } else if (final === 'K') {
      for (let c = this.col; c < this.cols; c++) this.grid[this.row][c] = ' '
    }
    // SGR and anything else: no effect on text.
  }
  private pending = ''
  write(chunk: string) {
    // A PTY read can end mid escape sequence; hold an incomplete tail.
    const data = this.pending + chunk
    this.pending = ''
    let i = 0
    while (i < data.length) {
      const ch = data[i]
      if (ch === '\x1b') {
        const rest = data.slice(i)
        const csi = rest.match(/^\x1b\[([0-9;?]*)([@-~])/)
        if (csi) {
          this.csi(csi[1], csi[2])
          i += csi[0].length
          continue
        }
        const osc = rest.match(/^\x1b\][^\x07\x1b]*(\x07|\x1b\\)/)
        if (osc) {
          i += osc[0].length
          continue
        }
        if (/^\x1b(\[[0-9;?]*|\][^\x07\x1b]*\x1b?|O)?$/.test(rest)) {
          this.pending = rest
          return
        }
        i += 2
        continue
      }
      if (ch === '\r') {
        this.col = 0
        i++
        continue
      }
      if (ch === '\n') {
        this.newline()
        i++
        continue
      }
      if (ch < ' ') {
        i++
        continue
      }
      let j = i
      while (j < data.length && data[j] >= ' ' && data[j] !== '\x7f') j++
      if (j === i) j = i + 1
      for (const { segment } of segmenter.segment(data.slice(i, j))) {
        const w = Bun.stringWidth(segment)
        if (this.col + w > this.cols) {
          this.col = 0
          this.newline()
        }
        this.grid[this.row][this.col] = segment
        for (let k = 1; k < w; k++) this.grid[this.row][this.col + k] = ''
        this.col += w
        if (this.col >= this.cols) this.col = this.cols // pending wrap
      }
      i = j
    }
  }
  lines() {
    return this.grid.map((line) => line.join('').replace(/\s+$/, ''))
  }
  text() {
    return this.lines().join('\n')
  }
}
