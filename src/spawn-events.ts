/** The sole local event envelope. Raw payloads never leave the local socket. */
export type AgentEvent = {
  session: string
  agent: string
  type: 'busy' | 'idle' | 'tool_start' | 'tool_end' | 'waiting' | 'message'
  tool?: string
  text?: string
  ts: string
  raw: unknown
}
export type AgentState =
  'unknown' | Exclude<AgentEvent['type'], 'message' | 'tool_end'>
export type SessionState = {
  state: AgentState
  tool?: string
  lastActivity: string
  agentSessionId?: string
  transcriptPath?: string
}
export function applyEvent(state: SessionState, event: AgentEvent): void {
  state.lastActivity = event.ts
  if (event.type !== 'message') {
    state.state = event.type === 'tool_end' ? 'busy' : event.type
    state.tool = event.type === 'tool_start' ? event.tool : undefined
  }
  const raw = event.raw as Record<string, unknown> | null
  if (raw && typeof raw === 'object') {
    if (typeof raw.session_id === 'string')
      state.agentSessionId = raw.session_id
    if (typeof raw.transcript_path === 'string')
      state.transcriptPath = raw.transcript_path
    if (typeof raw['thread-id'] === 'string')
      state.agentSessionId = raw['thread-id']
  }
}
