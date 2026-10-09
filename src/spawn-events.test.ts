import { expect, test } from 'bun:test'
import { createServer } from 'node:net'
import { mkdir, mkdtemp, rm, readFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { claudeAdapter } from './spawn-adapters/claude'
import { codexAdapter } from './spawn-adapters/codex'
import { applyEvent, type AgentEvent, type SessionState } from './spawn-events'
import { InjectionQueue } from './spawn-queue'
import { InputLine } from './spawn-input'
import { StateReporter } from './spawn-report'
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms))
const command = () =>
  process.env.TEST_GILD_COMMAND
    ? (JSON.parse(process.env.TEST_GILD_COMMAND) as string[])
    : [process.execPath, 'run', resolve('src/gild.ts')]

async function hook(
  home: string,
  args: string[],
  stdin: string | ReadableStream = '{}',
) {
  const start = performance.now()
  const hookCommand = process.env.TEST_GILD_HOOK_COMMAND
    ? (JSON.parse(process.env.TEST_GILD_HOOK_COMMAND) as string[])
    : command()
  const proc = Bun.spawn([...hookCommand, 'hook', ...args], {
    env: { ...process.env, HOME: home },
    stdin: typeof stdin === 'string' ? new Blob([stdin]) : stdin,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [code, out, err] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  return { code, out, err, ms: performance.now() - start }
}
test('hook forwards raw stdin and notify argv; absent sockets and incomplete stdin finish silently within deadline', async () => {
  await mkdir('.tmp', { recursive: true })
  const home = await mkdtemp(resolve('.tmp/h-'))
  await mkdir(join(home, '.gild/sessions'), { recursive: true })
  const messages: any[] = []
  const server = createServer((socket) => {
    let text = ''
    socket.on('data', (chunk) => (text += chunk))
    socket.on('end', () => messages.push(JSON.parse(text)))
  })
  await new Promise<void>((r) =>
    server.listen(join(home, '.gild/sessions/test.sock'), r),
  )
  try {
    const raw = { hook_event_name: 'Stop', session_id: 'real' }
    const result = await hook(home, ['--session', 'test'], JSON.stringify(raw))
    expect(result).toMatchObject({ code: 0, out: '', err: '' })
    expect(messages[0]).toEqual({ type: 'hook', agent: 'claude', raw })
    const notify = {
      type: 'agent-turn-complete',
      'thread-id': 'thread',
      'last-assistant-message': 'local',
    }
    expect(
      await hook(home, [
        '--session',
        'test',
        '--agent',
        'codex',
        JSON.stringify(notify),
      ]),
    ).toMatchObject({ code: 0, out: '', err: '' })
    expect(messages[1]).toEqual({ type: 'hook', agent: 'codex', raw: notify })
    for (const stdin of [
      '{}',
      '{invalid',
      new ReadableStream({ start() {} }),
    ]) {
      const absent = await hook(home, ['--session', 'missing'], stdin)
      expect(absent).toMatchObject({ code: 0, out: '', err: '' })
      expect(absent.ms).toBeLessThan(400) // Includes process startup; internal budget is 200ms.
    }
  } finally {
    server.close()
    await rm(home, { recursive: true, force: true })
  }
})

test('recorded native Claude hooks translate and capture session metadata defensively', async () => {
  const rows = (
    await readFile(resolve('scripts/evidence/claude-hooks.jsonl'), 'utf8')
  )
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  const types: Record<string, AgentEvent['type']> = {
    SessionStart: 'busy',
    UserPromptSubmit: 'busy',
    PreToolUse: 'tool_start',
    PostToolUse: 'tool_end',
    Notification: 'waiting',
    PermissionRequest: 'waiting',
    Stop: 'idle',
  }
  const observed = new Set<string>()
  const state: SessionState = { state: 'unknown', lastActivity: '' }
  for (const { payload } of rows) {
    const event = claudeAdapter.translate('test', payload)!
    observed.add(event.type)
    expect(event.type).toBe(types[payload.hook_event_name])
    expect(event.raw).toEqual(payload)
    if (payload.tool_name) expect(event.tool).toBe(payload.tool_name)
    applyEvent(state, event)
  }
  for (const type of ['busy', 'tool_start', 'tool_end', 'waiting', 'idle'])
    expect(observed.has(type)).toBe(true)
  expect(state.agentSessionId).toBe('recorded-session')
  expect(state.transcriptPath).toBe('/fixture/transcript.jsonl')
  for (const raw of [
    null,
    [],
    {},
    { hook_event_name: 'FutureEvent' },
    { hook_event_name: 'Stop', agent_id: 'subagent' },
  ])
    expect(claudeAdapter.translate('test', raw)).toBeNull()
})
test('Codex notify translates only turn completion; generated spawn config is native TOML', async () => {
  const raw = {
    type: 'agent-turn-complete',
    'thread-id': 'thread',
    'turn-id': 'turn',
    'input-messages': ['prompt'],
    'last-assistant-message': 'response',
  }
  expect(codexAdapter.translate('test', raw)).toMatchObject({
    session: 'test',
    agent: 'codex',
    type: 'idle',
    raw,
  })
  expect(codexAdapter.translate('test', { type: 'future' })).toBeNull()
  const prepared = await codexAdapter.prepare(
    { id: 'test', directory: '/fixture', command: ['/gild'] },
    ['--resume'],
  )
  expect(prepared.args).toEqual([
    '-c',
    'notify=["/gild","hook","--session","test","--agent","codex"]',
    '--resume',
  ])
})

test('structured injection queues busy turns and unsent drafts, resumes FIFO on idle and clear', async () => {
  let idle = false
  const writes: (string | Buffer)[] = []
  const queue = new InjectionQueue(
    (data) => writes.push(data),
    1000,
    () => idle,
    true,
    () => (idle = false),
  )
  try {
    queue.enqueue('first')
    queue.enqueue('second')
    await pause(120)
    expect(writes).toEqual([])
    queue.userInput(Buffer.from('draft'))
    idle = true
    queue.changed()
    await pause(120)
    expect(writes.map(String)).toEqual(['draft'])
    queue.userInput(Buffer.from('\x15'))
    await pause(120)
    expect(writes.map(String)).toEqual(['draft', '\x15', 'first', '\r'])
    await pause(100)
    expect(writes.at(-1)).toBe('\r')
    idle = true
    queue.changed()
    await pause(120)
    expect(writes.slice(-2)).toEqual(['second', '\r'])
    // Keystrokes racing the synthetic text/Enter pair are held for at most 80ms.
    idle = true
    queue.enqueue('third')
    await pause(30)
    queue.userInput(Buffer.from('new draft'))
    await pause(100)
    expect(writes.slice(-3).map(String)).toEqual(['third', '\r', 'new draft'])
    expect(queue.input.unsent).toBe(true)
  } finally {
    queue.close()
  }
})
test('input tracker handles split bracketed pastes, Escape, controls, cursor keys and submit', () => {
  const input = new InputLine()
  input.feed('draft\x1b')
  expect(input.unsent).toBe(true)
  input.feed('\x15')
  expect(input.unsent).toBe(false)
  input.feed('\x1b[20')
  input.feed('0~one\ntwo')
  expect(input.unsent).toBe(true)
  expect(input.feed('\n')).toBe(false)
  input.feed('\x1b[201~')
  expect(input.unsent).toBe(true)
  input.feed('\x03')
  expect(input.unsent).toBe(false)
  input.feed('\x1b[D')
  expect(input.unsent).toBe(false)
  input.feed('x')
  input.feed('\x7f')
  expect(input.unsent).toBe(true)
  expect(input.feed('\r')).toBe(true)
  expect(input.unsent).toBe(false)
})
test('fallback retains unknown state and idle-timeout injection', async () => {
  const writes: (string | Buffer)[] = []
  const queue = new InjectionQueue((data) => writes.push(data), 200)
  try {
    queue.userInput()
    queue.enqueue('fallback')
    await pause(80)
    expect(writes).toEqual([])
    await pause(240)
    expect(writes).toEqual(['fallback', '\r'])
  } finally {
    queue.close()
  }
})
test('Claude settings are private, preserve source bytes, add hooks for explicit settings and clean up', async () => {
  const root = await mkdtemp(resolve('.tmp/c-'))
  try {
    const user = join(root, 'user.json')
    await Bun.write(user, '{"hooks":{"Stop":[]},"theme":"dark"}')
    const before = await readFile(user)
    const prepared = await claudeAdapter.prepare(
      { id: 'test', directory: root, command: ['/fixture/gild'] },
      ['--settings', user, '--resume'],
    )
    expect(prepared.args.slice(-3)).toEqual(['--settings', user, '--resume'])
    expect(prepared.args).toContain('--plugin-dir')
    const path = join(root, 'test/settings.json')
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect(JSON.parse(await readFile(path, 'utf8')).hooks.Stop).toHaveLength(1)
    prepared.cleanup()
    expect(await Bun.file(path).exists()).toBe(false)
    expect(await readFile(user)).toEqual(before)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
test('state reporting coalesces, uses scoped token, hides raw/text/arguments and sends ended', async () => {
  const calls: { at: number; body: any }[] = []
  const reporter = new StateReporter(
    {
      server: 'https://gild.test',
      token: 'fixture-scoped-token',
      agent: 'owner/label',
      owner: 'owner',
      repo: 'demo',
      sha: 'a'.repeat(40),
    },
    'claude',
    async (input, init) => {
      expect(String(input)).toContain(
        '/commits/' + 'a'.repeat(40) + '/sessions',
      )
      expect((init!.headers as any).authorization).toBe(
        'Bearer fixture-scoped-token',
      )
      calls.push({ at: Date.now(), body: JSON.parse(init!.body as string) })
      return Response.json({}) // Invalid receipt is a fail-open report failure, still a real request.
    },
  )
  const event = {
    session: 'test',
    agent: 'claude',
    type: 'busy' as const,
    ts: new Date().toISOString(),
    text: 'private prompt',
    raw: { tool_input: 'secret' },
  }
  reporter.event(event)
  await pause(30)
  for (let i = 0; i < 10; i++)
    reporter.event({ ...event, type: 'tool_start', tool: 'Edit' })
  await pause(1100)
  expect(calls).toHaveLength(2)
  await reporter.close()
  expect(calls).toHaveLength(3)
  expect(calls[1].body.state).toMatchObject({
    status: 'tool_start',
    tool: 'Edit',
  })
  expect(calls[2].body.state.status).toBe('ended')
  expect(calls[2].body.ended_at).toBeString()
  expect(new Set(calls.map((c) => c.body.id)).size).toBe(1)
  for (let i = 1; i < calls.length; i++)
    expect(calls[i].at - calls[i - 1].at).toBeGreaterThanOrEqual(990)
  expect(JSON.stringify(calls)).not.toContain('private prompt')
  expect(JSON.stringify(calls)).not.toContain('secret')
})
test('PTY events, hook command, status, subscription, gating and settings cleanup work together', async () => {
  const proc = Bun.spawn(
    ['python3', resolve('scripts/fixtures/events-harness.py')],
    {
      env: { ...process.env, TEST_GILD_COMMAND: JSON.stringify(command()) },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  const [code, out, err] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  expect({ code, err }).toEqual({ code: 0, err: '' })
  expect(JSON.parse(out).passed).toBe(true)
}, 20000)

test('safe alias preserves pipes, redirect output, signal exits and raw argv while skipping a recursive shim', async () => {
  const proc = Bun.spawn(
    ['python3', resolve('scripts/fixtures/alias-harness.py')],
    {
      env: { ...process.env, TEST_GILD_COMMAND: JSON.stringify(command()) },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  const [code, out, err] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  expect({ code, err }).toEqual({ code: 0, err: '' })
  expect(JSON.parse(out).passed).toBe(true)
})

test('Codex logs bind only the notified thread, skip old history and tolerate unknown JSONL shapes', async () => {
  const { CodexLogs } = await import('./spawn-adapters/codex-logs')
  const root = await mkdtemp(resolve('.tmp/logs-'))
  const path = join(root, 'rollout-bound-thread.jsonl')
  const events: AgentEvent[] = []
  await Bun.write(
    path,
    '{"type":"event_msg","payload":{"type":"task_started"}}\n',
  )
  const logs = new CodexLogs(root, 'session', (event) => events.push(event))
  try {
    await logs.bind({ 'thread-id': 'bound-thread' })
    await logs.poll()
    expect(events).toEqual([])
    const { appendFile } = await import('node:fs/promises')
    await appendFile(
      path,
      [
        '{bad json}',
        JSON.stringify({ type: 'future', payload: null }),
        JSON.stringify({
          timestamp: new Date(Date.now() + 1000).toISOString(),
          type: 'event_msg',
          payload: { type: 'task_started' },
        }),
        JSON.stringify({
          timestamp: new Date(Date.now() + 1000).toISOString(),
          type: 'response_item',
          payload: {
            type: 'custom_tool_call',
            call_id: 'id',
            name: 'apply_patch',
          },
        }),
        JSON.stringify({
          timestamp: new Date(Date.now() + 1000).toISOString(),
          type: 'response_item',
          payload: {
            type: 'custom_tool_call_output',
            call_id: 'id',
            output: 'local',
          },
        }),
        JSON.stringify({
          timestamp: new Date(Date.now() + 1000).toISOString(),
          type: 'event_msg',
          payload: { type: 'task_complete' },
        }),
      ].join('\n') + '\n',
    )
    await logs.poll()
    expect(events.map((e) => e.type)).toEqual([
      'busy',
      'tool_start',
      'tool_end',
    ])
    expect(events[1].tool).toBe('apply_patch')
    expect(events[2].tool).toBe('apply_patch')
  } finally {
    logs.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('linked PTY sessions upload only state with scoped credentials, coalesce and finish ended', async () => {
  const proc = Bun.spawn(
    ['python3', resolve('scripts/fixtures/events-harness.py'), '--report'],
    {
      env: { ...process.env, TEST_GILD_COMMAND: JSON.stringify(command()) },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  const [code, out, err] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  expect({ code, err }).toEqual({ code: 0, err: '' })
  expect(JSON.parse(out).passed).toBe(true)
}, 20000)

test('native -- terminator makes bare/settings words positional and retains the Claude adapter', async () => {
  const { adapterFor } = await import('./spawn-adapters')
  expect(adapterFor('claude', ['--', '--bare'])).toBe(claudeAdapter)
  expect(adapterFor('claude', ['--bare'])).toBeUndefined()
  const root = await mkdtemp(resolve('.tmp/args-'))
  try {
    const prepared = await claudeAdapter.prepare(
      { id: 'test', directory: root, command: ['/gild'] },
      ['--', '--settings', 'literal'],
    )
    expect(prepared.args.slice(-3)).toEqual(['--', '--settings', 'literal'])
    expect(prepared.args).not.toContain('--plugin-dir')
    prepared.cleanup()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('native executables clear the wrapper chain for later nested agent launches', async () => {
  const { agentEnvironment } = await import('./spawn-binary')
  expect(agentEnvironment('/bin/cat').GILD_SPAWN_CHAIN).toBe('[]')
})

test('Windows native fallback leaves command suffix lookup to the native process launcher', async () => {
  const { realAgent } = await import('./spawn-binary')
  expect(realAgent('claude.exe', '/unavailable', 'win32')).toBe('claude.exe')
})
