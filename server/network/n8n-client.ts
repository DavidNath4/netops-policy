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
  /** Field payload (already validated). Includes exec credentials + fields. */
  payload: Record<string, unknown>
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

/** Map an unknown n8n response body into a normalized N8nResult. */
function normalize(
  ok: boolean,
  body: unknown,
  correlationId: string,
): N8nResult {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>

  const device = typeof b.device === 'string' ? b.device : undefined
  const execution = (b.execution && typeof b.execution === 'object')
    ? (b.execution as N8nResult['execution'])
    : undefined
  const returnedCorrelation = typeof b.correlationId === 'string' ? b.correlationId : undefined

  // Integrity: if n8n echoes a different correlation id, treat as failure.
  if (returnedCorrelation && returnedCorrelation !== correlationId) {
    return {
      status: 'FAILED',
      output: null,
      error: 'Correlation id mismatch in n8n response',
      device,
      execution,
      correlationId,
    }
  }

  // Explicit failure signals: non-2xx, an `error` field, or status: 'FAILED'.
  const explicitError = typeof b.error === 'string' ? b.error : undefined
  const explicitStatus = typeof b.status === 'string' ? b.status.toUpperCase() : undefined
  const failed = !ok || explicitError !== undefined || explicitStatus === 'FAILED'

  if (failed) {
    return {
      status: 'FAILED',
      output: null,
      error: explicitError ?? `n8n returned an unsuccessful response`,
      device,
      execution,
      correlationId,
    }
  }

  const output = typeof b.output === 'string'
    ? b.output
    : (b.output !== undefined ? JSON.stringify(b.output) : null)

  return {
    status: 'SUCCESS',
    output,
    error: null,
    device,
    execution,
    correlationId,
  }
}

/**
 * Call the n8n webhook for one operation. Never throws for n8n/network errors —
 * it always resolves to an N8nResult (FAILED with a safe message on failure) so
 * the service can record an audit log and return a safe error to the client.
 */
export async function callN8n(options: N8nCallOptions): Promise<N8nResult> {
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
        // API key authenticates the app to n8n. Matches the n8n webhook's
        // "Header Auth" credential header name.
        'X-NetOps-Internal-Key': env.N8N_API_KEY,
        'x-correlation-id': options.correlationId,
      },
      body: JSON.stringify({
        module: options.module,
        action: options.action,
        correlationId: options.correlationId,
        ...options.payload,
      }),
    })

    let body: unknown = null
    try {
      body = await res.json()
    }
    catch {
      body = null
    }

    return normalize(res.ok, body, options.correlationId)
  }
  catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError'
    return {
      status: 'FAILED',
      output: null,
      error: aborted ? 'n8n request timed out' : 'n8n is unreachable',
      correlationId: options.correlationId,
    }
  }
  finally {
    clearTimeout(timeout)
  }
}
