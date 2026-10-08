// Mirrors gild-site/lib/sessions/redact.ts at 17375106d1b81b46f3ca48df23bcbba0c851e20a.
// No shared redaction package exists yet. Keep these baseline rules in sync;
// CLI supplements include gro_/sk- and secret assignments before network I/O.
import type { SessionInput } from './api/sessions-contract'
const REDACTED = '[redacted]'
function entropy(value: string) {
  const counts = new Map<string, number>()
  for (const c of value) counts.set(c, (counts.get(c) ?? 0) + 1)
  return [...counts.values()].reduce(
    (sum, n) => sum - (n / value.length) * Math.log2(n / value.length),
    0,
  )
}
export function redact(value: string, cap = 4096) {
  // Recognizable bearer/API credentials are removed even when they have low
  // entropy. Generic opaque strings cover unprefixed Cloudflare/AWS secrets.
  const safe = value
    .replace(
      /\b(?:gf|gr|gro|ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_-]{8,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
      REDACTED,
    )
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, REDACTED)
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, REDACTED)
    .replace(
      /((?:\b[\w-]*(?:token|secret|password|credential|(?:api[_-]?)?key)[\w-]*\s*[=:]\s*|\bBearer\s+))(?:("|')([^"']*)\2|[^\s"']+)/gi,
      '$1' + REDACTED,
    )
    .replace(/[A-Za-z0-9_+\/-]{24,}={0,2}/g, (v) =>
      entropy(v) >= 3.3 ? REDACTED : v,
    )
  return safe.length > cap ? safe.slice(0, cap - 12) + ' [truncated]' : safe
}
export function redactSession<T extends SessionInput>(receipt: T): T {
  return {
    ...receipt,
    model: redact(receipt.model, 120),
    commands: receipt.commands.map((c) => ({
      ...c,
      name: redact(c.name, 1024),
    })),
    files: {
      read: receipt.files.read.map((p) => redact(p, 1024)),
      written: receipt.files.written.map((p) => redact(p, 1024)),
    },
    notes: redact(receipt.notes),
  }
}
