import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

export function prove(name, file, mutate, tests, pattern) {
  const original = readFileSync(file, 'utf8')
  try {
    const changed = mutate(original)
    if (changed === original) throw Error('Mutation did not change ' + file)
    writeFileSync(file, changed)
    const result = spawnSync(
      'bun',
      ['test', tests, '--test-name-pattern', pattern],
      {
        encoding: 'utf8',
        timeout: 20000,
      },
    )
    mkdirSync('.tmp', { recursive: true })
    writeFileSync('.tmp/revert-' + name + '.log', result.stdout + result.stderr)
    if (result.status !== 1 || !result.stderr.includes('expect('))
      throw Error(
        'Expected assertion failure for ' + name + ': ' + result.stderr,
      )
    return { behavior: name, exit: result.status, assertionFailure: true }
  } finally {
    writeFileSync(file, original)
  }
}
if (import.meta.main) {
  const evidence = [
    prove(
      'token-routing',
      'src/gild.ts',
      (source) => {
        const start = source.indexOf('async function clientFor(')
        const end = source.indexOf('/** Register gild', start)
        return (
          source.slice(0, start) +
          `async function clientFor(server, identity) {
      if (!identity.apiToken) {
        const result = await signedCall(server, '/api/tokens', identity)
        identity.apiToken = {server, token:result.data.token}
        await saveIdentity(identity)
      }
      return new GildClient(server+'/api/v1', identity.apiToken.token)
    }\n\n` +
          source.slice(end)
        )
      },
      'src/routing.test.ts',
      'token routing remints',
    ),
  ]
  if (existsSync('src/events-tail.test.ts'))
    evidence.push(
      prove(
        'agent-event-routing',
        'src/gild.ts',
        (source) => {
          const start = source.indexOf('export function agentServer(')
          const end = source.indexOf('const agentsDir', start)
          return (
            source.slice(0, start) +
            `export function agentServer(agent, requested) {return requested ?? agent.server}\n\n` +
            source.slice(end)
          )
        },
        'src/events-tail.test.ts',
        'events tail uses joined server',
      ),
    )
  mkdirSync('docs', { recursive: true })
  writeFileSync(
    'docs/review-api-revert-evidence.json',
    JSON.stringify(evidence, null, 2) + '\n',
  )
  console.log(JSON.stringify(evidence))
}
