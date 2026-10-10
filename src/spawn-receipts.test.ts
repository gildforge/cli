import { expect, test } from 'bun:test'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { GildClient } from './api/client'
import { MentionBridge } from './spawn-bridge'
import { InjectionQueue } from './spawn-queue'
import type { AgentEvent } from './spawn-events'

for (const fails of [false, true]) {
  test(`mention receipts: held draft, delivery then busy-hook read; forge failure=${fails} keeps typing`, async () => {
    const reports: { state: string; reason?: string }[] = [],
      auth: string[] = [],
      paths: string[] = [],
      writes: string[] = []
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        auth.push(request.headers.get('authorization')!)
        paths.push(new URL(request.url).pathname)
        const input = (await request.json()) as {
          state: string
          reason?: string
        }
        reports.push(input)
        return fails
          ? Response.json({ message: 'forge unavailable' }, { status: 503 })
          : Response.json({
              agent: 'owner/bob',
              ...input,
              updated_at: new Date().toISOString(),
            })
      },
    })
    await mkdir('.tmp', { recursive: true })
    let idle = true,
      queued = 0
    const client = new GildClient(
      server.url.origin + '/api/v1',
      'gf_receipt_fixture',
    )
    const abort = new AbortController()
    const queue = new InjectionQueue(
      (data) => writes.push(String(data)),
      0,
      () => idle,
      true,
    )
    queue.userInput(Buffer.from('private draft'))
    const bridge = new MentionBridge({
      client: {
        request: (async (op: string, ...args: any[]) => {
          if (op !== 'events') return (client.request as any)(op, ...args)
          abort.abort()
          return {
            cursor: '1',
            events: [
              {
                id: 'event1',
                cursor: '1',
                event: 'channel.mention',
                payload: {
                  repository: { full_name: 'owner/demo' },
                  agent: 'owner/bob',
                  message: {
                    id: 'msg1',
                    cursor: '41',
                    body: '@bob work on this',
                    author: { name: 'sami' },
                  },
                },
              },
            ],
          }
        }) as never,
      },
      agent: 'owner/bob',
      label: 'bob',
      session: 'receipt-test',
      repos: ['owner/demo'],
      file: join(await mkdtemp(resolve('.tmp/receipt-')), 'saved.json'),
      enqueue: (text, typed, held) => {
        queued++
        queue.enqueue(text, typed, held)
      },
      emit: () => {},
    })
    const busy = (source?: string): AgentEvent => ({
      session: 'receipt-test',
      agent: 'claude',
      type: 'busy',
      ts: new Date().toISOString(),
      raw: source ? { source } : { hook_event_name: 'UserPromptSubmit' },
    })
    try {
      await bridge.start(abort.signal)
      await bridge.flush()
      expect(reports).toHaveLength(1)
      expect(reports[0].state).toBe('held')
      expect(reports[0].reason).toContain('unsent draft')
      expect(JSON.stringify(reports)).not.toContain('private draft')
      bridge.event(busy())
      await bridge.flush()
      expect(reports).toHaveLength(1)
      // Actual input queue must protect the draft; submitting clears it.
      expect(writes.join('')).not.toContain('@bob')
      idle = false
      queue.userInput(Buffer.from('\r'))
      queue.changed()
      await bridge.flush()
      expect(reports.at(-1)).toEqual({
        state: 'held',
        reason: 'agent not idle',
      })
      idle = true
      queue.changed()
      const deadline = Date.now() + 2000
      while (
        !writes.join('').includes('@bob work on this') ||
        !writes.at(-1)?.endsWith('\r')
      ) {
        if (Date.now() > deadline) throw Error('queue did not submit mention')
        await Bun.sleep(10)
      }
      bridge.event(busy('pty_submit'))
      await bridge.flush()
      expect(reports.at(-1)?.state).toBe('delivered')
      bridge.event(busy())
      bridge.event(busy())
      await bridge.flush()
      expect(reports.slice(-2).map((x) => x.state)).toEqual([
        'delivered',
        'read',
      ])
      expect(reports.filter((x) => x.state === 'read')).toHaveLength(1)
      expect(auth.every((x) => x === 'Bearer gf_receipt_fixture')).toBe(true)
      expect(
        paths.every(
          (x) => x === '/api/v1/repos/owner/demo/channel/messages/41/receipts',
        ),
      ).toBe(true)
      expect(queued).toBe(1)
      // The same live queue still accepts work after all receipt POSTs failed.
      queue.enqueue('continue working')
      await Bun.sleep(120)
      expect(writes.join('')).toContain('continue working')
    } finally {
      queue.close()
      server.stop(true)
    }
  })
}
