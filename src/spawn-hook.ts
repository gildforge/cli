import { createConnection } from 'node:net'
import { socketPath, MAX_MESSAGE_BYTES } from './spawn-sessions'
/** Deliberately independent of Commander, identity loading, API clients and PTYs. */
export async function runHook(args: string[]) {
  await new Promise<void>((resolve) => {
    let socket: ReturnType<typeof createConnection> | undefined
    let bytes = 0
    const chunks: Buffer[] = []
    const done = () => {
      clearTimeout(timer)
      process.stdin.pause()
      process.stdin.off('data', data)
      process.stdin.off('end', forward)
      process.stdin.off('error', done)
      socket?.destroy()
      resolve()
    }
    const timer = setTimeout(done, 200)
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
      process.stdin.on('data', data)
      process.stdin.once('end', forward)
      process.stdin.once('error', done)
      process.stdin.resume()
    }
  })
}
