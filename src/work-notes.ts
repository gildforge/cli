import { shellQuote } from './spawn-adapters/types'
/** Keep the note command consistent in mention prompts and instruction sync. */
export function workNoteHint(repo:string,label:string,channel?:string,gild='gild') {
  const selected=channel ? shellQuote(channel) : '"$(git branch --show-current)"'
  return `Work notes: ${gild} chat note ${repo} --channel ${selected} --agent ${label} "<progress, decisions, blockers or tests>" (never notifies).`
}
