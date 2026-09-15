/**
 * What a limit means when it reaches the app as text rather than a 429 the
 * gateway saw: the Claude CLI's synthetic assistant messages and Codex's
 * turn errors. Null when the text is not about a usage limit at all.
 *
 * Templates come from the CLI binaries:
 *  Claude  "You've hit your session limit · resets 6:20am (America/Chicago)"
 *          "You've hit your weekly limit · resets …"
 *          "You've reached your Fable limit. Switch to another model…"
 *          "You're out of usage credits." / "monthly spend limit" /
 *          "team's shared budget" / "extra usage"
 *          API pass-through: 429 {"type":"error","error":{"type":"rate_limit_error",…}}
 *  Codex   "You've hit your usage limit. Upgrade to Pro (…)"
 *          "You've hit your usage limit for the week"
 *          "Usage limit reached. You've reached your usage limit. …"
 *          "You're out of credits. Add credits to continue using Codex."
 *          "Quota exceeded. Check your plan and billing details."
 *          rate_limit_exceeded: "… try again in 12s"
 */
import type { LimitWindow } from '../gateway/limits'

export type TextProvider = 'claude' | 'codex'

export interface TextLimit {
  window: LimitWindow
}

type Rule = [RegExp, (m: RegExpMatchArray) => LimitWindow]

const TRANSIENT: RegExp[] = [/try again in/i, /rate_limit_exceeded/i, /overloaded/i, /too many requests/i]

const CLAUDE: Rule[] = [
  [/session limit/i, () => '5h'],
  [/weekly limit/i, () => 'weekly'],
  [/reached your (\w+) limit/i, (m) => ({ model: cap(m[1]) })],
  [/usage credits|spend limit|out of credits|shared budget|extra usage/i, () => 'credits']
]

const CODEX: Rule[] = [
  [/usage limit for (?:the )?(week|month)/i, () => 'weekly'],
  [/usage limit for (?:the )?(?:5|five)[- ]?h/i, () => '5h'],
  [/usage limit|usage_limit_reached/i, () => '5h'],
  [/out of credits|quota exceeded|quota_exceeded|usage_not_included|insufficient_quota/i, () => 'credits']
]

const cap = (s: string): string => s[0].toUpperCase() + s.slice(1).toLowerCase()

/** The message inside an API error body when the text is one; else the text. */
function unwrap(text: string): { text: string; apiError: boolean } {
  const start = text.indexOf('{')
  if (start < 0) return { text, apiError: false }
  try {
    const parsed = JSON.parse(text.slice(start)) as { error?: { type?: string; code?: string; message?: string } }
    const error = parsed?.error
    if (!error || typeof error !== 'object') return { text, apiError: false }
    const parts = [error.type, error.code, error.message].filter((s): s is string => typeof s === 'string')
    return { text: `${text.slice(0, start)} ${parts.join(' ')}`, apiError: true }
  } catch {
    return { text, apiError: false }
  }
}

export function classifyLimitText(provider: TextProvider, message: string): TextLimit | null {
  const { text, apiError } = unwrap(message)
  for (const [re, window] of provider === 'claude' ? CLAUDE : CODEX) {
    const m = text.match(re)
    if (m) return { window: window(m) }
  }
  if (TRANSIENT.some((re) => re.test(text))) return { window: 'transient' }
  // A bare API rate_limit_error names no window: the per-minute limiter, which passes.
  if (apiError && /rate_limit_error/i.test(text)) return { window: 'transient' }
  return null
}
