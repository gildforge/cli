import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'
import { Command, InvalidArgumentError } from 'commander'
import { spawnWorkerSource } from './spawn-bundle' with { type: 'macro' }
import {
  liveSessions,
  localRequest,
  privateSessionsDirectory,
  requireUnix,
  socketPath,
  MAX_MESSAGE_BYTES,
} from './spawn-sessions'

function idleMilliseconds(value: string) {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 0 || number > 60000)
    throw new InvalidArgumentError('idle-ms must be an integer from 0 to 60000')
  return number
}
export function spawnCommands(program: Command) {
  program
    .command('spawn <agent> [args...]')
    .description('run a terminal agent with a private local message endpoint')
    .option('--name <id>', 'memorable local session name')
    .option(
      '--idle-ms <ms>',
      'wait for user input to be idle before injecting',
      idleMilliseconds,
      1500,
    )
    .allowUnknownOption()
    .action(
      async (
        agent: string,
        args: string[],
        opts: { name?: string; idleMs: number },
      ) => {
        requireUnix()
        const id = opts.name ?? `agent-${randomBytes(3).toString('hex')}`
        socketPath(id)
        const resolveFrom = [
          ...(!import.meta.url.includes('$bunfs') &&
          import.meta.url.startsWith('file:')
            ? [new URL(import.meta.url).pathname]
            : []),
          join(dirname(process.execPath), 'gild.js'),
        ]
        const source = await spawnWorkerSource()
        const worker = spawn(
          'node',
          [
            '--input-type=module',
            '-e',
            source,
            JSON.stringify({
              agent,
              args,
              id,
              idleMs: opts.idleMs,
              resolveFrom,
            }),
          ],
          {
            stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
          },
        )
        const signals: NodeJS.Signals[] = [
          'SIGTERM',
          'SIGHUP',
          'SIGINT',
          'SIGWINCH',
        ]
        const disconnected = () => worker.kill('SIGHUP')
        process.on('disconnect', disconnected)
        const handlers = signals.map((signal) => () => worker.kill(signal))
        signals.forEach((signal, index) => process.on(signal, handlers[index]))
        try {
          process.exitCode = await new Promise<number>((resolve, reject) => {
            worker.once('error', () =>
              reject(
                new Error(
                  'spawn requires Node.js on PATH (install Node.js, then retry)',
                ),
              ),
            )
            worker.once('exit', (code, signal) =>
              resolve(
                code ??
                  (signal === 'SIGINT' ? 130 : signal === 'SIGHUP' ? 129 : 143),
              ),
            )
          })
        } finally {
          process.off('disconnect', disconnected)
          signals.forEach((signal, index) =>
            process.off(signal, handlers[index]),
          )
        }
      },
    )
  program
    .command('send <id> <message>')
    .description(
      'queue a prompt in a local agent session (use - to read stdin)',
    )
    .action(async (id: string, message: string) => {
      const directory = await privateSessionsDirectory()
      if (message === '-') {
        const chunks: Buffer[] = []
        let bytes = 0
        for await (const chunk of process.stdin) {
          bytes += chunk.length
          if (bytes > MAX_MESSAGE_BYTES)
            throw new Error('Message exceeds 64 KiB')
          chunks.push(Buffer.from(chunk))
        }
        message = Buffer.concat(chunks).toString('utf8')
      }
      await localRequest(socketPath(id, directory), { type: 'send', message })
    })
  program
    .command('sessions')
    .description('list live local agent sessions and remove stale sockets')
    .option('--json', 'print session metadata as JSON')
    .action(async (opts: { json?: boolean }) => {
      const sessions = await liveSessions()
      if (opts.json) console.log(JSON.stringify(sessions))
      else {
        console.log('ID\tAGENT\tCWD\tPID\tSTARTED')
        for (const session of sessions)
          console.log(
            [
              session.id,
              session.agent,
              session.cwd,
              session.pid,
              session.started,
            ].join('\t'),
          )
      }
    })
}
