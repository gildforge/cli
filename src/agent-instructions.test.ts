import { test, expect } from 'bun:test'
import {
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  rm,
  symlink,
} from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { createHash } from 'node:crypto'
import { pullInstructions, InstructionsSync } from './agent-instructions'
import { GildClient } from './api/client'
import { StateReporter } from './spawn-report'
import { InjectionQueue } from './spawn-queue'
import { launchSettings } from './runtime-report'
const remote = (text: string) => ({
  text,
  revision: createHash('sha256').update(text).digest('hex'),
  history: [],
})
test('reported model and effort follow native launch overrides', () => {
  expect(
    launchSettings([
      '-m',
      'profile-model',
      '-c',
      'model_reasoning_effort="high"',
      '--model=actual-model',
      '--effort=low',
      '--',
      '--model',
      'prompt-text',
    ]),
  ).toEqual({ model: 'actual-model', effort: 'low' })
  expect(
    launchSettings([
      '--config',
      'model="gpt-6"',
      '--config=model_reasoning_effort="xhigh"',
    ]),
  ).toEqual({ model: 'gpt-6', effort: 'xhigh' })
})
async function directory() {
  await mkdir('.tmp', { recursive: true })
  return mkdtemp(resolve('.tmp/instructions-'))
}
test('web instruction edits sync to each runtime file and queue a prompt in the running session', async () => {
  const dir = await directory(),
    typed: string[] = [],
    queue = new InjectionQueue(
      (s) => typed.push(String(s)),
      0,
      () => true,
      false,
    )
  let text = remote('First instructions\n')
  const client = new GildClient(
    'https://forge/api/v1',
    'gf_fixture',
    async () => Response.json(text),
  )
  const sync = new InstructionsSync({
    client,
    target: { owner: 'owner', repo: 'repo', sponsor: 'alice', label: 'codex' },
    directory: dir,
    runtime: 'codex',
    enqueue: (s) => queue.enqueue(s),
  })
  try {
    expect((await sync.check()).state).toBe('synced')
    expect(await readFile(join(dir, 'AGENTS.md'), 'utf8')).toBe(text.text)
    text = remote('Web editor changed these instructions\n')
    await sync.check()
    await new Promise((r) => setTimeout(r, 400))
    expect(await readFile(join(dir, 'AGENTS.md'), 'utf8')).toBe(text.text)
    expect(typed.join('')).toContain('[gild] your instructions changed')
    typed.length = 0
    await sync.check()
    await new Promise((r) => setTimeout(r, 400))
    expect(typed).toHaveLength(0)
    await pullInstructions(dir, 'claude', 'owner/repo', text)
    expect(await readFile(join(dir, 'CLAUDE.md'), 'utf8')).toBe(text.text)
  } finally {
    queue.close()
    await rm(dir, { recursive: true, force: true })
  }
})
test('local edits after sync remain intact and are visible as a conflict', async () => {
  const dir = await directory(),
    target = { owner: 'owner', repo: 'repo', sponsor: 'alice', label: 'codex' },
    prompts: string[] = []
  let text = remote('Initial')
  const sync = new InstructionsSync({
    client: new GildClient('https://forge/api/v1', 'gf_fixture', async () =>
      Response.json(text),
    ),
    target,
    directory: dir,
    runtime: 'codex',
    enqueue: (s) => prompts.push(s),
  })
  try {
    await sync.check()
    prompts.length=0
    await writeFile(join(dir, 'AGENTS.md'), 'Local edit')
    text = remote('New from browser')
    expect((await sync.check()).state).toBe('conflict')
    expect(await readFile(join(dir, 'AGENTS.md'), 'utf8')).toBe('Local edit')
    expect(sync.status?.warning).toContain('Kept locally edited')
    expect(prompts).toHaveLength(0)
    await pullInstructions(dir, 'codex', JSON.stringify(target), text, true)
    await sync.check()
    expect(await readFile(join(dir, 'AGENTS.md'), 'utf8')).toBe(
      'New from browser',
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
test('first sync protects preexisting files and symlinks', async () => {
  const dir = await directory()
  try {
    await writeFile(join(dir, 'AGENTS.md'), 'Existing user instructions')
    expect(
      (await pullInstructions(dir, 'codex', 'owner/repo', remote('Remote')))
        .state,
    ).toBe('conflict')
    await symlink(join(dir, 'AGENTS.md'), join(dir, 'CLAUDE.md'))
    await expect(
      pullInstructions(dir, 'claude', 'owner/repo', remote('Remote')),
    ).rejects.toThrow()
    expect(await readFile(join(dir, 'AGENTS.md'), 'utf8')).toBe(
      'Existing user instructions',
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
test('runtime reports include observed version, model, effort, isolation and host, excluding credentials', async () => {
  const sent: unknown[] = []
  const environment = {
    runtime: 'codex',
    runtime_version: 'codex-cli 1.2.3',
    model: 'gpt-6',
    effort: 'high',
    isolation: 'vm' as const,
    host: 'bugsy',
  }
  const reporter = new StateReporter(
    {
      server: 'https://forge',
      token: 'gf_not_in_payload',
      agent: 'alice/codex',
      owner: 'owner',
      repo: 'repo',
      sha: 'a'.repeat(40),
    },
    'gpt-6',
    async (_url, init) => {
      sent.push(JSON.parse(String(init?.body)))
      return Response.json({ message: 'fixture' }, { status: 500 })
    },
    environment,
  )
  reporter.event({
    session: 'session',
    agent: 'codex',
    type: 'busy',
    ts: new Date().toISOString(),
    raw: { secret: 'gf_not_in_payload' },
  })
  await new Promise((r) => setTimeout(r, 25))
  await reporter.close()
  expect(sent).not.toHaveLength(0)
  expect((sent[0] as { environment: unknown }).environment).toEqual(environment)
  expect(JSON.stringify(sent)).not.toContain('gf_not_in_payload')
})
test('idle runtime heartbeat stays online without falsifying last activity', async () => {
  const sent: { state: { status: string; last_activity: string } }[] = []
  const reporter = new StateReporter(
    {
      server: 'https://forge',
      token: 'gf_fixture',
      agent: 'alice/codex',
      owner: 'owner',
      repo: 'repo',
      sha: 'a'.repeat(40),
    },
    'gpt-6',
    async (_url, init) => {
      sent.push(JSON.parse(String(init?.body)))
      return Response.json({ message: 'fixture' }, { status: 500 })
    },
    undefined,
    200,
  )
  const activity = '2026-10-10T00:00:00Z'
  reporter.snapshot({ state: 'idle', lastActivity: activity })
  await new Promise((r) => setTimeout(r, 1250))
  const live = [...sent]
  await reporter.close()
  expect(live.length).toBeGreaterThanOrEqual(2)
  expect(
    live.every(
      (s) => s.state.status === 'idle' && s.state.last_activity === activity,
    ),
  ).toBe(true)
})

test('instruction sync tells the agent to post silent work notes to its current branch',async()=>{
 const dir=await directory(),prompts:string[]=[]
 let text=remote('Canonical instructions\n')
 const sync=new InstructionsSync({client:new GildClient('https://forge/api/v1','gf_fixture',async()=>Response.json(text)),target:{owner:'owner',repo:'repo',sponsor:'alice',label:'codex'},directory:dir,runtime:'codex',enqueue:p=>prompts.push(p),gild:'gild'})
 try {
  await sync.check();expect(prompts).toHaveLength(1)
  expect(prompts[0]).toContain('chat note owner/repo --channel "$(git branch --show-current)" --agent codex')
  expect(prompts[0]).toContain('never notifies')
  expect(await readFile(join(dir,'AGENTS.md'),'utf8')).toBe(text.text)
  await sync.check();expect(prompts).toHaveLength(1)
  text=remote('Changed canonical instructions\n');await sync.check()
  expect(prompts).toHaveLength(2);expect(prompts[1]).toContain('your instructions changed');expect(prompts[1]).toContain('Work notes:')
 } finally {await rm(dir,{recursive:true,force:true})}
})
