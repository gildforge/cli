// `gild chat <owner/repo>`: the repository channel as an IRC-style terminal
// UI, the same channel as gild.gg's Agents tab. A small line renderer: each
// frame is a list of fully padded rows, and only rows that changed are
// rewritten.
import type { GildClient } from './api/client'
import type {
  ChannelMessage,
  ChannelPage,
  ChannelParticipant,
  ChannelSummary,
} from './api/channel-contract'
import { stateLabel } from './channel/state'
import { rawChannel } from './chat'

export type Style = {
  fg?: number
  bold?: boolean
  dim?: boolean
  italic?: boolean
  underline?: boolean
  reverse?: boolean
  href?: string
}
export type Span = { text: string; style?: Style }
type Line = Span[]

const segmenter = new Intl.Segmenter()
const graphemes = (text: string) =>
  Array.from(segmenter.segment(text), (s) => s.segment)
export const width = (text: string) => Bun.stringWidth(text)
const lineWidth = (line: Line) => line.reduce((n, s) => n + width(s.text), 0)

/** Bodies and names are other people's text: no control characters (and so
 *  no escape sequences) ever reach the terminal. */
export const clean = (text: string) =>
  text.replace(/\t/g, '  ').replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, '')

// ANSI 31-36: every terminal theme maps these for its own background, so
// nicks stay readable on dark and light terminals alike.
const NICK_COLOURS = [32, 34, 35, 36, 31, 33]
export function nickColour(name: string) {
  let hash = 2166136261
  for (const char of name) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619)
  return NICK_COLOURS[(hash >>> 0) % NICK_COLOURS.length]
}

function sgr(style: Style | undefined, colour: boolean) {
  const codes = ['0']
  if (style?.bold) codes.push('1')
  if (style?.dim) codes.push('2')
  if (style?.italic) codes.push('3')
  if (style?.underline) codes.push('4')
  if (style?.reverse) codes.push('7')
  if (colour && style?.fg) codes.push(String(style.fg))
  return `\x1b[${codes.join(';')}m`
}

/** Exactly `cols` cells: truncated with an ellipsis, padded with `fill`. */
export function paint(line: Line, cols: number, colour: boolean, fill?: Style) {
  let out = '',
    used = 0
  const total = lineWidth(line)
  outer: for (const span of line) {
    let text = ''
    for (const g of graphemes(span.text)) {
      const w = width(g)
      if (used + w > cols || (total > cols && used + w > cols - 1)) {
        if (text) out += wrapSpan(text, span.style, colour)
        if (used < cols) {
          out += wrapSpan('…', span.style, colour)
          used++
        }
        text = ''
        break outer
      }
      text += g
      used += w
    }
    if (text) out += wrapSpan(text, span.style, colour)
  }
  if (used < cols) out += sgr(fill, colour) + ' '.repeat(cols - used)
  return out + '\x1b[0m'
}
function wrapSpan(text: string, style: Style | undefined, colour: boolean) {
  const body = sgr(style, colour) + text
  // OSC 8 hyperlinks: clickable where the terminal supports them, invisible
  // where it does not.
  return style?.href ? `\x1b]8;;${style.href}\x1b\\${body}\x1b]8;;\x1b\\` : body
}

/** Word wrap with hard breaks for words wider than the line. */
export function wrap(line: Line, max: number): Line[] {
  const rows: Line[] = [[]]
  let used = 0
  const push = (text: string, style?: Style) => {
    rows.at(-1)!.push({ text, style })
    used += width(text)
  }
  for (const span of line)
    for (const token of span.text.split(/(\s+)/)) {
      if (!token) continue
      const w = width(token)
      if (used + w <= max) push(token, span.style)
      else if (/^\s+$/.test(token)) {
        rows.push([])
        used = 0
      } else if (w <= max) {
        rows.push([])
        used = 0
        push(token, span.style)
      } else
        for (const g of graphemes(token)) {
          if (used + width(g) > max) {
            rows.push([])
            used = 0
          }
          push(g, span.style)
        }
    }
  return rows
}

const MENTION = /(@[A-Za-z0-9_.\/-]*[A-Za-z0-9_])/
const pad2 = (n: number) => String(n).padStart(2, '0')
const clock = (date: Date) =>
  `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
const day = (date: Date) =>
  date.toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })

/** Mention matching as the forge does it: the full `@sponsor/label`, or the
 *  bare label. */
export function mentions(body: string, name: string | null) {
  if (!name) return false
  const lower = name.toLowerCase()
  const label = lower.split('/').at(-1)
  return (body.match(new RegExp(MENTION, 'g')) ?? []).some((tag) => {
    const t = tag.slice(1).toLowerCase()
    return t === lower || (lower.includes('/') && t === label)
  })
}

export type Frame = { lines: string[]; cursor: [number, number] }
export type Connection = 'connecting' | 'live' | 'reconnecting'

export class ChatView {
  messages: ChannelMessage[] = []
  private byCursor = new Map<string, ChannelMessage>()
  participants: ChannelParticipant[] = []
  channels: ChannelSummary[] = []
  selected = ''
  archived = false
  showArchived = false
  resetChannel(name: string) {
    this.selected = name
    this.messages = []
    this.byCursor.clear()
    this.scroll = 0
    this.unseen = 0
    this.older = null
    this.online = null
  }
  online: Set<string> | null = null
  canPost = false
  viewer: string | null = null
  input = ''
  caret = 0
  scroll = 0
  unseen = 0
  older: string | null = null
  loadingOlder = false
  panel: 'auto' | 'shown' | 'hidden' = 'auto'
  connection: Connection = 'connecting'
  status: { text: string; error: boolean } | null = null
  private completion: {
    start: number
    options: string[]
    index: number
  } | null = null
  private bodyWidth = 0
  private bodyHeight = 0

  constructor(
    readonly repo: string,
    readonly colour: boolean,
    readonly origin: string,
  ) {
    this.selected = repo.split('/')[1]
  }

  /** Merge messages (dedupe by cursor, sort numerically). A reader scrolled
   *  up keeps their place; what arrived below is counted. */
  add(messages: ChannelMessage[]) {
    const before = this.bodyWidth ? this.logLines(this.bodyWidth).length : 0
    let fresh = 0
    const tip = this.messages.at(-1)?.cursor
    for (const m of messages) {
      if (!this.byCursor.has(m.cursor) && (!tip || +m.cursor > +tip)) fresh++
      this.byCursor.set(m.cursor, m)
    }
    this.messages = [...this.byCursor.values()].sort(
      (a, b) => +a.cursor - +b.cursor,
    )
    if (this.scroll > 0 && this.bodyWidth) {
      this.scroll += this.logLines(this.bodyWidth).length - before
      this.unseen += fresh
    }
  }

  panelVisible(cols: number) {
    return this.panel === 'auto' ? cols >= 72 : this.panel === 'shown'
  }
  togglePanel(cols: number) {
    this.panel = this.panelVisible(cols) ? 'hidden' : 'shown'
  }
  isOnline(p: ChannelParticipant) {
    return this.online ? this.online.has(p.name) : p.online
  }

  // ---- the message log -------------------------------------------------
  private nickWidth() {
    const widest = Math.max(
      0,
      ...this.messages.map((m) => width(clean(m.author.name))),
    )
    return Math.min(16, Math.max(6, widest))
  }
  private href(link: string) {
    try {
      return new URL(link, this.origin).href
    } catch {
      return undefined
    }
  }
  private body(m: ChannelMessage, paragraph: string): Line {
    if (m.kind === 'note')
      return [{ text: clean(paragraph), style: { dim: true, italic: true } }]
    const spans: Line = []
    // split() with one capture group alternates text, mention, text, …
    for (const [i, part] of clean(paragraph).split(MENTION).entries()) {
      if (!part) continue
      if (i % 2 === 0) {
        spans.push({
          text: part,
          style: m.kind !== 'message' ? { dim: true, italic: true } : undefined,
        })
        continue
      }
      const self = mentions(part, this.viewer)
      const known = this.participants.find((p) => mentions(part, p.name))
      spans.push({
        text: part,
        style: self
          ? { bold: true, reverse: true, fg: 33 }
          : known
            ? { bold: true, fg: nickColour(known.name) }
            : { bold: true },
      })
    }
    return spans
  }
  logLines(cols: number): Line[] {
    const nickW = this.nickWidth()
    const indent = 5 + 1 + nickW + 1
    const textW = Math.max(8, cols - indent - 2)
    const lines: Line[] = []
    let lastDay = ''
    for (const m of this.messages) {
      const at = new Date(m.created_at)
      const valid = !Number.isNaN(at.getTime())
      const today = valid ? day(at) : ''
      if (today && today !== lastDay) {
        const label = ` ${today} `
        const side = Math.max(2, Math.floor((cols - width(label)) / 2) - 1)
        lines.push([
          {
            text: '─'.repeat(side) + label + '─'.repeat(side),
            style: { dim: true },
          },
        ])
        lastDay = today
      }
      const name = clean(m.author.name)
      const system = m.kind !== 'message'
      const self = this.viewer !== null && name === this.viewer
      const nickText = system ? '*' : name
      const shown =
        width(nickText) > nickW
          ? graphemes(nickText)
              .slice(0, nickW - 1)
              .join('') + '…'
          : nickText
      const head: Line = [
        { text: valid ? clock(at) : '--:--', style: { dim: true } },
        { text: ' ' + ' '.repeat(Math.max(0, nickW - width(shown))) },
        {
          text: shown,
          style: system
            ? { dim: true, bold: true }
            : {
                fg: nickColour(name),
                bold: self || m.author.kind === 'human',
                reverse: mentions(m.body, this.viewer),
              },
        },
        { text: ' │ ', style: { dim: true } },
      ]
      const body: Line = []
      if (m.reply_to) {
        const target = this.byCursor.get(m.reply_to)
        body.push({
          text: `↪ ${target ? clean(target.author.name) : '#' + m.reply_to} `,
          style: { dim: true },
        })
      }
      const paragraphs = m.body.split(/\r?\n/)
      const wrapped: Line[] = []
      paragraphs.forEach((p, i) => {
        const line = i === 0 ? [...body, ...this.body(m, p)] : this.body(m, p)
        if (i === paragraphs.length - 1 && m.link) {
          const href = this.href(m.link.href)
          line.push(
            { text: ' ' },
            {
              text: `→ ${clean(m.link.label)}`,
              style: { underline: true, fg: 34, href },
            },
          )
        }
        wrapped.push(...wrap(line, textW))
      })
      wrapped.forEach((row, i) =>
        lines.push(
          i === 0
            ? [...head, ...row]
            : [
                { text: ' '.repeat(indent) },
                { text: '│ ', style: { dim: true } },
                ...row,
              ],
        ),
      )
    }
    return lines
  }

  // ---- the participants column ----------------------------------------
  private panelWidth() {
    const widest = Math.max(
      8,
      ...this.participants.map((p) => width(clean(p.prefix + p.name))),
      ...this.channels.map((c) => width(clean(c.name)) + 8),
    )
    return Math.min(28, Math.max(18, widest + 4))
  }
  panelLines(h: number): Line[] {
    const lines: Line[] = [
      [{ text: ' Channels', style: { dim: true, bold: true } }],
    ]
    for (const c of this.channels.filter(
      (c) => !c.archived || this.showArchived,
    ))
      lines.push([
        {
          text: ` ${c.name === this.selected ? '>' : ' '}#${clean(c.name)}${c.unread ? ' [' + c.unread + ']' : ''}${c.archived ? ' (archived)' : ''}`,
          style: {
            bold: c.unread > 0,
            reverse: c.name === this.selected,
            dim: c.archived,
          },
        },
      ])
    if (this.channels.some((c) => c.archived))
      lines.push([
        {
          text: ` ${this.showArchived ? '▾' : '▸'} archived (/archived)`,
          style: { dim: true },
        },
      ])
    lines.push([])
    const group = (kind: 'human' | 'agent', title: string) => {
      const people = this.participants.filter((p) => p.kind === kind)
      const online = people.filter((p) => this.isOnline(p)).length
      lines.push([
        { text: ` ${title} `, style: { dim: true, bold: true } },
        { text: `${online}/${people.length}`, style: { dim: true } },
      ])
      for (const p of people) {
        const on = this.isOnline(p)
        lines.push([
          { text: ' ' },
          on
            ? { text: '●', style: { fg: 32 } }
            : { text: '○', style: { dim: true } },
          { text: ' ' },
          {
            text: p.prefix || ' ',
            style: {
              bold: true,
              fg: p.prefix === '@' ? 31 : p.prefix === '%' ? 35 : 32,
            },
          },
          {
            text: clean(p.name),
            style: {
              fg: nickColour(p.name),
              bold: p.name === this.viewer,
              dim: !on,
            },
          },
        ])
        if (p.state) {
          const label = stateLabel(p.state).slice(2)
          lines.push([
            { text: '     ' },
            {
              text: label,
              style:
                p.state.status === 'waiting'
                  ? { fg: 33 }
                  : label.startsWith('busy')
                    ? { fg: 32 }
                    : { dim: true },
            },
          ])
        }
      }
    }
    group('human', 'HUMANS')
    lines.push([])
    group('agent', 'AGENTS')
    if (lines.length > h) {
      const hidden = lines.length - (h - 1)
      lines.length = h - 1
      lines.push([{ text: ` +${hidden} more`, style: { dim: true } }])
    }
    return lines
  }

  // ---- input ------------------------------------------------------------
  insert(text: string) {
    this.completion = null
    this.input =
      this.input.slice(0, this.caret) + text + this.input.slice(this.caret)
    this.caret += text.length
  }
  backspace() {
    this.completion = null
    if (!this.caret) return
    const before = graphemes(this.input.slice(0, this.caret))
    const removed = before.pop()!.length
    this.input =
      this.input.slice(0, this.caret - removed) + this.input.slice(this.caret)
    this.caret -= removed
  }
  deleteForward() {
    this.completion = null
    const next = graphemes(this.input.slice(this.caret))[0]
    if (next)
      this.input =
        this.input.slice(0, this.caret) +
        this.input.slice(this.caret + next.length)
  }
  move(by: -1 | 1) {
    this.completion = null
    if (by < 0) {
      const g = graphemes(this.input.slice(0, this.caret)).pop()
      if (g) this.caret -= g.length
    } else {
      const g = graphemes(this.input.slice(this.caret))[0]
      if (g) this.caret += g.length
    }
  }
  home() {
    this.completion = null
    this.caret = 0
  }
  end() {
    this.completion = null
    this.caret = this.input.length
  }
  killLine() {
    this.completion = null
    this.input = ''
    this.caret = 0
  }
  killWord() {
    this.completion = null
    const head = this.input.slice(0, this.caret).replace(/\S*\s*$/, '')
    this.input = head + this.input.slice(this.caret)
    this.caret = head.length
  }
  /** Tab: complete the word before the caret to `@name `; Tab again cycles. */
  complete() {
    if (this.completion) {
      const c = this.completion
      c.index = (c.index + 1) % c.options.length
      this.replaceWord(c.start, c.options[c.index])
      return
    }
    const head = this.input.slice(0, this.caret)
    const start = head.search(/\S*$/)
    const word = head.slice(start).replace(/^@/, '').toLowerCase()
    if (!word && !head.endsWith('@')) return
    const options = this.participants
      .map((p) => p.name)
      .filter((name) => {
        const n = name.toLowerCase()
        return n.startsWith(word) || n.split('/').at(-1)!.startsWith(word)
      })
      .map((name) => `@${name} `)
    if (!options.length) return
    this.completion = { start, options, index: 0 }
    this.replaceWord(start, options[0])
  }
  private replaceWord(start: number, text: string) {
    this.input =
      this.input.slice(0, start) + text + this.input.slice(this.caret)
    this.caret = start + text.length
  }

  // ---- scrolling ----------------------------------------------------------
  scrollBy(lines: number) {
    const max = Math.max(
      0,
      this.logLines(this.bodyWidth || 80).length - this.bodyHeight,
    )
    this.scroll = Math.max(0, Math.min(max, this.scroll + lines))
    if (this.scroll === 0) this.unseen = 0
  }
  page() {
    return Math.max(1, this.bodyHeight - 2)
  }
  atTop() {
    return (
      this.scroll >=
      this.logLines(this.bodyWidth || 80).length - this.bodyHeight
    )
  }

  // ---- the frame ----------------------------------------------------------
  render(cols: number, rows: number): Frame {
    const colour = this.colour
    const showPanel = this.panelVisible(cols) && cols >= 30
    const pw = showPanel ? this.panelWidth() : 0
    const logW = showPanel ? cols - pw - 1 : cols
    const h = Math.max(0, rows - 3)
    this.bodyWidth = logW
    this.bodyHeight = h
    const all = this.logLines(logW)
    this.scroll = Math.min(this.scroll, Math.max(0, all.length - h))
    const end = all.length - this.scroll
    const visible = all.slice(Math.max(0, end - h), end)
    // Short logs sit at the bottom, next to the input, like any chat.
    const log = [...Array(Math.max(0, h - visible.length)).fill([]), ...visible]
    const panel = showPanel ? this.panelLines(h) : []

    const lines: string[] = []
    lines.push(this.topBar(cols))
    for (let i = 0; i < h; i++)
      lines.push(
        showPanel
          ? paint(log[i], logW, colour) +
              sgr({ dim: true }, colour) +
              '│' +
              paint(panel[i] ?? [], pw, colour)
          : paint(log[i], logW, colour),
      )
    lines.push(this.statusLine(cols))
    const [input, caretCol] = this.inputLine(cols)
    lines.push(input)
    return { lines: lines.slice(0, rows), cursor: [rows, caretCol + 1] }
  }
  private topBar(cols: number) {
    const humans = this.participants.filter(
      (p) => p.kind === 'human' && this.isOnline(p),
    ).length
    const agents = this.participants.filter(
      (p) => p.kind === 'agent' && this.isOnline(p),
    ).length
    const left: Line = [
      { text: ' gild ', style: { reverse: true, bold: true, fg: 33 } },
      {
        text: ` #${this.selected}${this.archived ? ' (archived)' : ''} `,
        style: { reverse: true, bold: true },
      },
      {
        text: `· ${humans} ${humans === 1 ? 'human' : 'humans'}, ${agents} ${agents === 1 ? 'agent' : 'agents'} online `,
        style: { reverse: true },
      },
    ]
    const conn =
      this.connection === 'live'
        ? { text: '● live ', style: { reverse: true, fg: 32 } }
        : {
            text: `${this.connection === 'connecting' ? 'connecting' : 'reconnecting'}… `,
            style: { reverse: true, fg: 33 },
          }
    const who = this.viewer
      ? this.canPost
        ? `as ${clean(this.viewer)} `
        : `as ${clean(this.viewer)} · read-only `
      : 'read-only '
    const right: Line = [conn, { text: `· ${who}`, style: { reverse: true } }]
    const gap = cols - lineWidth(left) - lineWidth(right)
    return paint(
      gap > 0
        ? [
            ...left,
            { text: ' '.repeat(gap), style: { reverse: true } },
            ...right,
          ]
        : left,
      cols,
      this.colour,
      { reverse: true },
    )
  }
  private statusLine(cols: number) {
    let note: Span | null = null
    if (this.status)
      note = {
        text: ` ${this.status.text} `,
        style: this.status.error ? { fg: 31, bold: true } : { dim: true },
      }
    else if (this.loadingOlder)
      note = { text: ' loading older messages… ', style: { dim: true } }
    else if (this.scroll > 0)
      note = {
        text: this.unseen
          ? ` ↓ ${this.unseen} new below · PgDn `
          : ' ↓ more below · PgDn ',
        style: { bold: true, fg: 33 },
      }
    const rule = (n: number): Span => ({
      text: '─'.repeat(Math.max(0, n)),
      style: { dim: true },
    })
    if (!note) return paint([rule(cols)], cols, this.colour)
    return paint(
      [rule(2), note, rule(cols - 2 - width(note.text))],
      cols,
      this.colour,
    )
  }
  private inputLine(cols: number): [string, number] {
    const prompt: Line = this.canPost
      ? [
          {
            text: clean(this.viewer ?? 'you'),
            style: { bold: true, fg: nickColour(this.viewer ?? '') },
          },
          { text: ' › ', style: { dim: true } },
        ]
      : [{ text: '› ', style: { dim: true } }]
    const pw = lineWidth(prompt)
    if (!this.canPost && !this.input)
      return [
        paint(
          [
            ...prompt,
            {
              text: this.viewer
                ? 'read-only: this identity cannot post here'
                : 'read-only: run `gild auth init` to post',
              style: { dim: true, italic: true },
            },
          ],
          cols,
          this.colour,
        ),
        pw,
      ]
    const room = Math.max(1, cols - pw - 1)
    const shown = this.input.replace(/\n/g, '↵')
    const before = graphemes(shown.slice(0, this.caret))
    const after = graphemes(shown.slice(this.caret))
    // Keep the caret on screen: drop graphemes from the left as needed.
    let left = 0,
      used = before.reduce((n, g) => n + width(g), 0)
    while (used > room - 1 && left < before.length)
      used -= width(before[left++])
    const visible = before.slice(left).join('') + after.join('')
    return [paint([...prompt, { text: visible }], cols, this.colour), pw + used]
  }
}

// ---- keys -------------------------------------------------------------------
export type Key =
  { name: 'text'; text: string } | { name: string; text?: undefined }
const SEQUENCES: Record<string, string> = {
  '\r': 'enter',
  '\n': 'enter',
  '\t': 'tab',
  '\x7f': 'backspace',
  '\b': 'backspace',
  '\x03': 'ctrl-c',
  '\x04': 'ctrl-d',
  '\x01': 'home',
  '\x05': 'end',
  '\x0c': 'ctrl-l',
  '\x15': 'ctrl-u',
  '\x17': 'ctrl-w',
  '\x1b[5~': 'pageup',
  '\x1b[6~': 'pagedown',
  '\x1b[A': 'up',
  '\x1b[B': 'down',
  '\x1b[C': 'right',
  '\x1b[D': 'left',
  '\x1b[H': 'home',
  '\x1b[F': 'end',
  '\x1bOH': 'home',
  '\x1bOF': 'end',
  '\x1b[1~': 'home',
  '\x1b[4~': 'end',
  '\x1b[3~': 'delete',
  '\x1bOQ': 'f2',
  '\x1b[12~': 'f2',
}
export function parseKeys(data: string): Key[] {
  const keys: Key[] = []
  let i = 0
  while (i < data.length) {
    if (data.startsWith('\x1b[200~', i)) {
      const end = data.indexOf('\x1b[201~', i + 6)
      const text = data.slice(i + 6, end < 0 ? undefined : end)
      keys.push({ name: 'text', text: text.replace(/\r\n?/g, '\n') })
      i = end < 0 ? data.length : end + 6
      continue
    }
    if (data[i] === '\x1b') {
      const match = data.slice(i).match(/^\x1b(\[[0-9;]*[~A-Za-z]|O[A-Za-z])/)
      const seq = match ? match[0] : '\x1b'
      keys.push({
        name: SEQUENCES[seq] ?? (seq === '\x1b' ? 'escape' : 'unknown'),
      })
      i += seq.length
      continue
    }
    const named = SEQUENCES[data[i]]
    if (named) {
      keys.push({ name: named })
      i++
      continue
    }
    let j = i
    while (j < data.length && data[j] !== '\x1b' && !SEQUENCES[data[j]]) j++
    const text = data.slice(i, j).replace(/[\x00-\x1f\x7f]/g, '')
    if (text) keys.push({ name: 'text', text })
    i = j
  }
  return keys
}

// ---- the app ----------------------------------------------------------------
type Terminal = {
  input: NodeJS.ReadStream
  output: NodeJS.WriteStream
}
const ENTER = '\x1b[?1049h\x1b[?2004h\x1b[H\x1b[2J'
const LEAVE = '\x1b[?2004l\x1b[0m\x1b[?25h\x1b[?1049l'

export async function runChatTui(options: {
  client: GildClient
  repo: { owner: string; repo: string }
  colour?: boolean
  channel?: string
  terminal?: Terminal
}) {
  const { client, repo } = options
  const term = options.terminal ?? {
    input: process.stdin,
    output: process.stdout,
  }
  if (!term.input.isTTY || !term.output.isTTY)
    throw Error(
      'gild chat <owner/repo> needs a terminal; in scripts use gild chat history, send or raw',
    )
  let selected = options.channel ?? repo.repo
  let generation = 0
  const target = `${repo.owner}/${repo.repo}`
  // Load before taking over the screen: a refusal prints like any command.
  const [roster, page, list] = await Promise.all([
    client.request('channelParticipants', repo, undefined, {
      channel: selected,
    }),
    client.request('channelMessages', repo, undefined, {
      limit: 100,
      channel: selected,
    }),
    client.request('channelList', repo),
  ])
  const origin = client.baseURL.replace(/\/api\/v1\/?$/, '')
  const view = new ChatView(
    target,
    options.colour ??
      !('NO_COLOR' in process.env && process.env.NO_COLOR !== ''),
    origin,
  )
  view.selected = selected
  view.channels = list.channels
  view.archived = !!list.channels.find((c) => c.name === selected)?.archived
  view.participants = roster.participants
  view.canPost = roster.can_post
  view.viewer = roster.viewer
  view.add(page.messages)
  view.older = page.before

  const { input, output } = term
  const size = () => ({
    cols: Math.max(20, output.columns || 80),
    rows: Math.max(5, output.rows || 24),
  })
  let previous: string[] = []
  let previousCursor = ''
  let scheduled = false
  let closed = false
  const draw = () => {
    scheduled = false
    if (closed) return
    const { cols, rows } = size()
    const frame = view.render(cols, rows)
    let changed = ''
    frame.lines.forEach((line, i) => {
      if (previous[i] !== line) changed += `\x1b[${i + 1};1H${line}`
    })
    const cursor = frame.cursor.join(';')
    // Nothing moved (a presence ping that changed nobody): write nothing.
    if (!changed && cursor === previousCursor) return
    previous = frame.lines
    previousCursor = cursor
    output.write(`\x1b[?25l${changed}\x1b[${cursor}H\x1b[?25h`)
  }
  const redraw = () => {
    if (!scheduled) {
      scheduled = true
      setImmediate(draw)
    }
  }
  const full = () => {
    previous = []
    previousCursor = ''
    output.write('\x1b[H\x1b[2J')
    redraw()
  }

  const controller = new AbortController()
  let quit!: () => void
  const finished = new Promise<void>((resolve) => (quit = resolve))
  const restore = () => {
    if (closed) return
    closed = true
    output.write(LEAVE)
    try {
      input.setRawMode(false)
    } catch {}
    input.pause()
  }
  const onSignal = () => quit()
  process.on('exit', restore)
  process.on('SIGTERM', onSignal)
  process.on('SIGHUP', onSignal)
  process.on('SIGINT', onSignal)

  let roster_timer: ReturnType<typeof setTimeout> | undefined
  const refreshRoster = async () => {
    try {
      const fresh = await client.request(
        'channelParticipants',
        repo,
        undefined,
        { channel: selected },
      )
      view.participants = fresh.participants
      const list = await client.request('channelList', repo)
      view.channels = list.channels
      view.archived = !!list.channels.find((c) => c.name === selected)?.archived
      view.canPost = fresh.can_post && !view.archived
      view.viewer = fresh.viewer
      redraw()
    } catch {}
  }
  const soonRoster = () => {
    clearTimeout(roster_timer)
    roster_timer = setTimeout(refreshRoster, 300)
  }
  const rosterInterval = setInterval(refreshRoster, 20000)

  /** A `ready` frame with `after` set means more history than one page. */
  const catchUp = async (after: string) => {
    let next: string | null = after
    while (next && !controller.signal.aborted) {
      const more: ChannelPage = await client.request(
        'channelMessages',
        repo,
        undefined,
        {
          channel: selected,
          after: next,
          limit: 200,
        },
      )
      view.add(more.messages)
      next = more.after
      redraw()
    }
  }
  const onFrame = (text: string) => {
    let frame: {
      type?: string
      messages?: ChannelMessage[]
      message?: ChannelMessage
      online?: string[]
      after?: string | null
      participants?: ChannelParticipant[]
      can_post?: boolean
    }
    try {
      frame = JSON.parse(text)
    } catch {
      return
    }
    if (frame.type === 'ready') {
      view.connection = 'live'
      if (view.status?.error) view.status = null
      view.add(frame.messages ?? [])
      if (frame.after) void catchUp(frame.after).catch(() => {})
    } else if (frame.type === 'message' && frame.message) {
      view.add([frame.message])
      if (frame.message.kind === 'system') soonRoster()
    } else if (frame.type === 'archived') {
      view.archived = true
      view.canPost = false
      soonRoster()
    } else if (frame.type === 'presence' && Array.isArray(frame.online)) {
      view.online = new Set(frame.online)
      if (frame.participants) view.participants = frame.participants
      if (frame.can_post !== undefined)
        view.canPost = frame.can_post && !view.archived
    }
    redraw()
  }
  let streamController = new AbortController()
  const streamFrom = (cursor: string) => {
    const own = generation
    return rawChannel(
      client,
      repo,
      cursor,
      streamController.signal,
      (text) => {
        if (own === generation) onFrame(text)
      },
      () => {
        if (own === generation) {
          view.connection = 'reconnecting'
          redraw()
        }
      },
      undefined,
      undefined,
      selected,
    )
  }
  let stream = streamFrom(page.cursor)
  const switchChannel = async (name: string) => {
    const own = ++generation
    streamController.abort()
    streamController = new AbortController()
    selected = name
    view.resetChannel(name)
    view.connection = 'connecting'
    view.canPost = false
    redraw()
    const [page, people, list] = await Promise.all([
      client.request('channelMessages', repo, undefined, {
        channel: name,
        limit: 100,
      }),
      client.request('channelParticipants', repo, undefined, { channel: name }),
      client.request('channelList', repo),
    ])
    if (own !== generation) return
    view.add(page.messages)
    view.older = page.before
    view.participants = people.participants
    view.viewer = people.viewer
    view.channels = list.channels
    view.archived = !!list.channels.find((c) => c.name === name)?.archived
    view.canPost = people.can_post && !view.archived
    stream = streamFrom(page.cursor)
    redraw()
  }

  const loadOlder = async () => {
    if (!view.older || view.loadingOlder) return
    view.loadingOlder = true
    redraw()
    try {
      const more = await client.request('channelMessages', repo, undefined, {
        channel: selected,
        before: view.older,
        limit: 100,
      })
      view.add(more.messages)
      view.older = more.before
    } catch (error) {
      view.status = {
        text: `older messages: ${(error as Error).message}`,
        error: true,
      }
    } finally {
      view.loadingOlder = false
      redraw()
    }
  }
  const send = async () => {
    const body = view.input
    if (!body.trim()) return
    if (body.startsWith('/channel ')) {
      view.killLine()
      try {
        await switchChannel(body.slice(9).trim().replace(/^#/, ''))
      } catch (error) {
        view.status = { text: String(error), error: true }
      }
      redraw()
      return
    }
    if (body === '/archived') {
      view.killLine()
      view.showArchived = !view.showArchived
      redraw()
      return
    }
    if (!view.canPost) {
      view.status = {
        text: view.viewer
          ? 'read-only: this identity cannot post here'
          : 'read-only: run `gild auth init` to post',
        error: true,
      }
      return
    }
    view.killLine()
    view.status = { text: 'sending…', error: false }
    redraw()
    try {
      const posted = await client.request(
        'channelPost',
        repo,
        {
          body: body.startsWith('/note ') ? body.slice(6) : body,
          ...(body.startsWith('/note ') ? { kind: 'note' as const } : {}),
        },
        { channel: selected },
      )
      view.status = null
      view.scroll = 0
      view.unseen = 0
      view.add([posted])
    } catch (error) {
      // Give the text back so nothing typed is lost.
      if (!view.input) {
        view.input = body
        view.caret = body.length
      }
      view.status = {
        text: `not sent: ${(error as Error).message}`,
        error: true,
      }
    }
    redraw()
  }

  const onData = (data: Buffer | string) => {
    for (const key of parseKeys(String(data))) {
      switch (key.name) {
        case 'text':
          view.insert(key.text!)
          if (view.status?.error) view.status = null
          break
        case 'enter':
          void send()
          break
        case 'backspace':
          view.backspace()
          break
        case 'delete':
          view.deleteForward()
          break
        case 'left':
          view.move(-1)
          break
        case 'right':
          view.move(1)
          break
        case 'home':
          view.home()
          break
        case 'end':
          view.end()
          break
        case 'ctrl-u':
          view.killLine()
          break
        case 'ctrl-w':
          view.killWord()
          break
        case 'tab':
          view.complete()
          break
        case 'pageup':
        case 'up': {
          view.scrollBy(key.name === 'up' ? 3 : view.page())
          if (view.atTop()) void loadOlder()
          break
        }
        case 'pagedown':
        case 'down':
          view.scrollBy(-(key.name === 'down' ? 3 : view.page()))
          break
        case 'f2':
          view.togglePanel(size().cols)
          break
        case 'ctrl-l':
          full()
          break
        case 'escape':
          if (view.status) view.status = null
          break
        case 'ctrl-c':
          return quit()
        case 'ctrl-d':
          if (!view.input) return quit()
          view.deleteForward()
          break
      }
    }
    redraw()
  }
  const onResize = () => full()

  input.setRawMode(true)
  input.setEncoding('utf8')
  output.write(ENTER)
  input.on('data', onData)
  input.resume()
  output.on('resize', onResize)
  draw()
  try {
    await finished
  } finally {
    controller.abort()
    streamController.abort()
    clearInterval(rosterInterval)
    clearTimeout(roster_timer)
    input.off('data', onData)
    output.off('resize', onResize)
    process.off('SIGTERM', onSignal)
    process.off('SIGHUP', onSignal)
    process.off('SIGINT', onSignal)
    restore()
    process.off('exit', restore)
    await stream.catch(() => {})
  }
}
