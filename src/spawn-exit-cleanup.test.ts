import { expect, test } from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  existsSync,
  writeFileSync,
  rmSync,
  unlinkSync,
} from 'node:fs'
import { createServer, createConnection, type Socket } from 'node:net'
import { resolve, join } from 'node:path'
import { finalizeSessionStreams, retireSessionResources } from './spawn-detach'

test('final exit and EOF cannot precede real session file cleanup', async () => {
  mkdirSync('.tmp', { recursive: true })
  const root = mkdtempSync(resolve('.tmp/exit-cleanup-')),
    path = join(root, 'fixture.sock'),
    directory = join(root, 'fixture')
  mkdirSync(directory)
  writeFileSync(join(directory, 'output.log'), 'fixture')
  let release!: () => void, began!: () => void
  const barrier = new Promise<void>((resolve) => {
    release = resolve
  })
  const started = new Promise<void>((resolve) => {
    began = resolve
  })
  const server = createServer()
  const peer = new Promise<Socket>((resolve) =>
    server.once('connection', resolve),
  )
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(path, resolve)
  })
  const client = createConnection(path)
  const received: string[] = [],
    visibleFiles: boolean[] = []
  const ended = new Promise<void>((resolve, reject) => {
    client.on('error', reject)
    client.on('data', (data) => {
      received.push(data.toString())
      visibleFiles.push(existsSync(path) || existsSync(directory))
    })
    client.on('end', resolve)
  })
  const socket = await peer
  let finishing: Promise<number> | undefined
  try {
    finishing = finalizeSessionStreams({
      session: 'fixture',
      code: 129,
      events: [socket],
      viewers: [],
      cleanup: async () => {
        began()
        await barrier
        server.close()
        if (existsSync(path)) unlinkSync(path)
        rmSync(directory, { recursive: true })
      },
    })
    await started
    expect(socket.writableEnded).toBe(false)
    expect(existsSync(path) && existsSync(directory)).toBe(true)
    release()
    await Promise.all([finishing, ended])
    expect(visibleFiles.length).toBeGreaterThan(0)
    expect(visibleFiles.every((visible) => !visible)).toBe(true)
    expect(JSON.parse(received.join(''))).toMatchObject({
      session: 'fixture',
      type: 'exited',
      code: 129,
    })
    expect(existsSync(path) || existsSync(directory)).toBe(false)
  } finally {
    release()
    await finishing
    client.destroy()
    socket.destroy()
    if (server.listening) server.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('retirement rejection still completes stop and subscriber peers after remaining cleanup', async () => {
  mkdirSync('.tmp', { recursive: true })
  const root = mkdtempSync(resolve('.tmp/exit-reject-')),
    path = join(root, 'fixture.sock'),
    directory = join(root, 'fixture')
  mkdirSync(directory)
  writeFileSync(join(directory, 'output.log'), 'retained fixture log')
  const server = createServer(),
    peers: Socket[] = []
  const connected = new Promise<void>((resolve) =>
    server.on('connection', (socket) => {
      peers.push(socket)
      if (peers.length === 2) resolve()
    }),
  )
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(path, resolve)
  })
  const clients = [createConnection(path), createConnection(path)]
  const results = clients.map(
    (client) =>
      new Promise<string>((resolve, reject) => {
        let data = ''
        client.on('data', (chunk) => {
          data += chunk.toString()
        })
        client.on('end', () => resolve(data))
        client.on('error', reject)
      }),
  )
  void Promise.all(results).catch(() => {})
  const failure = new Error('directory removal denied fixture'),
    calls: string[] = [],
    errors: unknown[] = []
  try {
    await connected
    const completion = await finalizeSessionStreams({
      session: 'fixture',
      code: 129,
      events: peers,
      viewers: [],
      cleanup: async () =>
        retireSessionResources({
          files: () => {
            calls.push('files')
            throw failure
          },
          listener: () => {
            calls.push('listener')
            server.close()
            throw new Error('listener failure fixture')
          },
          endpoint: () => {
            calls.push('endpoint')
            if (existsSync(path)) unlinkSync(path)
          },
        }),
      cleanupFailed: (error) => errors.push(error),
    }).then(
      (code) => ({ code, error: null }),
      (error) => ({ code: null, error }),
    )
    expect(completion.error).toBeNull()
    expect(completion.code).toBe(1)
    expect(
      (await Promise.all(results)).map((text) => JSON.parse(text)),
    ).toEqual([
      expect.objectContaining({ session: 'fixture', type: 'exited', code: 1 }),
      expect.objectContaining({ session: 'fixture', type: 'exited', code: 1 }),
    ])
    expect(calls).toEqual(['files', 'listener', 'endpoint'])
    expect(errors).toEqual([failure])
    expect(existsSync(path)).toBe(false)
    expect(existsSync(directory)).toBe(true)
  } finally {
    clients.forEach((client) => client.destroy())
    peers.forEach((peer) => peer.destroy())
    if (server.listening) server.close()
    rmSync(root, { recursive: true, force: true })
  }
})
