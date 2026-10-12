import { expect, test } from 'bun:test'
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { CodexCredentialLease, codexFileArgs } from './codex-auth'
import type { Isolation } from './session'

const cache = (value: string) =>
  JSON.stringify({
    auth_mode: 'chatgpt',
    tokens: {
      access_token: 'FAKE-ACCESS-' + value,
      refresh_token: 'FAKE-REFRESH-' + value,
    },
  })
async function fixture(
  run: (f: {
    root: string
    source: string
    work: string
    locks: string
  }) => Promise<void>,
) {
  await mkdir(resolve('.tmp'), { recursive: true, mode: 0o700 })
  const root = await mkdtemp(resolve('.tmp/fake-codex-auth-'))
  const directory = join(root, 'dedicated'),
    work = join(root, 'work'),
    locks = join(root, 'locks')
  for (const dir of [directory, work, locks]) await mkdir(dir, { mode: 0o700 })
  const source = join(directory, 'auth.json')
  await writeFile(source, cache('0'), { mode: 0o600 })
  try {
    await run({ root, source, work, locks })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
function guest() {
  let bytes = Buffer.alloc(0),
    mode = 0
  const calls: { path: string; mode: number }[] = []
  const iso: Isolation = {
    level: 'vm',
    backend: 'fake',
    label: 'fake only',
    guestPath: (p) => p,
    exec: async (argv) => {
      expect(argv.join(' ')).not.toContain('FAKE-')
      return 0
    },
    put: async (path, content, m = 0o600) => {
      calls.push({ path, mode: m })
      bytes = Buffer.from(content)
      mode = m
    },
    files: {
      list: async () => [{ p: 'auth.json', k: 'f', m: mode, s: bytes.length }],
      read: async () => Buffer.from(bytes),
    },
    close: async () => {},
  }
  return {
    iso,
    calls,
    set(value: string) {
      bytes = Buffer.from(value)
    },
    get() {
      return bytes.toString()
    },
  }
}

test('selected Codex source restores then persists updated cache; next lease uses refreshed bytes', () =>
  fixture(async (f) => {
    const g = guest(),
      lease = await CodexCredentialLease.acquire(
        { source: f.source, dedicated: true },
        f.work,
        f.locks,
      )
    await lease.restore(g.iso)
    expect(g.calls).toEqual([{ path: '/root/.codex/auth.json', mode: 0o600 }])
    expect(g.get()).toBe(cache('0'))
    g.set(cache('1'))
    await lease.persist(g.iso)
    expect(await readFile(f.source, 'utf8')).toBe(cache('1'))
    expect((await stat(f.source)).mode & 0o777).toBe(0o600)
    await expect(
      CodexCredentialLease.acquire(
        { source: f.source, dedicated: true },
        f.work,
        f.locks,
      ),
    ).rejects.toThrow('busy')
    await g.iso.close()
    lease.release()
    const second = await CodexCredentialLease.acquire(
      { source: f.source, dedicated: true },
      f.work,
      f.locks,
    )
    const next = guest()
    await second.restore(next.iso)
    expect(next.get()).toBe(cache('1'))
    next.set(cache('2'))
    await second.persist(next.iso)
    await next.iso.close()
    second.release()
    expect(await readFile(f.source, 'utf8')).toBe(cache('2'))
  }))

test('captured-version conflict preserves main cache and leaves only a reconciliation marker', () =>
  fixture(async (f) => {
    const g = guest(),
      lease = await CodexCredentialLease.acquire(
        { source: f.source, dedicated: true },
        f.work,
        f.locks,
      )
    await lease.restore(g.iso)
    g.set(cache('guest-refresh'))
    await writeFile(f.source, cache('owner-new-login'), { mode: 0o600 })
    await expect(lease.persist(g.iso)).rejects.toThrow('reconciliation')
    expect(await readFile(f.source, 'utf8')).toBe(cache('owner-new-login'))
    await expect(
      CodexCredentialLease.acquire(
        { source: f.source, dedicated: true },
        f.work,
        f.locks,
      ),
    ).rejects.toThrow('reconciliation')
    const { readdir } = await import('node:fs/promises')
    const [name] = await readdir(f.locks)
    const marker = await readFile(join(f.locks, name, 'state.json'), 'utf8')
    expect(marker).toContain('requires-reconciliation')
    expect(marker).not.toContain('FAKE-')
  }))

test('lease identity survives atomic source replacement and cannot be stolen by another consumer', () =>
  fixture(async (f) => {
    const lease = await CodexCredentialLease.acquire(
      { source: f.source, dedicated: true },
      f.work,
      f.locks,
    )
    const fresh = join(f.root, 'dedicated/refresh.json')
    await writeFile(fresh, cache('replacement'), { mode: 0o600 })
    await rename(fresh, f.source)
    await expect(
      CodexCredentialLease.acquire(
        { source: f.source, dedicated: true },
        f.work,
        f.locks,
      ),
    ).rejects.toThrow('busy')
    lease.abandon()
    const next = await CodexCredentialLease.acquire(
      { source: f.source, dedicated: true },
      f.work,
      f.locks,
    )
    next.abandon()
  }))

test('lost post-delivery finalization blocks reuse without logging or snapshotting fake credentials', () =>
  fixture(async (f) => {
    const g = guest(),
      lease = await CodexCredentialLease.acquire(
        { source: f.source, dedicated: true },
        f.work,
        f.locks,
      )
    await lease.restore(g.iso)
    g.set(cache('rotation-uncertain'))
    lease.abandon()
    await expect(
      CodexCredentialLease.acquire(
        { source: f.source, dedicated: true },
        f.work,
        f.locks,
      ),
    ).rejects.toThrow('reconciliation')
    expect(await readFile(f.source, 'utf8')).toBe(cache('0'))
  }))

test('private selected source rejects symlinks, hardlinks, broad modes and workspace imports before put', () =>
  fixture(async (f) => {
    const original = join(f.root, 'dedicated/original')
    await rename(f.source, original)
    await symlink(original, f.source)
    await expect(
      CodexCredentialLease.acquire(
        { source: f.source, dedicated: true },
        f.work,
        f.locks,
      ),
    ).rejects.toThrow('unsafe')
    await rm(f.source)
    await rename(original, f.source)
    await link(f.source, original)
    await expect(
      CodexCredentialLease.acquire(
        { source: f.source, dedicated: true },
        f.work,
        f.locks,
      ),
    ).rejects.toThrow('unsafe')
    await rm(original)
    await chmod(f.source, 0o644)
    await expect(
      CodexCredentialLease.acquire(
        { source: f.source, dedicated: true },
        f.work,
        f.locks,
      ),
    ).rejects.toThrow('unsafe')
    await chmod(f.source, 0o600)
    await expect(
      CodexCredentialLease.acquire(
        { source: f.source, dedicated: true },
        join(f.root, 'dedicated'),
        f.locks,
      ),
    ).rejects.toThrow('outside the workspace')
  }))

test('guest cache loss/invalid bytes retains source and blocks the selected stream', () =>
  fixture(async (f) => {
    const g = guest(),
      lease = await CodexCredentialLease.acquire(
        { source: f.source, dedicated: true },
        f.work,
        f.locks,
      )
    await lease.restore(g.iso)
    g.set('FAKE-SECRET malformed JSON')
    let error: unknown
    try {
      await lease.persist(g.iso)
    } catch (e) {
      error = e
    }
    expect(String(error)).toContain('reconciliation')
    expect(String(error)).not.toContain('FAKE-SECRET')
    expect(await readFile(f.source, 'utf8')).toBe(cache('0'))
  }))

test('source is opt-in, rejects API-key caches and rejects unbounded file capture', () =>
  fixture(async (f) => {
    await expect(
      CodexCredentialLease.acquire(
        { source: f.source, dedicated: false } as any,
        f.work,
        f.locks,
      ),
    ).rejects.toThrow()
    await writeFile(
      f.source,
      JSON.stringify({ OPENAI_API_KEY: 'FAKE-API-KEY' }),
      { mode: 0o600 },
    )
    await expect(
      CodexCredentialLease.acquire(
        { source: f.source, dedicated: true },
        f.work,
        f.locks,
      ),
    ).rejects.toThrow('unsupported API-key')
    await writeFile(f.source, Buffer.alloc(65537), { mode: 0o600 })
    await expect(
      CodexCredentialLease.acquire(
        { source: f.source, dedicated: true },
        f.work,
        f.locks,
      ),
    ).rejects.toThrow('unsafe')
  }))

test('selected cache refuses conflicting keyring/auto arguments while retaining public native arguments', () => {
  expect(codexFileArgs(['exec', 'a public task'])).toEqual([
    '-c',
    'cli_auth_credentials_store="file"',
    'exec',
    'a public task',
  ])
  expect(() =>
    codexFileArgs(['-c', 'cli_auth_credentials_store="keyring"']),
  ).toThrow('conflicting')
  expect(() =>
    codexFileArgs(['--config=cli_auth_credentials_store="auto"']),
  ).toThrow('conflicting')
})

test(
  'actual VM caller restores fake cache before PTY and persists refresh before close, outside workspace',
  () =>
    fixture(async (f) => {
      const script = join(f.root, 'caller.ts')
      await writeFile(join(f.work, 'codex'), '#!/bin/sh\n', { mode: 0o700 })
      await writeFile(
        script,
        `
import {mock} from 'bun:test';import {readFile,writeFile} from 'node:fs/promises';
const source=${JSON.stringify(f.source)},work=${JSON.stringify(f.work)};
const original=await readFile(source,'utf8'),updated=${JSON.stringify(cache('caller-refreshed'))};
let guestAuth='',restored=false,closed=false;const calls:any[]=[];
const {hostManifest}=await import(${JSON.stringify(resolve('src/isolation/sync.ts'))});const baseline=await hostManifest(work);
const iso:any={level:'vm',backend:'fake',label:'fake only',guestPath:(p:string)=>p,onGuestMessage(){},exec:async()=>0,
put:async(path:string,content:string,mode:number)=>{calls.push({path,mode});if(path==='/root/.codex/auth.json'){guestAuth=content;restored=content===original}},
files:{list:async(path:string)=>path==='/root/.codex'?[{p:'auth.json',k:'f',m:384,s:Buffer.byteLength(guestAuth)}]:[...baseline.values()],read:async(path:string)=>path==='/root/.codex/auth.json'?Buffer.from(guestAuth):await readFile(work+'/'+path.slice('/workspace/'.length))},
pty:async(request:any)=>{if(!restored)throw Error('production caller omitted credential restore');if(request.env.CODEX_HOME!=='/root/.codex'||request.argv.join(' ').includes('FAKE-'))throw Error('credential leaked into argv or wrong residence');guestAuth=updated;return{write(){},resize(){},onData(){},onExit(){},close(){}}},
close:async()=>{if(await readFile(source,'utf8')!==updated)throw Error('cache not persisted before close');closed=true}};
mock.module(${JSON.stringify(resolve('src/isolation'))},()=>({prepareVm:async()=>({host:{vm:{codexAuth:{source,dedicated:true}}}}),vmAvailable:()=>true,vmBackend:()=> 'firecracker',startVm:async()=>iso}));
const {startVmChild}=await import(${JSON.stringify(resolve('src/spawn-vm.ts'))});
const child=await startVmChild({configDir:'fake',sessionId:'fake',cwd:work,binary:work+'/codex',args:['--version'],env:{HOME:'/root',PATH:'/usr/bin:/bin'},cols:80,rows:24});
await child.dispose();if(!closed)throw Error('VM not closed');
await writeFile(${JSON.stringify(join(f.root, 'caller-result.json'))},JSON.stringify({restored,closed,calls,sourceUpdated:await readFile(source,'utf8')===updated}));
`,
      )
      const child = Bun.spawn([process.execPath, 'run', script], {
        cwd: f.work,
        env: { HOME: f.root, PATH: process.env.PATH! },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [code, error] = await Promise.all([
        child.exited,
        new Response(child.stderr).text(),
      ])
      expect({ code, error }).toEqual({ code: 0, error: '' })
      const result = JSON.parse(
        await readFile(join(f.root, 'caller-result.json'), 'utf8'),
      )
      expect(result.restored).toBe(true)
      expect(result.closed).toBe(true)
      expect(result.sourceUpdated).toBe(true)
      expect(result.calls[0]).toEqual({
        path: '/root/.codex/auth.json',
        mode: 0o600,
      })
    }),
  15000,
)
