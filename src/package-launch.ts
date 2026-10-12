import { randomBytes } from 'node:crypto'
import { fstatSync } from 'node:fs'
import { basename, join } from 'node:path'
import { AnchoredDirectory } from './isolation/anchored-fs'
import { ignorePackagePaths } from './agent-packages'
import { profileArguments } from './spawn-adapters'
import { readPinnedSourceLock } from './package-git-proof'
import {
  parseAgentPackageManifest,
  verifyAgentPackageLock,
  verifyAgentPackageSource,
  agentPackageInstallPath,
  type AgentPackageManifest,
  type AgentPackageLock,
  type AgentPackageLockedDependency,
} from './api/agent-package-contract'

type Inline = Extract<
  AgentPackageManifest['agents'][string],
  { runtime: string }
>
type Loaded = {
  prefix: string
  manifest: AgentPackageManifest
  files: Map<string, Buffer>
  lock?: AgentPackageLock
}
export type PackageLaunch = {
  agent: Inline
  instructions?: Buffer
  assets: Map<string, Buffer>
  skills: Map<string, Buffer>[]
}

/** Read only declared bytes/exact locks: local Git proof checks, no network/scan/fetch. */
export async function resolvePackageLaunch(
  directory: string,
  member: string,
): Promise<PackageLaunch> {
  const root = AnchoredDirectory.open(directory)
  let total = 0,
    count = 0
  const read = (path: string) => {
    const parent = root.parent(path)
    try {
      const data = parent.readRegular(basename(path), 16 * 1024 * 1024)
      total += data.length
      if (total > 64 * 1024 * 1024)
        throw Error('Launch package bytes exceed bound')
      return data
    } finally {
      if (parent !== root) parent.close()
    }
  }
  const load = async (
    prefix: string,
    entry?: AgentPackageLockedDependency,
  ): Promise<Loaded> => {
    if (++count > 256 || prefix.split('/').length > 64)
      throw Error('Launch dependency graph exceeds bound')
    const raw = read(prefix + 'gild.json'),
      manifest = parseAgentPackageManifest(raw.toString('utf8'))
    const files = new Map<string, Buffer>([['gild.json', raw]])
    for (const path of manifest.files) files.set(path, read(prefix + path))
    if (entry) await verifyAgentPackageSource(entry, raw, files)
    let lock: AgentPackageLock | undefined
    if (Object.keys(manifest.dependencies).length) {
      const installed = read(prefix + 'gild.lock')
      if (entry && !readPinnedSourceLock(directory, entry).equals(installed))
        throw Error('Installed source lock differs from its pinned Git commit')
      lock = (await verifyAgentPackageLock(raw, installed.toString('utf8')))
        .lock
    }
    return { prefix, manifest, files, lock }
  }
  const dependency = async (parent: Loaded, alias: string) => {
    const entry = parent.lock?.dependencies[alias]
    if (!entry) throw Error('Missing exact installed dependency lock: ' + alias)
    return load(
      parent.prefix + agentPackageInstallPath(entry.kind, alias) + '/',
      entry,
    )
  }
  const collect = async (source: Loaded): Promise<Map<string, Buffer>> => {
    const files = new Map(source.files)
    for (const [alias, entry] of Object.entries(
      source.lock?.dependencies ?? {},
    )) {
      const child = await dependency(source, alias)
      for (const [path, data] of await collect(child))
        files.set(agentPackageInstallPath(entry.kind, alias) + '/' + path, data)
    }
    return files
  }
  try {
    if (fstatSync(root.fd).uid !== process.getuid!())
      throw Error('Package must belong to this user')
    let source = await load(''),
      agent = source.manifest.agents[member]
    while (agent && 'dependency' in agent) {
      source = await dependency(source, agent.dependency)
      agent = source.manifest.agents[agent.member]
    }
    if (!agent || !('runtime' in agent))
      throw Error('No declared package agent member ' + member)
    const skills: Map<string, Buffer>[] = []
    for (const alias of agent.skills ?? []) {
      const skill = await dependency(source, alias)
      if (!skill.files.has('SKILL.md'))
        throw Error('Selected native skill needs a declared SKILL.md')
      skills.push(await collect(skill))
    }
    return {
      agent,
      instructions: agent.instructions
        ? source.files.get(agent.instructions)
        : undefined,
      assets: new Map(
        (agent.assets ?? []).map((path) => [path, source.files.get(path)!]),
      ),
      skills,
    }
  } finally {
    root.close()
  }
}

/** An owned workspace registration; changed/extra/replaced data is retained, never erased. */
function stage(
  root: AnchoredDirectory,
  path: string,
  files: Map<string, Buffer>,
) {
  let ancestor = root
  const opened: AnchoredDirectory[] = []
  try {
    for (const name of path.split('/').slice(0, -1)) {
      ancestor = ancestor.directory(name, true)
      opened.push(ancestor)
      const info = fstatSync(ancestor.fd)
      if (info.uid !== process.getuid!() || info.mode & 0o022)
        throw Error('Unsafe native package discovery directory')
    }
  } finally {
    for (const directory of opened.reverse()) directory.close()
  }
  const parent = root.parent(path, true),
    name = basename(path)
  const slot = parent.privateDirectory(name)
  const walk = (
    directory: AnchoredDirectory,
    prefix: string,
    remove: boolean,
  ) => {
    const names = [
      ...new Set(
        [...files.keys()]
          .filter((p) => p.startsWith(prefix))
          .map((p) => p.slice(prefix.length).split('/')[0]),
      ),
    ].sort()
    if (JSON.stringify(directory.names(4096)) !== JSON.stringify(names))
      throw Error('Package launch registration changed; retained')
    for (const name of names) {
      const key = prefix + name,
        value = files.get(key)
      if (value) {
        if (!directory.readRegular(name, value.length).equals(value))
          throw Error('Package launch bytes changed; retained')
        if (remove) directory.remove(name, false)
      } else {
        const child = directory.directory(name)
        try {
          walk(child, key + '/', remove)
        } finally {
          child.close()
        }
        if (remove) directory.remove(name, true)
      }
    }
  }
  try {
    for (const [key, value] of files) {
      const directory = slot.parent(key, true)
      try {
        if (!directory.putRegularIfAbsent(basename(key), value))
          throw Error('Package launch staging collision')
      } finally {
        if (directory !== slot) directory.close()
      }
    }
    let closed = false
    return () => {
      if (closed) return
      closed = true
      try {
        const now = parent.directory(name)
        try {
          const a = fstatSync(now.fd),
            b = fstatSync(slot.fd)
          if (a.dev !== b.dev || a.ino !== b.ino)
            throw Error('Package launch directory replaced; retained')
        } finally {
          now.close()
        }
        walk(slot, '', false)
        walk(slot, '', true)
        parent.remove(name, true)
      } finally {
        slot.close()
        if (parent !== root) parent.close()
      }
    }
  } catch (error) {
    slot.close()
    if (parent !== root) parent.close()
    throw error
  }
}

export function preparePackageLaunch(
  selection: PackageLaunch,
  cwd: string,
  extra: string[],
) {
  const { agent } = selection
  if (
    agent.runtime === 'kimi' &&
    (selection.instructions || selection.skills.length || selection.assets.size)
  )
    throw Error(
      'Kimi package instructions/skills/assets delivery is not supported; no unskilled fallback',
    )
  let instructions = selection.instructions
    ? new TextDecoder('utf-8', { fatal: true }).decode(selection.instructions)
    : undefined
  if (instructions && Buffer.byteLength(instructions) > 64 * 1024)
    throw Error('Package instructions exceed 64 KiB')
  const root = AnchoredDirectory.open(cwd),
    closers: (() => void)[] = []
  const closeAll = () => {
    let failure: unknown
    for (const close of closers.reverse()) {
      try {
        close()
      } catch (error) {
        failure ??= error
      }
    }
    if (failure) throw failure
  }
  const nonce = randomBytes(12).toString('hex'),
    run = '.gild-package-run-' + nonce
  const skillPaths = selection.skills.map(
    (_, index) =>
      `${agent.runtime === 'claude' ? '.claude' : '.agents'}/skills/gild-package-${nonce}-${index}`,
  )
  try {
    const info = fstatSync(root.fd)
    if (info.uid !== process.getuid!() || info.mode & 0o022)
      throw Error(
        'Package launch workspace must be owned and not writable by others',
      )
    ignorePackagePaths(root, [run, ...skillPaths])
    const authored = new Map(
      [...selection.assets].map(([path, data]) => ['assets/' + path, data]),
    )
    if (selection.instructions)
      authored.set('gild-instructions.md', selection.instructions)
    if (authored.size) closers.push(stage(root, run, authored))
    for (const [index, files] of selection.skills.entries())
      closers.push(stage(root, skillPaths[index], files))
    if (selection.assets.size)
      instructions =
        (instructions ?? '') +
        '\nPackage assets:\n' +
        [...selection.assets.keys()]
          .map((p) => join(run, 'assets', p))
          .join('\n')
    const args = [
      ...profileArguments(agent.runtime, agent),
      ...(agent.args ?? []),
      ...extra,
    ]
    if (instructions)
      args.unshift(
        ...(agent.runtime === 'codex'
          ? ['-c', `developer_instructions=${JSON.stringify(instructions)}`]
          : ['--append-system-prompt', instructions]),
      )
    if (args.some((arg) => Buffer.byteLength(arg) > 120 * 1024))
      throw Error('Package native argument exceeds launch bound')
    let closed = false
    return {
      args,
      close() {
        if (closed) return
        closed = true
        try {
          closeAll()
        } finally {
          root.close()
        }
      },
    }
  } catch (error) {
    try {
      closeAll()
    } finally {
      root.close()
    }
    throw error
  }
}
