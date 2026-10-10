import { Command, InvalidArgumentError } from 'commander'
import type { GildClient } from './api/client'

export type ForgeOptions = { agent?: string; server?: string; json?: boolean }
export type ForgeResolve = (
  opts: ForgeOptions,
  read?: boolean,
) => Promise<GildClient>

export function forgeCommand(
  group: Command,
  name: string,
  description: string,
) {
  return group
    .command(name)
    .description(description)
    .option('--agent <label>', 'use an approved agent token')
    .option(
      '--server <url>',
      'forge base URL (defaults to the joined server for agents)',
    )
    .option('--json', 'print JSON')
}

export function numberedRef(value: string, number?: string) {
  const match = (number ? `${value}#${number}` : value).match(
    /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#([1-9][0-9]{0,14})$/,
  )
  if (!match)
    throw new InvalidArgumentError('Use owner/repo#number or owner/repo number')
  return { owner: match[1], repo: match[2], number: match[3] }
}

export const printResult = (value: { html_url?: string }, json?: boolean) =>
  console.log(json ? JSON.stringify(value) : value.html_url)
