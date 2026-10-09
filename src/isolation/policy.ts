// Isolation policy: which level a run gets, and when it is refused.
//
// Levels, strongest first. `none` is never picked automatically: it needs an
// explicit request and is labelled unisolated everywhere it is shown.
export const LEVELS = ['vm', 'container', 'host', 'none'] as const
export type Level = (typeof LEVELS)[number]

export const strength = (level: Level) => LEVELS.length - LEVELS.indexOf(level)

export type RequestSource = 'flag' | 'job' | 'profile' | 'host-default' | 'auto'

export interface PolicyInput {
  /** `--isolation` on this run. Most specific, wins over everything below. */
  flag?: Level
  /** `isolation:` on the workflow job. */
  job?: Level
  /** `isolation` in the agent profile. */
  profile?: Level
  /** The host default the owner set once in the host config. */
  hostDefault?: Level
  /** Owner floor: levels weaker than this are refused, never upgraded. */
  floor?: Level
  /** Backends usable on this machine. */
  available: readonly Level[]
  /**
   * Level used when nothing at all asks for one and there is no floor. This
   * keeps `gild runner start` working exactly as before for existing
   * runners; it is labelled unisolated.
   */
  legacyDefault?: Level
}

export interface Resolved {
  level: Level
  source: RequestSource
}

export class IsolationRefused extends Error {}

export function parseLevel(
  text: string | undefined,
  where: string,
): Level | undefined {
  if (text === undefined) return undefined
  if ((LEVELS as readonly string[]).includes(text)) return text as Level
  throw new IsolationRefused(
    `${where}: unknown isolation "${text}" (use ${LEVELS.join(', ')})`,
  )
}

export function resolveIsolation(input: PolicyInput): Resolved {
  const asked: [Level | undefined, RequestSource][] = [
    [input.flag, 'flag'],
    [input.job, 'job'],
    [input.profile, 'profile'],
    [input.hostDefault, 'host-default'],
  ]
  const hit = asked.find(([level]) => level !== undefined)
  const floor = input.floor
  let chosen: Resolved
  if (hit) {
    chosen = { level: hit[0]!, source: hit[1] }
  } else {
    // Nothing asked: strongest available level that satisfies the floor.
    const auto = LEVELS.filter((l) => l !== 'none').find((l) =>
      input.available.includes(l),
    )
    if (auto && (!floor || strength(auto) >= strength(floor)))
      return { level: auto, source: 'auto' }
    if (!floor && input.legacyDefault)
      return { level: input.legacyDefault, source: 'auto' }
    throw new IsolationRefused(
      floor
        ? `this host requires isolation "${floor}" or stronger and none is available (available: ${input.available.join(', ') || 'none'})`
        : `no isolation backend is available on this host (tried ${LEVELS.filter((l) => l !== 'none').join(', ')}); ask for --isolation none to run unisolated`,
    )
  }
  if (floor && strength(chosen.level) < strength(floor))
    throw new IsolationRefused(
      `isolation "${chosen.level}" (from ${chosen.source}) is below this host's floor "${floor}"`,
    )
  if (!input.available.includes(chosen.level))
    throw new IsolationRefused(
      `isolation "${chosen.level}" (from ${chosen.source}) is not available on this host (available: ${input.available.join(', ') || 'none'})`,
    )
  return chosen
}

export const labelFor = (level: Level, backend: string) =>
  level === 'none'
    ? 'unisolated (runs as the runner user)'
    : `${level} (${backend})`
