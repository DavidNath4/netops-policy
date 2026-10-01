import { loadEnv } from '../utils/config'
import type { Module, N8nResult, Operation } from '#shared/schemas/n8n.schema'

// The ONLY component that talks to n8n.
//
// It POSTs the operator's FIELD payload (never a rendered command string) to the
// n8n webhook with the API key header and the correlation id, bounded by
// N8N_TIMEOUT_MS, and normalizes whatever n8n returns into an N8nResult
// { status, output?, error?, device?, execution?, correlationId? }.
//
// n8n composes and runs the actual device command; device SSH credentials live
// in n8n. This client forwards the per-engineer execution credentials inside the
// payload but never logs them.

export interface N8nCallOptions {
  module: Module
  action: Operation
  /**
   * The exact JSON body n8n expects for this operation (e.g. `{ user, pass,
   * source }` for acl/show). The service builds it per the n8n contract; the
   * client sends it as-is. Includes credentials — never logged.
   */
  body: Record<string, unknown>
  /** Internal trace id; sent as a header only (not required in the body). */
  correlationId: string
}

/**
 * Resolve the per-operation webhook URL: `<base>/<module>/<action>` in
 * lowercase, e.g. https://.../webhook/acl/show. Handles a base with or without
 * a trailing slash so we never emit a double slash.
 */
function resolveWebhookUrl(baseUrl: string, module: Module, action: Operation): string {
  const base = baseUrl.replace(/\/+$/, '')
  return `${base}/${module.toLowerCase()}/${action.toLowerCase()}`
}

/**
 * Map an unknown n8n response body into a normalized N8nResult. Handles two
 * shapes: the structured show shape `{ success, total, data[], message }` and a
 * simpler `{ success?, output?/error?, device? }`.
 */
function normalize(ok: boolean, body: unknown): N8nResult {
  // n8n often wraps the webhook response in an array ([{ ... }]). Unwrap the
  // first element so we read the actual payload object.
  const root = Array.isArray(body) ? body[0] : body
  const b = (root && typeof root === 'object' ? root : {}) as Record<string, unknown>

  const device = typeof b.device === 'string' ? b.device : undefined
  const message = typeof b.message === 'string' ? b.message : undefined
  const total = typeof b.total === 'number' ? b.total : undefined
  const items = Array.isArray(b.data) ? (b.data as unknown[]) : (Array.isArray(b.items) ? (b.items as unknown[]) : undefined)
  const explicitError = typeof b.error === 'string' ? b.error : undefined

  // Success is driven by the `success` boolean when present, else HTTP status
  // (and the absence of an error field).
  const successFlag = typeof b.success === 'boolean' ? b.success : undefined
  const succeeded = successFlag !== undefined
    ? successFlag && ok
    : (ok && explicitError === undefined)

  if (!succeeded) {
    return {
      status: 'FAILED',
      error: explicitError ?? message ?? 'n8n returned an unsuccessful response',
      message: message ?? null,
      device,
    }
  }

  const output = typeof b.output === 'string' ? b.output : null

  return {
    status: 'SUCCESS',
    message: message ?? null,
    total: total ?? (items ? items.length : null),
    items: items ?? null,
    output,
    error: null,
    device,
  }
}

export interface ValidateResult {
  success: boolean
  message: string
}

/**
 * Validate device credentials against the n8n `user/validate` webhook. Used once
 * when an engineer sets their Device Session Credentials. Never throws — on any
 * network/timeout error it resolves to `{ success: false, message }` so the
 * caller can reject the set without storing anything.
 */
export async function validateDeviceCredentials(
  username: string,
  password: string,
): Promise<ValidateResult> {
  const env = loadEnv()
  const base = env.N8N_BASE_URL.replace(/\/+$/, '')
  const url = `${base}/user/validate`

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), env.N8N_TIMEOUT_MS)

  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'X-NetOps-Internal-Key': env.N8N_API_KEY,
      },
      body: JSON.stringify({ user: username, pass: password }),
    })

    let body: unknown = null
    try {
      body = await res.json()
    }
    catch {
      body = null
    }

    const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
    const success = res.ok && b.success === true
    const message = typeof b.message === 'string'
      ? b.message
      : (success ? 'Credential validation success' : 'Invalid username or password')

    return { success, message }
  }
  catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError'
    return { success: false, message: aborted ? 'Validation request timed out' : 'Validation service is unreachable' }
  }
  finally {
    clearTimeout(timeout)
  }
}

/**
 * The normalized N8nResult plus the RAW request/response bodies for audit.
 *
 * `raw.request` is the exact body sent to n8n (it contains the per-engineer
 * `user`/`pass`) and `raw.response` is the raw parsed JSON n8n returned (or null
 * on a timeout/unreachable/parse failure). These are surfaced ONLY so the
 * ACL/ROUTE audit path can persist them — AFTER passing them through
 * `redactPayload`, which masks the credentials. This type is intentionally LOCAL
 * to the client so the shared `OperationResult` client contract stays unchanged.
 * Every existing `N8nResult` field is preserved, so all current callers compile.
 */
export type N8nCallResult = N8nResult & {
  raw: { request: unknown, response: unknown }
}

/**
 * Call the n8n webhook for one operation. Never throws for n8n/network errors —
 * it always resolves to an N8nCallResult (FAILED with a safe message on failure)
 * so the service can record an audit log and return a safe error to the client.
 */
export async function callN8n(options: N8nCallOptions): Promise<N8nCallResult> {
  const env = loadEnv()
  const url = resolveWebhookUrl(env.N8N_BASE_URL, options.module, options.action)

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), env.N8N_TIMEOUT_MS)

  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        // API key authenticates the app to n8n (same header on every n8n call).
        'X-NetOps-Internal-Key': env.N8N_API_KEY,
        // Trace id as a header only; the body carries exactly what n8n expects.
        'x-correlation-id': options.correlationId,
      },
      body: JSON.stringify(options.body),
    })

    let body: unknown = null
    try {
      body = await res.json()
    }
    catch {
      body = null
    }

    // Attach the raw request/response for the audit path (redacted before store).
    return { ...normalize(res.ok, body), raw: { request: options.body, response: body } }
  }
  catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError'
    return {
      status: 'FAILED',
      error: aborted ? 'n8n request timed out' : 'n8n is unreachable',
      message: null,
      raw: { request: options.body, response: null },
    }
  }
  finally {
    clearTimeout(timeout)
  }
}
