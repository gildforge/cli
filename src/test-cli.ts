import { generateKeyPairSync } from 'node:crypto'
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'

export function testIdentity(apiToken: unknown = null) {
  const keys = generateKeyPairSync('ed25519')
  return {
    schema: 1,
    name: 'alice',
    device: 'test',
    apiToken,
    publicKey:
      'ed25519:' +
      keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    secretKey: keys.privateKey
      .export({ format: 'der', type: 'pkcs8' })
      .toString('base64'),
    createdAt: new Date().toISOString(),
  }
}
export async function fixture(
  handler: (request: Request) => Response | Promise<Response>,
) {
  await mkdir(resolve('.tmp'), { recursive: true })
  const root = await mkdtemp(join(resolve('.tmp'), 'cli-review-'))
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: handler })
  const origin = server.url.origin
  return {
    root,
    origin,
    async identity(
      token: unknown = { server: origin, token: 'gf_fixturetoken' },
    ) {
      const identity = testIdentity(token)
      await writeFile(join(root, 'identity.json'), JSON.stringify(identity), {
        mode: 0o600,
      })
      return identity
    },
    async agent(token: string | null = 'gf_agentfixture') {
      await mkdir(join(root, 'agents'), { recursive: true })
      const agent = {
        ...testIdentity(),
        name: 'alice/test',
        server: origin,
        token,
        requestId: 'request-1',
      }
      await writeFile(join(root, 'agents/test.json'), JSON.stringify(agent), {
        mode: 0o600,
      })
      return agent
    },
    async close() {
      server.stop(true)
      await rm(root, { recursive: true, force: true })
    },
  }
}
export function startCLI(root: string, args: string[], stdin?: string) {
  return Bun.spawn(
    [
      process.execPath,
      'run',
      resolve('src/gild.ts'),
      '--config-dir',
      root,
      ...args,
    ],
    {
      stdin: stdin === undefined ? 'ignore' : new Blob([stdin]),
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
}
export async function cli(root: string, args: string[], stdin?: string) {
  const proc = startCLI(root, args, stdin)
  const timeout = setTimeout(() => proc.kill('SIGTERM'), 10000)
  try {
    const [code, out, err] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    return { code, out, err }
  } finally {
    clearTimeout(timeout)
  }
}
