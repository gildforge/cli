import { Command } from 'commander'
import { execFileSync } from 'node:child_process'
import { constants, fstatSync } from 'node:fs'
import { lstat, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { AnchoredDirectory } from './isolation/anchored-fs'
import { configuredEditor, editJsonDefinition } from './configured-editor'
import {
  type AgentPackageManifest,
  type AgentPackageLock,
  type AgentPackageDependency,
  type AgentPackageLockedDependency,
  parseAgentPackageManifest,
  parseAgentPackageLock,
  agentPackageSha256,
  agentPackageInventoryDigest,
  agentPackageInstallPath,
  verifyAgentPackageLock,
  verifyAgentPackageSource,
} from './api/agent-package-contract'

const MAX_FILE = 16 * 1024 * 1024,
  MAX_TOTAL = 64 * 1024 * 1024
const reserved = new Set([
  'agents',
  'runners',
  'vm',
  'identity',
  'identity.json',
  'isolation.json',
  'credentials',
  'system',
  'systemagents',
])
export const defaultPackageRoot = () => join(homedir(), '.config', 'gild')
export function packageDirectory(name: string, root = defaultPackageRoot()) {
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(name) ||
    reserved.has(name.toLowerCase())
  )
    throw Error(
      'Select an immediate named package folder, not a credential/system path',
    )
  return join(root, name)
}
function ownerDirectory(directory: string) {
  const root = AnchoredDirectory.open(resolve(directory))
  if (fstatSync(root.fd).uid !== process.getuid!()) {
    root.close()
    throw Error('Package folder must belong to this user')
  }
  return root
}
function bytes(root: AnchoredDirectory, path: string, max = MAX_FILE) {
  const parent = root.parent(path)
  try {
    return parent.readRegular(basename(path), max)
  } finally {
    if (parent !== root) parent.close()
  }
}
function write(root: AnchoredDirectory, path: string, value: Buffer) {
  const parent = root.parent(path, true)
  try {
    if (!parent.putRegularIfAbsent(basename(path), value))
      throw Error('Generated file collision: ' + path)
  } finally {
    if (parent !== root) parent.close()
  }
}
function removeTree(parent: AnchoredDirectory, path: string) {
  const directory = parent.directory(path)
  try {
    for (const entry of directory.names(4096)) {
      const mode = directory.entryType(entry)!
      if ((mode & constants.S_IFMT) === constants.S_IFDIR)
        removeTree(directory, entry)
      else directory.remove(entry, false)
    }
  } finally {
    directory.close()
  }
  parent.remove(path, true)
}
async function readManifest(directory: string) {
  const root = ownerDirectory(directory)
  try {
    const raw = bytes(root, 'gild.json', 1024 * 1024)
    return { raw, manifest: parseAgentPackageManifest(raw.toString('utf8')) }
  } finally {
    root.close()
  }
}
export async function listPackages(root = defaultPackageRoot()) {
  const packages: { folder: string; manifest: AgentPackageManifest }[] = [],
    warnings: string[] = []
  for (const folder of (
    await readdir(root).catch((e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT') return []
      throw e
    })
  ).sort()) {
    if (folder.startsWith('.') || reserved.has(folder.toLowerCase())) continue
    const path = join(root, folder),
      info = await lstat(path)
    if (!info.isDirectory() || info.isSymbolicLink()) continue
    const manifestFile = await lstat(join(path, 'gild.json')).catch(() => null)
    if (!manifestFile) continue
    try {
      packages.push({ folder, manifest: (await readManifest(path)).manifest })
    } catch {
      warnings.push(`${folder}: invalid or unsafe gild.json`)
    }
  }
  return { packages, warnings }
}
export async function showPackage(directory: string, member?: string) {
  const { manifest } = await readManifest(directory)
  if (!member) return manifest
  const agent = manifest.agents[member]
  if (!agent) throw Error('No declared agent member ' + member)
  return agent
}
export async function editPackage(directory: string) {
  return editJsonDefinition(
    join(directory, 'gild.json'),
    parseAgentPackageManifest,
  )
}

export async function patchPackageMember(
  directory: string,
  member: string,
  opts: Record<string, unknown>,
) {
  const allowed = new Set([
    'member',
    'runtime',
    'model',
    'effort',
    'arg',
    'clearArgs',
  ])
  if (Object.keys(opts).some((key) => !allowed.has(key)))
    throw Error(
      'Package member shortcuts support runtime/model/effort/arg; machine settings and credentials are separate',
    )
  const root = ownerDirectory(directory)
  try {
    const captured = root.readPrivateRegular(
      'gild.json',
      1024 * 1024,
      process.getuid!(),
      false,
    )
    const manifest = parseAgentPackageManifest(captured.data.toString('utf8')),
      agent = manifest.agents[member]
    if (!agent || !('runtime' in agent))
      throw Error(
        'Select an authored inline member; dependency references must be edited at their source',
      )
    manifest.agents[member] = {
      ...agent,
      ...(opts.runtime ? { runtime: opts.runtime as 'codex' } : {}),
      ...(opts.model !== undefined ? { model: opts.model as string } : {}),
      ...(opts.effort !== undefined ? { effort: opts.effort as string } : {}),
      ...(opts.arg
        ? { args: opts.arg as string[] }
        : opts.clearArgs
          ? { args: [] }
          : {}),
    }
    const validated = parseAgentPackageManifest(manifest),
      data = Buffer.from(JSON.stringify(validated, null, 2) + '\n')
    if (
      !root.replacePrivateRegular(
        'gild.json',
        data,
        captured,
        1024 * 1024,
        process.getuid!(),
        false,
      )
    )
      throw Error('Package changed while saving member settings')
  } finally {
    root.close()
  }
}

type Source = {
  entry: AgentPackageLockedDependency
  manifest: AgentPackageManifest
  files: Map<string, Buffer>
  sourceLock?: Buffer
}
export type PackageGitOptions = {
  transportRepository?: (repository: string) => string
}
/** Git performs authentication through its existing configuration; no token is read by this resolver. */
export async function gitPackageSource(
  dependency: AgentPackageDependency,
  temporary: string,
  pin?: string,
  options: PackageGitOptions = {},
): Promise<Source> {
  const repo = await mkdtemp(join(temporary, 'repo-'))
  const git = (args: string[], maximum = MAX_FILE) =>
    execFileSync(
      'git',
      ['--literal-pathspecs', '-c', 'core.hooksPath=/dev/null', ...args],
      {
        cwd: repo,
        maxBuffer: maximum,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
  try {
    git(['init', '--bare', '--quiet'])
    git([
      'remote',
      'add',
      'origin',
      options.transportRepository?.(dependency.repository) ??
        dependency.repository,
    ])
    git([
      'fetch',
      '--quiet',
      '--depth=1',
      '--no-tags',
      'origin',
      pin ?? (dependency.ref === 'latest' ? 'HEAD' : dependency.ref),
    ])
    const commit = git(['rev-parse', 'FETCH_HEAD^{commit}']).toString().trim()
    if (!/^[a-f0-9]{40}$/.test(commit) || (pin && pin !== commit))
      throw Error('Git returned a mismatched commit')
    const prefix = dependency.bundlePath ? dependency.bundlePath + '/' : ''
    const read = (path: string) => {
      const sourcePath = prefix + path
      const tree = git(['ls-tree', '-z', commit, '--', sourcePath]).toString()
      if (
        !/^(100644|100755) blob [a-f0-9]{40}\t/.test(tree) ||
        tree.split('\0').filter(Boolean).length !== 1
      )
        throw Error('Dependency contains a missing or non-plain file')
      return git([
        'show',
        '--no-textconv',
        '--no-ext-diff',
        `${commit}:${sourcePath}`,
      ])
    }
    const raw = read('gild.json'),
      manifest = parseAgentPackageManifest(raw.toString('utf8')),
      files = new Map<string, Buffer>([['gild.json', raw]])
    let total = raw.length
    for (const path of manifest.files) {
      const data = read(path)
      total += data.length
      if (total > MAX_TOTAL)
        throw Error('Dependency exceeds the bounded file inventory')
      files.set(path, data)
    }
    const inventory = await Promise.all(
      [...files]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(async ([path, data]) => ({
          path,
          size: data.length,
          sha256: await agentPackageSha256(data),
        })),
    )
    const entry = {
      ...dependency,
      commit,
      manifestSha256: await agentPackageSha256(raw),
      bundleDigest: await agentPackageInventoryDigest(inventory),
      files: inventory,
    }
    await verifyAgentPackageSource(entry, raw, files)
    const sourceLock = Object.keys(manifest.dependencies).length
      ? read('gild.lock')
      : undefined
    if (sourceLock)
      await verifyAgentPackageLock(raw, sourceLock.toString('utf8'))
    return { entry, manifest, files, sourceLock }
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
}
async function materializedTree(
  source: Source,
  temporary: string,
  options: PackageGitOptions,
  stack = new Set<string>(),
  budget = { packages: 0, bytes: 0 },
): Promise<Map<string, Buffer>> {
  const key =
    source.entry.repository +
    '@' +
    source.entry.commit +
    '/' +
    (source.entry.bundlePath ?? '')
  if (stack.has(key)) throw Error('Dependency cycle detected')
  if (stack.size >= 16 || ++budget.packages > 256)
    throw Error('Dependency graph exceeds its bound')
  const next = new Set(stack)
  next.add(key)
  const tree = new Map(source.files)
  for (const data of tree.values()) {
    budget.bytes += data.length
    if (budget.bytes > MAX_TOTAL)
      throw Error('Materialized graph exceeds its byte bound')
  }
  if (source.sourceLock) {
    const { lock } = await verifyAgentPackageLock(
      source.files.get('gild.json')!,
      source.sourceLock.toString('utf8'),
    )
    tree.set('gild.lock', source.sourceLock)
    for (const [alias, dependency] of Object.entries(lock.dependencies)) {
      const child = await gitPackageSource(
        dependency,
        temporary,
        dependency.commit,
        options,
      )
      await verifyAgentPackageSource(
        dependency,
        child.files.get('gild.json')!,
        child.files,
      )
      const prefix = agentPackageInstallPath(dependency.kind, alias) + '/'
      for (const [path, data] of await materializedTree(
        child,
        temporary,
        options,
        next,
        budget,
      )) {
        const destination = prefix + path
        if (tree.has(destination))
          throw Error('Authored/generated dependency collision')
        tree.set(destination, data)
      }
    }
  }
  return tree
}
function ignore(root: AnchoredDirectory, paths: string[]) {
  const extra = paths.map((p) => '/' + p + '/').join('\n') + '\n'
  if (!root.hasEntry('.gitignore')) {
    if (!root.putRegularIfAbsent('.gitignore', Buffer.from(extra)))
      throw Error('Gitignore changed while preparing private installation')
    return
  }
  const captured = root.readPrivateRegular(
    '.gitignore',
    1024 * 1024,
    process.getuid!(),
    false,
  )
  const existing = captured.data.toString('utf8')
  const additions = extra
    .split('\n')
    .filter((line) => line && !existing.split('\n').includes(line))
  if (
    additions.length &&
    !root.replacePrivateRegular(
      '.gitignore',
      Buffer.from(existing.replace(/\n?$/, '\n') + additions.join('\n') + '\n'),
      captured,
      1024 * 1024,
      process.getuid!(),
      false,
    )
  )
    throw Error(
      'Gitignore changed; installation refused before private bytes were copied',
    )
}
async function installedFiles(root: AnchoredDirectory, target: string) {
  const directory = root.directory(target),
    files = new Map<string, Buffer>()
  const walk = (at: AnchoredDirectory, prefix: string) => {
    for (const name of at.names(4096)) {
      const path = prefix + name,
        mode = at.entryType(name)!
      if ((mode & constants.S_IFMT) === constants.S_IFDIR) {
        const child = at.directory(name)
        try {
          walk(child, path + '/')
        } finally {
          child.close()
        }
      } else {
        if (files.size >= 1025)
          throw Error('Installed inventory exceeds its bound')
        files.set(path, at.readRegular(name, MAX_FILE))
      }
    }
  }
  try {
    walk(directory, '')
    return files
  } finally {
    directory.close()
  }
}

/** Explicit install uses current pins; explicit update alone refreshes mutable references. */
export async function installPackage(
  directory: string,
  update = false,
  options: PackageGitOptions = {},
) {
  directory = resolve(directory)
  const root = ownerDirectory(directory),
    nonce = randomBytes(12).toString('hex'),
    operation = '.gild-operation-' + nonce
  let lease: AnchoredDirectory | undefined, temporary: string | undefined
  let committed = false
  const changes: {
    target: string
    stage: string
    backup?: string
    published: boolean
    expected?: Map<string, Buffer>
    tree: Map<string, Buffer>
  }[] = []
  try {
    // One fixed cooperating operation slot, no new registry or database.
    try {
      lease = root.privateDirectory('.gild-package-operation')
    } catch {
      throw Error(
        'Package operation is already active or needs owner reconciliation',
      )
    }
    const captured = root.readPrivateRegular(
        'gild.json',
        1024 * 1024,
        process.getuid!(),
        false,
      ),
      manifest = parseAgentPackageManifest(captured.data.toString('utf8'))
    let previous: AgentPackageLock | undefined
    if (root.hasEntry('gild.lock'))
      previous = parseAgentPackageLock(
        bytes(root, 'gild.lock', 1024 * 1024).toString('utf8'),
      )
    if (previous && !update)
      await verifyAgentPackageLock(captured.data, previous)
    ignore(root, [
      operation,
      '.gild-package-operation',
      ...Object.entries(manifest.dependencies).map(([alias, dep]) =>
        agentPackageInstallPath(dep.kind, alias),
      ),
    ])
    temporary = join(directory, operation)
    await mkdir(temporary, { mode: 0o700 })
    const entries: AgentPackageLock['dependencies'] = {}
    for (const [alias, dep] of Object.entries(manifest.dependencies)) {
      const target = agentPackageInstallPath(dep.kind, alias),
        old = previous?.dependencies[alias]
      if (old && agentPackageInstallPath(old.kind, alias) !== target)
        throw Error(
          'Changing an installed dependency kind needs explicit removal',
        )
      // Refuse tracked generated content; no private installation is ever staged or pushed.
      try {
        const tracked = execFileSync('git', ['ls-files', '-z', '--', target], {
          cwd: directory,
          stdio: ['ignore', 'pipe', 'ignore'],
        })
        if (tracked.length)
          throw Error('Generated target is tracked in Git: ' + target)
      } catch (e) {
        if (
          (e as NodeJS.ErrnoException).code === undefined &&
          !(e as any).status
        )
          throw e
      }
      const parent = root.parent(target, true)
      if (parent !== root) parent.close()
      const source = await gitPackageSource(
        dep,
        temporary,
        !update ? old?.commit : undefined,
        options,
      )
      for (const [name, agent] of Object.entries(manifest.agents))
        if (
          'dependency' in agent &&
          agent.dependency === alias &&
          !source.manifest.agents[agent.member]
        )
          throw Error('Referenced source agent member does not exist: ' + name)
      const tree = await materializedTree(source, temporary, options)
      let expectedTree: Map<string, Buffer> | undefined
      if (root.hasEntry(target)) {
        if (!old)
          throw Error('Authored or unowned install collision: ' + target)
        const existing = await installedFiles(root, target)
        const originalSource = await gitPackageSource(
          old,
          temporary,
          old.commit,
          options,
        )
        await verifyAgentPackageSource(
          old,
          originalSource.files.get('gild.json')!,
          originalSource.files,
        )
        const expected = await materializedTree(
          originalSource,
          temporary,
          options,
        )
        expectedTree = expected
        if (
          existing.size !== expected.size ||
          [...expected].some(
            ([path, data]) => !existing.get(path)?.equals(data),
          )
        )
          throw Error(
            'Installed file integrity or ownership changed; user files were preserved',
          )
      } else if (old)
        throw Error(
          'Previously owned installation is missing; explicit reconciliation required',
        )
      const stage = '.gild-install-' + randomBytes(12).toString('hex'),
        backup = old
          ? '.gild-backup-' + randomBytes(12).toString('hex')
          : undefined
      ignore(root, [stage, ...(backup ? [backup] : [])])
      const staged = root.privateDirectory(stage)
      try {
        for (const [path, data] of tree) write(staged, path, data)
      } finally {
        staged.close()
      }
      changes.push({
        target,
        stage,
        backup,
        published: false,
        expected: expectedTree,
        tree,
      })
      entries[alias] = source.entry
    }
    if (!bytes(root, 'gild.json', 1024 * 1024).equals(captured.data))
      throw Error('Consumer manifest changed during installation')
    const lock: AgentPackageLock = {
      version: 1,
      manifestSha256: await agentPackageSha256(captured.data),
      dependencies: entries,
    }
    await verifyAgentPackageLock(captured.data, lock)
    for (const change of changes) {
      if (change.expected) {
        const current = await installedFiles(root, change.target)
        if (
          current.size !== change.expected.size ||
          [...change.expected].some(
            ([path, data]) => !current.get(path)?.equals(data),
          )
        )
          throw Error(
            'Installed target changed while dependencies were collected; owner data preserved',
          )
      }
      if (change.backup) root.moveEntry(change.target, change.backup)
      if (!root.publishDirectory(change.stage, change.target))
        throw Error('Install target changed')
      change.published = true
    }
    const lockBytes = Buffer.from(JSON.stringify(lock, null, 2) + '\n')
    if (root.hasEntry('gild.lock')) {
      const old = root.readPrivateRegular(
        'gild.lock',
        1024 * 1024,
        process.getuid!(),
        false,
      )
      if (
        !root.replacePrivateRegular(
          'gild.lock',
          lockBytes,
          old,
          1024 * 1024,
          process.getuid!(),
          false,
        )
      )
        throw Error('Dependency lock changed while installing')
    } else if (!root.putRegularIfAbsent('gild.lock', lockBytes))
      throw Error('Dependency lock appeared while installing')
    committed = true
    for (const change of changes)
      if (change.backup) {
        const backup = await installedFiles(root, change.backup)
        if (
          backup.size !== change.expected!.size ||
          [...change.expected!].some(
            ([path, data]) => !backup.get(path)?.equals(data),
          )
        )
          throw Error('Owner changed the retained backup; it was not deleted')
        removeTree(root, change.backup)
      }
    return lock
  } catch (e) {
    if (committed) throw e
    for (const change of [...changes].reverse()) {
      if (change.published) {
        const current = await installedFiles(root, change.target)
        if (
          current.size !== change.tree.size ||
          [...change.tree].some(
            ([path, data]) => !current.get(path)?.equals(data),
          )
        )
          continue
        removeTree(root, change.target)
      }
      if (change.backup && root.hasEntry(change.backup))
        root.moveEntry(change.backup, change.target)
      if (root.hasEntry(change.stage)) removeTree(root, change.stage)
    }
    throw e
  } finally {
    if (temporary) await rm(temporary, { recursive: true, force: true })
    if (lease) {
      lease.close()
      root.remove('.gild-package-operation', true)
    }
    root.close()
  }
}

export function packageCommands(program: Command) {
  const group = program
    .command('package')
    .description('file/Git agent definitions and explicit dependency pins')
  group
    .command('ls')
    .option('--json')
    .action(async (opts) => {
      const value = await listPackages()
      for (const warning of value.warnings) console.error(warning)
      console.log(
        opts.json
          ? JSON.stringify(value.packages)
          : value.packages
              .map(
                (p) =>
                  p.folder + '\t' + Object.keys(p.manifest.agents).join(','),
              )
              .join('\n'),
      )
    })
  group
    .command('show <name> [member]')
    .action(async (name, member) =>
      console.log(
        JSON.stringify(
          await showPackage(packageDirectory(name), member),
          null,
          2,
        ),
      ),
    )
  group.command('edit <name>').action(async (name) => {
    const result = await editPackage(packageDirectory(name))
    console.log(
      result.changed
        ? 'Updated gild.json'
        : result.cancelled
          ? 'Edit cancelled; gild.json unchanged'
          : 'No definition changes',
    )
  })
  for (const command of ['install', 'update'] as const)
    group.command(`${command} [directory]`).action(async (directory) => {
      const lock = await installPackage(
        resolve(directory ?? process.cwd()),
        command === 'update',
      )
      console.log(JSON.stringify(lock, null, 2))
    })
}
