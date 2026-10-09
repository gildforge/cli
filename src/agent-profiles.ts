import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  unlink,
} from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import { Command } from 'commander'
import { z } from 'zod'

// Runtime settings only. Scoped tokens stay in the existing identity store.
const nameSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,23}$/)
const text = z
  .string()
  .min(1)
  .refine((s) => !s.includes('\0'))
export const profileSchema = z.strictObject({
  name: nameSchema,
  runtime: text,
  model: text.optional(),
  effort: text.optional(),
  directory: text.refine(isAbsolute),
  args: z.array(z.string().refine((s) => !s.includes('\0'))).default([]),
  env: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)).optional(),
  channels: z
    .array(z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/))
    .optional(),
})
export type AgentProfile = z.infer<typeof profileSchema>
export const profilesDirectory = () => join(homedir(), '.gild', 'agents')
function profilePath(name: string) {
  if (!nameSchema.safeParse(name).success)
    throw Error(
      'Agent profile name must be 1–24 letters, digits, underscores or hyphens',
    )
  return join(profilesDirectory(), name + '.json')
}
async function privateDirectory() {
  for (const path of [join(homedir(), '.gild'), profilesDirectory()]) {
    await mkdir(path, { mode: 0o700 }).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== 'EEXIST') throw e
    })
    const info = await lstat(path)
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      info.uid !== process.getuid?.()
    )
      throw Error('Unsafe local agent profile directory')
    await chmod(path, 0o700)
  }
}
export function parseProfile(value: unknown): AgentProfile {
  const result = profileSchema.safeParse(value)
  if (!result.success)
    throw Error(
      'Invalid agent profile: only name, runtime, model, effort, directory, args, env and channels are allowed; credentials belong in the identity store',
    )
  return result.data
}
export async function loadProfile(name: string): Promise<AgentProfile> {
  const path = profilePath(name)
  await privateDirectory()
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  ).catch((e: NodeJS.ErrnoException) => {
    if (e.code === 'ENOENT')
      throw Error(`No local agent profile ${name}; use gild agent add ${name}`)
    throw e
  })
  try {
    const info = await file.stat()
    if (
      !info.isFile() ||
      info.uid !== process.getuid?.() ||
      info.size > 64 * 1024
    )
      throw Error('Unsafe local agent profile file')
    await file.chmod(0o600)
    let value: unknown
    try {
      value = JSON.parse(await file.readFile('utf8'))
    } catch {
      throw Error('Invalid agent profile JSON')
    }
    const profile = parseProfile(value)
    if (profile.name !== name)
      throw Error('Agent profile name differs from its filename')
    return profile
  } finally {
    await file.close()
  }
}
export async function saveProfile(value: unknown, create = false) {
  const profile = parseProfile(value)
  const path = profilePath(profile.name)
  await privateDirectory()
  const body = JSON.stringify(profile, null, 2) + '\n'
  if (Buffer.byteLength(body) > 64 * 1024)
    throw Error('Agent profile exceeds 64 KiB')
  if (create) {
    const file = await open(path, 'wx', 0o600).catch(
      (e: NodeJS.ErrnoException) => {
        if (e.code === 'EEXIST')
          throw Error(
            `Agent profile ${profile.name} already exists; use gild agent edit`,
          )
        throw e
      },
    )
    try {
      await file.writeFile(body)
    } finally {
      await file.close()
    }
  } else {
    await loadProfile(profile.name)
    const temp = path + '.' + randomBytes(6).toString('hex') + '.tmp'
    try {
      const file = await open(temp, 'wx', 0o600)
      try {
        await file.writeFile(body)
      } finally {
        await file.close()
      }
      await rename(temp, path)
    } finally {
      await unlink(temp).catch(() => {})
    }
  }
}
export async function resolveProfile(name: string, extra: string[]) {
  const profile = await loadProfile(name)
  const { stat } = await import('node:fs/promises')
  const directory = await stat(profile.directory).catch(() => null)
  if (!directory?.isDirectory())
    throw Error(
      `Agent profile ${name} directory does not exist or is not a directory: ${profile.directory}`,
    )
  const { profileArguments } = await import('./spawn-adapters')
  return {
    profile,
    args: [
      ...profileArguments(profile.runtime, profile),
      ...profile.args,
      ...extra,
    ],
  }
}
const collect = (value: string, previous: string[] = []) => [...previous, value]
export function profileCommands(agent: Command) {
  for (const verb of ['add', 'edit'] as const) {
    agent
      .command(`${verb} <name>`)
      .description(
        `${verb} a local runtime profile (credentials are stored separately)`,
      )
      .option('--runtime <command>', 'native runtime or executable')
      .option('--model <model>', 'native model ID; empty clears it')
      .option('--effort <effort>', 'native reasoning effort; empty clears it')
      .option(
        '--dir <directory>',
        'working directory, resolved to an absolute path',
      )
      .option(
        '--arg <argument>',
        'extra native argument; repeat to replace args',
        collect,
      )
      .option(
        '--env <name>',
        'inherit only these environment variable names; repeat',
        collect,
      )
      .option(
        '--channel <owner/repo>',
        'reserved channel mention subscription; repeat',
        collect,
      )
      .option('--clear-args', 'clear native arguments')
      .option('--clear-env', 'restore normal environment inheritance')
      .option('--clear-channels', 'clear reserved channels')
      .option('--file <json>', 'read a complete, credential-free profile JSON')
      .action(async (name: string, opts) => {
        profilePath(name)
        if (opts.file) {
          if (Object.keys(opts).some((key) => key !== 'file'))
            throw Error('--file cannot be combined with profile field options')
          let value: unknown
          try {
            value = JSON.parse(await readFile(opts.file, 'utf8'))
          } catch {
            throw Error('Cannot read profile JSON')
          }
          const profile = parseProfile(value)
          if (profile.name !== name)
            throw Error('Agent profile name differs from the command name')
          await saveProfile(profile, verb === 'add')
          return
        }
        const previous =
          verb === 'edit' ? await loadProfile(name) : { name, args: [] }
        await saveProfile(
          {
            ...previous,
            ...(opts.runtime !== undefined ? { runtime: opts.runtime } : {}),
            ...(opts.dir !== undefined ? { directory: resolve(opts.dir) } : {}),
            ...(opts.model !== undefined
              ? { model: opts.model || undefined }
              : {}),
            ...(opts.effort !== undefined
              ? { effort: opts.effort || undefined }
              : {}),
            ...(opts.arg
              ? { args: opts.arg }
              : opts.clearArgs
                ? { args: [] }
                : {}),
            ...(opts.env
              ? { env: opts.env }
              : opts.clearEnv
                ? { env: undefined }
                : {}),
            ...(opts.channel
              ? { channels: opts.channel }
              : opts.clearChannels
                ? { channels: undefined }
                : {}),
          },
          verb === 'add',
        )
      })
  }
  agent
    .command('rm <name>')
    .description('remove a local runtime profile; keep approved credentials')
    .action(async (name: string) => {
      await loadProfile(name)
      await unlink(profilePath(name))
    })
  agent
    .command('ls')
    .description('list local runtime profiles')
    .option('--json', 'print profiles as JSON')
    .action(async (opts) => {
      await privateDirectory()
      const profiles: AgentProfile[] = []
      for (const entry of (await readdir(profilesDirectory())).sort()) {
        if (entry.endsWith('.json'))
          profiles.push(await loadProfile(entry.slice(0, -5)))
      }
      if (opts.json) console.log(JSON.stringify(profiles))
      else {
        console.log('NAME\tRUNTIME\tMODEL\tEFFORT\tDIRECTORY')
        for (const p of profiles)
          console.log(
            [
              p.name,
              p.runtime,
              p.model ?? '',
              p.effort ?? '',
              p.directory,
            ].join('\t'),
          )
      }
    })
}
