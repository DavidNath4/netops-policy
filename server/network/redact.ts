// Credential redaction for previews and audit payloads.
//
// SECURITY: the per-engineer execution credentials are forwarded to n8n but must
// never be shown to the client or written to an audit log. Everything here masks
// them to `***` before display/persistence. This is defense-in-depth applied at
// two levels: by key (object payloads) and by value (rendered preview strings).

export const REDACTED = '***'

/** Keys whose values are always masked in any object payload. */
const CREDENTIAL_KEYS = new Set(['execUsername', 'execPassword', 'password', 'apiKey', 'apiToken'])

/**
 * Deep-clone `payload` with any credential-bearing key masked to `***`.
 * Non-credential values are preserved. Safe for request/command JSONB payloads.
 */
export function redactPayload<T>(payload: T): T {
  if (Array.isArray(payload)) {
    return payload.map(item => redactPayload(item)) as unknown as T
  }
  if (payload && typeof payload === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
      out[key] = CREDENTIAL_KEYS.has(key) ? REDACTED : redactPayload(value)
    }
    return out as T
  }
  return payload
}

/**
 * Mask credential VALUES that appear inline in a rendered preview string. Used
 * so a previewed command never shows the raw username/password even if the
 * template interpolates them. Empty/undefined values are ignored.
 */
export function redactText(text: string, values: Array<string | undefined | null>): string {
  let out = text
  for (const value of values) {
    if (value && value.length > 0) {
      out = out.split(value).join(REDACTED)
    }
  }
  return out
}
