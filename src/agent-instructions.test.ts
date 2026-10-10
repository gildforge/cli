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
const remote = (text: string) => ({
  text,
  revision: createHash('sha256').update(text).digest('hex'),
  history: [],
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
