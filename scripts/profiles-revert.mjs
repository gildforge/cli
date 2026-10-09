import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
mkdirSync('.tmp', { recursive: true })
const cases = [
  [
    'profile-add',
    'src/agent-profiles.ts',
    'await file.writeFile(body)',
    "await file.writeFile('{}')",
    'profile CRUD',
  ],
  [
    'profile-edit',
    'src/agent-profiles.ts',
    'await rename(temp, path)',
    'void path',
    'profile CRUD',
  ],
  [
    'profile-remove',
    'src/agent-profiles.ts',
    'await unlink(profilePath(name))',
    'void name',
    'profile CRUD',
  ],
  [
    'profile-list',
    'src/agent-profiles.ts',
    'console.log(JSON.stringify(profiles))',
    "console.log('[]')",
    'profile CRUD',
  ],
  [
    'profile-token-rejection',
    'src/agent-profiles.ts',
    'z.strictObject({',
    'z.looseObject({',
    'profile files reject tokens',
  ],
  [
    'claude-model',
    'src/spawn-adapters/claude.ts',
    "...(model ? ['--model', model] : [])",
    '...[]',
    'profile runtime flags: claude',
  ],
  [
    'claude-effort',
    'src/spawn-adapters/claude.ts',
    "...(effort ? ['--effort', effort] : [])",
    '...[]',
    'profile runtime flags:',
  ],
  [
    'codex-model',
    'src/spawn-adapters/codex.ts',
    "...(model ? ['-m', model] : [])",
    '...[]',
    'profile runtime flags: codex',
  ],
  [
    'codex-effort',
    'src/spawn-adapters/codex.ts',
    "...(effort\n        ? ['-c', `model_reasoning_effort=${JSON.stringify(effort)}`]\n        : [])",
    '...[]',
    'profile runtime flags: codex',
  ],
  [
    'kimi-model',
    'src/spawn-adapters/index.ts',
    "return model ? ['--model', model] : []",
    'return []',
    'profile runtime flags: kimi',
  ],
  [
    'kimi-effort',
    'src/spawn-adapters/index.ts',
    'if (effort)\n    throw Error(',
    'if (false)\n    throw Error(',
    'profile runtime flags reject',
  ],
  [
    'unknown-passthrough',
    'src/spawn-adapters/index.ts',
    'runtimeFlags.get(basename(runtime))?.(settings) ?? []',
    "runtimeFlags.get(basename(runtime))?.(settings) ?? ['--model', settings.model ?? '']",
    'profile runtime flags: custom',
  ],
  [
    'profile-directory',
    'src/spawn.ts',
    'const cwd = profile?.directory ?? process.cwd()',
    'const cwd = process.cwd()',
    'profile piped spawn',
  ],
  [
    'profile-relative-binary',
    'src/spawn-binary.ts',
    '[resolve(cwd, agent)]',
    '[resolve(agent)]',
    'profile piped spawn',
  ],
  [
    'profile-extra-args',
    'src/agent-profiles.ts',
    '...profile.args,\n      ...extra,',
    '...profile.args,',
    'profile piped spawn',
  ],
  [
    'profile-environment',
    'src/spawn-binary.ts',
    '(allowlist !== undefined && !allowlist.includes(name)) ||',
    'false ||',
    'profile piped spawn',
  ],
  [
    'profile-launch-mapping',
    'src/agent-profiles.ts',
    '...profileArguments(profile.runtime, profile),',
    '...[],',
    'profile PTY: profile$',
  ],
  [
    'profile-repo-cwd',
    'src/gild-main.ts',
    "cwd,\n      encoding: 'utf8',",
    "encoding: 'utf8',",
    'profile PTY: profile$',
  ],
  [
    'profile-identity',
    'src/spawn.ts',
    'const label = profile?.name ?? opts.as',
    'const label = opts.as',
    'profile PTY: profile$',
  ],
  [
    'profile-session-name',
    'src/spawn.ts',
    'profile?.name ??\n          opts.name ??',
    'opts.name ??',
    'profile PTY: profile$',
  ],
  [
    'profile-session-suffix',
    'src/spawn-worker.ts',
    'options.profile && suffix < 999999',
    'false',
    'profile PTY: profile-names',
  ],
  [
    'profile-metadata',
    'src/spawn-worker.ts',
    'profile: options.profile.name,',
    'profile: undefined,',
    'profile PTY: profile$',
  ],
  [
    'profile-channel-seam',
    'src/spawn-worker.ts',
    'channels: options.profile.channels,',
    'channels: undefined,',
    'profile PTY: profile$',
  ],
]
cases.push(
  [
    'profile-local-launch',
    'src/gild-main.ts',
    'if (localProfile) return { agent: agent.name }',
    'if (false) return { agent: agent.name }',
    'profile PTY: profile-local',
  ],
  [
    'profile-linked-identity',
    'src/spawn-worker.ts',
    '{ identity: options.identity }',
    '{ identity: undefined }',
    'profile PTY: profile-local',
  ],
)

for (const [name, file, before, after, test] of cases) {
  const original = readFileSync(file, 'utf8')
  if (!original.includes(before))
    throw Error('Mutation anchor missing: ' + name)
  try {
    writeFileSync(file, original.replace(before, after))
    const result = spawnSync(
      'bun',
      ['test', 'src/agent-profiles.test.ts', '--test-name-pattern', test],
      { encoding: 'utf8', timeout: 30000 },
    )
    writeFileSync('.tmp/revert-' + name + '.log', result.stdout + result.stderr)
    if (result.status === 0) throw Error('Mutation survived: ' + name)
    if (!result.stderr.includes('(fail)'))
      throw Error('No test assertion failed: ' + name)
    console.log(name + ': reverted behavior fails (' + result.status + ')')
  } finally {
    writeFileSync(file, original)
  }
}
