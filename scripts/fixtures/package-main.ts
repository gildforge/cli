// Actual MAIN/spawn/worker routes; only approved identity/token construction is isolated.
import { Command } from 'commander'
import { writeFile, stat } from 'node:fs/promises'
import { mainCommands, runLocalMain } from '../../src/local-main'
import { spawnCommands } from '../../src/spawn'
if (process.argv[2] === '__main-worker') await runLocalMain()
else if (process.argv[2] === '__vm-worker')
  await import('../../src/spawn-worker')
else {
  const command = new Command().enablePositionalOptions()
  mainCommands(command)
  spawnCommands(command, async (label, cwd, legacy) => {
    if (label !== 'fixture-approved') throw Error('Fixture identity denied')
    if (await stat('defer-identity').catch(() => null)) {
      await writeFile('identity-awaiting', String(process.pid))
      while (!(await stat('identity-release').catch(() => null)))
        await Bun.sleep(10)
      await writeFile('identity-returned', String(process.connected))
    }
    await writeFile(
      'identity-selection.json',
      JSON.stringify({ label, cwd, legacy }),
    )
    return { agent: label }
  })
  await command.parseAsync(process.argv)
}
