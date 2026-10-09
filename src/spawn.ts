import { spawn } from 'node:child_process'
import { createConnection } from 'node:net'
import { realAgent, agentEnvironment } from './spawn-binary'
import { resolveProfile } from './agent-profiles'
import type { ReportTarget } from './spawn-report'
import { runNative, supportsPty, debugFallback } from './spawn-native'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { createHash, randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { loadHostConfig, parseLevel, statusLines } from './isolation'
import { Command, InvalidArgumentError } from 'commander'
import { spawnWorkerSource } from './spawn-bundle' with { type: 'macro' }
import {
  liveSessions,
  localRequest,
  privateSessionsDirectory,
  socketPath,
  MAX_MESSAGE_BYTES,
} from './spawn-sessions'

/** Linux caps one argv string at 128 KiB, so the bundled worker runs from a
 * content-addressed file in the private ~/.gild directory, not `node -e`. */
async function workerFile() {
  const source = await spawnWorkerSource()
  const directory = dirname(await privateSessionsDirectory())
  const path = join(
    directory,
    `spawn-worker-${createHash('sha256').update(source).digest('hex').slice(0, 16)}.mjs`,
  )
  if ((await readFile(path, 'utf8').catch(() => null)) !== source) {
    const partial = `${path}.${process.pid}.tmp`
    await writeFile(partial, source, { mode: 0o600 })
    await rename(partial, path)
  }
  return path
}

function idleMilliseconds(value: string) {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 0 || number > 60000)
    throw new InvalidArgumentError('idle-ms must be an integer from 0 to 60000')
  return number
}
export function spawnCommands(
  program: Command,
  resolveIdentity?: (
    label: string,
    cwd: string,
    localProfile: boolean,
  ) => Promise<{ agent: string; report?: ReportTarget }>,
) {
  program
    .command('spawn <agent> [args...]')
    .description('run a terminal agent with a private local message endpoint')
    .passThroughOptions()
    .option(
      '--as <label>',
      'report state with an approved local agent identity',
    )
    .option('--print-id', 'print the local session id to stderr')
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
        opts: { name?: string; idleMs: number; as?: string; printId?: boolean },
      ) => {
        const resolved =
          agent === 'agent'
            ? await resolveProfile(args.shift() ?? '', args)
            : undefined
        const profile = resolved?.profile
        if (profile && opts.as && opts.as !== profile.name)
          throw Error(
            'A profile uses its own approved agent label; --as must match the profile name',
          )
        if (profile && opts.name)
          throw Error('Profile sessions are named after the agent; omit --name')
        agent = profile?.runtime ?? agent
        args = resolved?.args ?? args
        const cwd = profile?.directory ?? process.cwd()
        const label = profile?.name ?? opts.as
        const binary = realAgent(agent, cwd)
        if (!process.stdin.isTTY || !process.stdout.isTTY || !supportsPty()) {
          process.exitCode = await runNative(
            binary,
            args,
            cwd,
            agentEnvironment(binary, profile?.env),
          )
          return
        }
        const identity =
          label && resolveIdentity
            ? await resolveIdentity(label, cwd, !!profile)
            : undefined
        const report = identity?.report
        const id =
          profile?.name ??
          opts.name ??
          `agent-${randomBytes(3).toString('hex')}`
        socketPath(id)
        const resolveFrom = [
          ...(!import.meta.url.includes('$bunfs') &&
          import.meta.url.startsWith('file:')
            ? [new URL(import.meta.url).pathname]
            : []),
          join(dirname(process.execPath), 'gild.js'),
        ]
        const worker = spawn(
          'node',
          [
            await workerFile(),
            JSON.stringify({
              agent,
              args,
              id,
              idleMs: opts.idleMs,
              resolveFrom,
              hookCommand: import.meta.url.includes('$bunfs')
                ? [process.execPath]
                : [
                    process.execPath,
                    'run',
                    new URL('./gild.ts', import.meta.url).pathname,
                  ],
              reporting: !!report,
              identity: identity?.agent,
              printId: opts.printId,
              profile: profile
                ? { name: profile.name, channels: profile.channels }
                : undefined,
              envAllowlist: profile?.env,
            }),
          ],
          {
            cwd,
            stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
          },
        )
        if (report)
          worker.once('spawn', () => worker.send({ type: 'report', report }))
        const signals: NodeJS.Signals[] = ['SIGTERM', 'SIGHUP', 'SIGWINCH']
        const interrupted = () => {}
        process.on('SIGINT', interrupted)
        const disconnected = () => worker.kill('SIGHUP')
        process.on('disconnect', disconnected)
        const handlers = signals.map((signal) => () => worker.kill(signal))
        signals.forEach((signal, index) => process.on(signal, handlers[index]))
        try {
          process.exitCode = await new Promise<number>((resolve, reject) => {
            worker.once('error', reject)
            worker.once('exit', (code, signal) =>
              resolve(
                code ??
                  (signal === 'SIGINT' ? 130 : signal === 'SIGHUP' ? 129 : 143),
              ),
            )
          })
        } catch (error) {
          debugFallback(error)
          process.exitCode = await runNative(
            realAgent(agent, cwd),
            args,
            cwd,
            agentEnvironment(realAgent(agent, cwd), profile?.env),
          )
        } finally {
          process.off('SIGINT', interrupted)
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
      // The sender (often another agent) needs to know the session accepted
      // it; delivery waits for the agent to be ready (see gild status).
      console.log(`queued for ${id}`)
    })
  program
    .command('status [id]')
    .description(
      "inspect a live local agent session, or (no id) show this machine's isolation",
    )
    .option(
      '--isolation <level>',
      'with no id: show the outcome of this request',
    )
    .option(
      '--config-dir <path>',
      'gild config directory',
      join(homedir(), '.config', 'gild'),
    )
    .action(async (id: string | undefined, opts) => {
      if (!id) {
        const host = await loadHostConfig(opts.configDir)
        for (const line of statusLines(host, {
          flag: parseLevel(opts.isolation, '--isolation'),
        }))
          console.log(line)
        return
      }
      const directory = await privateSessionsDirectory()
      console.log(
        JSON.stringify(
          await localRequest(socketPath(id, directory), { type: 'info' }),
        ),
      )
    })
  program
    .command('sessions')
    .description('list live local agent sessions and remove stale sockets')
    .option('--json', 'print session metadata as JSON')
    .action(async (opts: { json?: boolean }) => {
      const sessions = await liveSessions()
      if (opts.json) console.log(JSON.stringify(sessions))
      else {
        console.log(
          'ID\tAGENT\tPROFILE\tSTATE\tTOOL\tLAST ACTIVITY\tCWD\tPID\tSTARTED',
        )
        for (const session of sessions)
          console.log(
            [
              session.id,
              session.agent,
              session.profile ?? '',
              session.state === 'tool_start' ? 'running a tool' : session.state,
              session.tool ?? '',
              session.lastActivity,
              session.cwd,
              session.pid,
              session.started,
            ].join('\t'),
          )
      }
    })
}

export async function localEvents(id: string) {
  const directory = await privateSessionsDirectory()
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection(socketPath(id, directory))
    socket.on('error', reject)
    socket.on('connect', () => socket.write('{"type":"subscribe"}\n'))
    socket.on('data', (data) => {
      if (!process.stdout.write(data)) socket.pause()
    })
    const drain = () => socket.resume()
    process.stdout.on('drain', drain)
    socket.on('close', () => {
      process.stdout.off('drain', drain)
      resolve()
    })
  })
}
