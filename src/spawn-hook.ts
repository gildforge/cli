import { spawn } from 'node:child_process'
import { createConnection } from 'node:net'
import type { Readable } from 'node:stream'
import { socketPath, MAX_MESSAGE_BYTES } from './spawn-sessions'
/** Deliberately independent of Commander, identity loading, API clients and PTYs. */
export async function forwardHook(
  args: string[],
  input: Readable = process.stdin,
  schedule: (
    done: () => void,
    ms: number,
  ) => ReturnType<typeof setTimeout> = setTimeout,
) {
  await new Promise<void>((resolve) => {
    let socket: ReturnType<typeof createConnection> | undefined
    let bytes = 0
    const chunks: Buffer[] = []
    const done = () => {
      clearTimeout(timer)
      input.pause()
      input.off('data', data)
      input.off('end', forward)
      input.off('error', done)
      socket?.destroy()
      resolve()
    }
    const timer = schedule(done, 200)
    const data = (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > MAX_MESSAGE_BYTES - 1024) done()
      else chunks.push(Buffer.from(chunk))
    }
    const forward = () => {
      try {
        const index = args.indexOf('--session')
        if (index < 0) return done()
        const raw = JSON.parse(
          args.at(-1)?.startsWith('{')
            ? args.at(-1)!
            : Buffer.concat(chunks).toString('utf8'),
        )
        const agentIndex = args.indexOf('--agent')
        const agent = agentIndex < 0 ? 'claude' : args[agentIndex + 1]
        socket = createConnection(socketPath(args[index + 1]))
        socket.on('error', done)
        socket.on('connect', () =>
          socket!.end(JSON.stringify({ type: 'hook', agent, raw }) + '\n'),
        )
        socket.on('close', done)
      } catch {
        done()
      }
    }
    // Codex appends notification JSON as argv, Claude sends stdin JSON.
    if (args.at(-1)?.startsWith('{')) forward()
    else {
      input.on('data', data)
      input.once('end', forward)
      input.once('error', done)
      input.resume()
    }
  })
}

export async function runHook(args: string[]) {
  await forwardHook(args)
  // The forwarding deadline bounds gild only; the caller's notifier retains its
  // own runtime and receives exactly the payload argument Codex appended.
  const index = args.indexOf('--notify-command')
  if (index >= 0) {
    const command: unknown = JSON.parse(args[index + 1])
    if (
      Array.isArray(command) &&
      command.length &&
      command.every((arg) => typeof arg === 'string')
    ) {
      await new Promise<void>((resolve) => {
        const child = spawn(command[0], [...command.slice(1), args.at(-1)!], {
          stdio: 'inherit',
        })
        child.once('error', () => resolve())
        child.once('exit', () => resolve())
      })
    }
  }
}
