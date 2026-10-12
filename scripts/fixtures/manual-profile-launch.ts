// Test entrypoint drives the production command/action with no forge identity or provider.
import { Command } from 'commander'
import { spawnCommands } from '../../src/spawn'
const command = new Command().enablePositionalOptions()
spawnCommands(command)
await command.parseAsync(process.argv)
