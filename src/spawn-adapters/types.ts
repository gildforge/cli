import type { AgentEvent } from '../spawn-events'
export type AdapterContext = {
  id: string
  directory: string
  command: string[]
  environment?: NodeJS.ProcessEnv
  emit?: (event: AgentEvent) => void
  onCleanup?: (cleanup: () => void) => void
}
export type RuntimeSettings = { model?: string; effort?: string }
export type RuntimeFlags = (settings: RuntimeSettings) => string[]
export type AgentAdapter = {
  profileArgs: RuntimeFlags
  name: string
  prepare(
    context: AdapterContext,
    args: string[],
  ): Promise<{
    args: string[]
    cleanup(): void
    receive?: (raw: unknown) => void
  }>
  translate(session: string, raw: unknown): AgentEvent | null
  /** For a runtime that reports only turn ends: terminal-quiet readiness
   * (see QuietIdle). `dialogs` matches screen text with whitespace removed. */
  quiet?: { startupMs: number; busyMs: number; dialogs?: RegExp }
}
export function event(
  session: string,
  agent: string,
  type: AgentEvent['type'],
  raw: unknown,
  tool?: string,
): AgentEvent {
  return {
    session,
    agent,
    type,
    ...(tool ? { tool } : {}),
    ts: new Date().toISOString(),
    raw,
  }
}
export function payload(raw: unknown): Record<string, unknown> | null {
  return raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : null
}
export const shellQuote = (value: string) =>
  "'" + value.replaceAll("'", "'\\''") + "'"

export function nativeOptions(args: string[]) {
  const separator = args.indexOf('--')
  return separator < 0 ? args : args.slice(0, separator)
}
