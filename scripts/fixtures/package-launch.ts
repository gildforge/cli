// Production spawn action, with only the forge credential/identity boundary isolated.
import { Command } from 'commander'
import { writeFile } from 'node:fs/promises'
import { spawnCommands } from '../../src/spawn'
const command = new Command().enablePositionalOptions()
spawnCommands(command, async (label, cwd, legacy) => {
  if (label !== 'fixture-approved') throw Error('Fixture identity denied')
  await writeFile(
    'identity-selection.json',
    JSON.stringify({ label, cwd, legacy }),
  )
  return { agent: label }
})
await command.parseAsync(process.argv)
