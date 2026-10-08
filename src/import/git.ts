import { lookup } from 'node:dns/promises'
import { publicAddress } from '../public-address'
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
export interface Credential {
  url: string
  token: string
}
export interface GitTransport {
  source: string
  resolveHost?(hostname: string): Promise<string[]>
  sourceToken?: string
  directory: string
  signal: AbortSignal
  credentials(): Promise<Credential>
  progress(message: string, completed?: number): void
}
/** Git packs stay on disk and stream straight to the scoped Gild Git endpoint.
 * No shell, embedded passwords, token-bearing argv, or Worker pack buffering. */
export class NativeImport {
  private addresses: string[] = []
  private metaBranch = 'import/source/_meta'
  private pullPrefix = 'import/pr'
  branch(ref: string) {
    return ref === '_meta' ? this.metaBranch : ref
  }
  constructor(readonly options: GitTransport) {}
  async git(args: string[], credential?: Credential, allowFailure = false) {
    const o = this.options,
      settings: Record<string, string> = {
        'http.followRedirects': 'false',
        'protocol.allow': 'never',
        'protocol.https.allow': 'always',
        'protocol.http.allow': 'always',
        'protocol.ssh.allow': 'always',
        'pack.windowMemory': '32m',
        'pack.deltaCacheSize': '16m',
        'pack.threads': '1',
      }
    if (this.addresses.length) {
      const source = new URL(o.source)
      if (source.protocol !== 'ssh:')
        settings['http.curloptResolve'] =
          `${source.hostname}:${source.port || (source.protocol === 'https:' ? '443' : '80')}:${this.addresses.map((ip) => (ip.includes(':') ? '[' + ip + ']' : ip)).join(',')}`
    }
    if (o.sourceToken)
      settings[`http.${o.source}.extraHeader`] =
        'Authorization: Basic ' +
        Buffer.from(`oauth2:${o.sourceToken}`).toString('base64')
    if (credential)
      settings[`http.${credential.url}.extraHeader`] =
        'Authorization: Bearer ' + credential.token
    const env = {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_COUNT: String(Object.keys(settings).length),
    } as NodeJS.ProcessEnv
    if (this.addresses.length && new URL(o.source).protocol === 'ssh:') {
      const source = new URL(o.source)
      env.GIT_SSH_COMMAND = `ssh -o HostName=${this.addresses[0]} -o HostKeyAlias=${source.hostname} -o ProxyCommand=none -o BatchMode=yes`
    }
    Object.entries(settings).forEach(([key, value], i) => {
      env[`GIT_CONFIG_KEY_${i}`] = key
      env[`GIT_CONFIG_VALUE_${i}`] = value
    })
    return new Promise<string | null>((resolve, reject) => {
      const child = spawn('git', ['--git-dir=' + o.directory, ...args], {
        env,
        signal: o.signal,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let output = '',
        overflow = false,
        stderr = ''
      child.stdout.on('data', (chunk) => {
        if (output.length + chunk.length > 16 * 1024 * 1024) {
          overflow = true
          child.kill('SIGTERM')
        } else output += chunk.toString()
      })
      child.stderr.on('data', (chunk) => {
        stderr = (stderr + chunk.toString()).slice(-4096)
        const progress = /Receiving objects:\s+(\d+)%/.exec(stderr)
        if (progress) o.progress('Receiving Git objects', Number(progress[1]))
      })
      child.on('error', () =>
        reject(
          Error(
            o.signal.aborted
              ? 'Import cancelled; run repo resume to continue'
              : 'Could not start Git',
          ),
        ),
      )
      child.on('close', (code) => {
        if (overflow)
          reject(Error('Git response exceeded the import ref limit'))
        else if (code === 0) resolve(output.trim())
        else if (allowFailure) resolve(null)
        else
          reject(
            Error(
              'Git transfer failed; check source access and retry the import',
            ),
          )
      })
    })
  }
  async fetch() {
    const o = this.options
    const source = new URL(o.source),
      addresses = await (
        o.resolveHost ??
        (async (hostname) =>
          (await lookup(hostname, { all: true })).map(
            (answer) => answer.address,
          ))
      )(source.hostname)
    if (
      !addresses.length ||
      addresses.some((address) => !publicAddress(address))
    )
      throw Error('Source DNS must resolve exclusively to public addresses')
    this.addresses = addresses
    await mkdir(o.directory, { recursive: true, mode: 0o700 })
    const config = await readFile(join(o.directory, 'config'), 'utf8').catch(
      () => null,
    )
    if (!config) {
      await this.git(['init', '--bare'])
      await this.git(['remote', 'add', 'origin', o.source])
    } else if (
      (await this.git(['config', '--get', 'remote.origin.url'])) !== o.source
    )
      throw Error('Cached import belongs to another source')
    o.progress('Fetching all branches, tags, and full history')
    await this.git([
      'fetch',
      '--prune',
      '--force',
      'origin',
      '+refs/heads/*:refs/heads/*',
      '+refs/tags/*:refs/tags/*',
    ])
    const head = await this.git(['ls-remote', '--symref', 'origin', 'HEAD'])
    const branch = /ref: refs\/heads\/(.+)\tHEAD/.exec(head ?? '')?.[1]
    if (branch) await this.git(['symbolic-ref', 'HEAD', 'refs/heads/' + branch])
    return branch ?? 'main'
  }
  async refs() {
    const text = await this.git([
      'for-each-ref',
      '--format=%(objectname) %(refname)',
      'refs/heads',
      'refs/tags',
    ])
    return (text ? text.split('\n') : []).map((line) => {
      const [oid, ref] = line.split(' ')
      return { oid, ref }
    })
  }
  async push() {
    const o = this.options,
      refs = await this.refs(),
      sourceMeta = refs.find((r) => r.ref === 'refs/heads/_meta')
    let reserved = 'refs/heads/import/source/_meta'
    while (refs.some((r) => r.ref === reserved)) reserved += '_'
    this.metaBranch = reserved.replace('refs/heads/', '')
    this.pullPrefix = 'import/pr'
    while (
      refs.some(
        (r) =>
          r.ref === 'refs/heads/' + this.pullPrefix ||
          r.ref.startsWith('refs/heads/' + this.pullPrefix + '/'),
      )
    )
      this.pullPrefix += '_'
    const expected = refs.map((r) => ({
      ...r,
      ref: r === sourceMeta ? reserved : r.ref,
    }))
    const target = await o.credentials()
    // Never persist the scoped credential in Git config or the remote URL.
    const old = await this.git(['ls-remote', '--refs', target.url], target)
    const existing = (old ? old.split('\n') : []).map(
      (line) => line.split(/\s+/)[1],
    )
    const deletions = existing
      .filter(
        (ref) =>
          (ref.startsWith('refs/heads/') || ref.startsWith('refs/tags/')) &&
          ref !== 'refs/heads/_meta' &&
          !ref.startsWith('refs/heads/' + this.pullPrefix + '/') &&
          !expected.some((r) => r.ref === ref),
      )
      .map((ref) => ':' + ref)
    const specs = [
      ...refs.map((r, i) => `+${r.ref}:${expected[i].ref}`),
      ...deletions,
    ]
    for (let offset = 0; offset < specs.length; offset += 100) {
      o.progress('Streaming Git refs to gild', offset)
      const credential = await o.credentials()
      await this.git(
        [
          'push',
          '--force',
          credential.url,
          ...specs.slice(offset, offset + 100),
        ],
        credential,
      )
    }
    const credential = await o.credentials(),
      remote = await this.git(
        ['ls-remote', '--refs', credential.url],
        credential,
      )
    const copied = new Map(
      (remote ? remote.split('\n') : []).map((line) => {
        const [oid, ref] = line.split(/\s+/)
        return [ref, oid]
      }),
    )
    if (
      expected.some((r) => copied.get(r.ref) !== r.oid) ||
      deletions.some((r) => copied.has(r.slice(1)))
    )
      throw Error('Destination Git refs did not match the source')
    o.progress('Verified every branch and tag', expected.length)
    return {
      branches: refs.filter((r) => r.ref.startsWith('refs/heads/')).length,
      tags: refs.filter((r) => r.ref.startsWith('refs/tags/')).length,
      commits: Number(await this.git(['rev-list', '--count', '--all'])),
    }
  }
  async head(ref: string, number: number) {
    if (!/^refs\/(pull|merge-requests)\/[1-9][0-9]*\/head$/.test(ref))
      throw Error('Invalid source pull request ref')
    const head = `${this.pullPrefix}/${number}`
    if (
      (await this.git(
        ['fetch', '--force', 'origin', `+${ref}:refs/heads/${head}`],
        undefined,
        true,
      )) === null
    )
      return null
    const credentials = await this.options.credentials()
    await this.git(
      [
        'push',
        '--force',
        credentials.url,
        `refs/heads/${head}:refs/heads/${head}`,
      ],
      credentials,
    )
    return head
  }
  async workflows(branch: string): Promise<{ file: string; text: string }[]> {
    const tree = await this.git(
      [
        'ls-tree',
        '-r',
        '--name-only',
        'refs/heads/' + branch,
        '--',
        '.github/workflows',
      ],
      undefined,
      true,
    )
    if (tree === null || !tree) return []
    const files = tree
      .split('\n')
      .filter((f) => /^.github\/workflows\/[^/]+\.ya?ml$/.test(f))
    if (files.length > 64) throw Error('Actions supports at most 64 workflows')
    const results = []
    for (const file of files) {
      const size = Number(
        await this.git(['cat-file', '-s', `refs/heads/${branch}:${file}`]),
      )
      if (size > 128 * 1024) {
        results.push({ file, text: '# Invalid oversized workflow\n' })
        continue
      }
      const text = await this.git(['show', `refs/heads/${branch}:${file}`])
      results.push({ file, text: text ?? '' })
    }
    return results
  }
}
