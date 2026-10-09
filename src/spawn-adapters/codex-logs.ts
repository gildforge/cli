import { open, readdir, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { AgentEvent } from '../spawn-events'
import { event, payload } from './types'
/** Best effort, bound only by a notify-proven thread ID; never guess by cwd. */
export class CodexLogs {
  private path?: string
  private offset = 0
  private partial = ''
  private tools = new Map<string, string>()
  private timer?: ReturnType<typeof setInterval>
  private reading = false
  private closed = false
  private bound = false
  private notBefore = 0
  constructor(
    private readonly root: string,
    private readonly session: string,
    private readonly emit: (event: AgentEvent) => void,
  ) {}
  async bind(raw: unknown) {
    this.notBefore = Date.now()
    this.tools.clear()
    const p = payload(raw),
      id = p?.['thread-id']
    if (
      this.bound ||
      typeof id !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,100}$/.test(id)
    )
      return
    this.bound = true
    try {
      const entries = await readdir(this.root, { recursive: true })
      const match = entries.find(
        (path) =>
          basename(path) === id + '.jsonl' ||
          basename(path).endsWith('-' + id + '.jsonl'),
      )
      if (!match || this.closed) return
      this.path = join(this.root, match)
      // Old history cannot change the live state after a notify event.
      this.offset = (await stat(this.path)).size
      if (!this.closed)
        this.timer = setInterval(() => {
          void this.poll()
        }, 250)
    } catch {
      /* Missing/paginated logs do not disable notify. */
    }
  }
  async poll() {
    if (this.reading || this.closed || !this.path) return
    this.reading = true
    let file: Awaited<ReturnType<typeof open>> | undefined
    try {
      file = await open(this.path, 'r')
      const size = (await file.stat()).size
      if (size < this.offset) {
        this.offset = size
        this.partial = ''
        return
      }
      if (size === this.offset) return
      if (size - this.offset > 1024 * 1024) {
        this.offset = size
        this.partial = ''
        return
      }
      const buffer = Buffer.alloc(size - this.offset)
      const { bytesRead } = await file.read(
        buffer,
        0,
        buffer.length,
        this.offset,
      )
      this.offset += bytesRead
      const lines = (
        this.partial + buffer.subarray(0, bytesRead).toString('utf8')
      ).split('\n')
      this.partial = lines.pop() ?? ''
      if (this.partial.length > 65536) this.partial = ''
      for (const line of lines) {
        if (line.length > 65536 || this.closed) continue
        try {
          const raw = JSON.parse(line),
            p = payload(raw.payload)
          const timestamp =
            typeof raw.timestamp === 'string' ? Date.parse(raw.timestamp) : NaN
          if (!p || !Number.isFinite(timestamp) || timestamp <= this.notBefore)
            continue
          if (raw.type === 'event_msg' && p.type === 'task_started')
            this.emit(event(this.session, 'codex', 'busy', raw))
          if (raw.type !== 'response_item') continue
          if (
            ['function_call', 'custom_tool_call'].includes(String(p.type)) &&
            typeof p.name === 'string' &&
            typeof p.call_id === 'string'
          ) {
            if (this.tools.size >= 1000) this.tools.clear()
            this.tools.set(p.call_id, p.name)
            this.emit(event(this.session, 'codex', 'tool_start', raw, p.name))
          } else if (
            ['function_call_output', 'custom_tool_call_output'].includes(
              String(p.type),
            ) &&
            typeof p.call_id === 'string'
          ) {
            const tool = this.tools.get(p.call_id)
            if (tool) {
              this.tools.delete(p.call_id)
              this.emit(event(this.session, 'codex', 'tool_end', raw, tool))
            }
          }
          // Completion comes only from notify; delayed log records cannot unlock injection.
        } catch {
          /* Internal JSONL shapes are not a protocol. */
        }
      }
    } catch {
    } finally {
      await file?.close().catch(() => {})
      this.reading = false
    }
  }
  close() {
    this.closed = true
    clearInterval(this.timer)
  }
}
