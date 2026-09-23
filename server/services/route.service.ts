import { randomUUID } from 'node:crypto'

import type { Database } from '~~/database'
import { callN8n } from '../network/n8n-client'
import { buildRoutePreview, type CommandPreview } from '../network/preview'
import { redactPayload } from '../network/redact'
import type { AuditContext } from '../utils/audit-context'
import { record } from './audit.service'
import type { RouteExecuteInput, RouteShowInput } from '#shared/schemas/route.schema'
import type { N8nResult, OperationResult } from '#shared/schemas/n8n.schema'

/**
 * Route operations: show / preview / execute. Mirror of the ACL service; module
 * is ROUTE. No route rows are stored; execution is delegated to n8n and captured
 * as exactly one audit log per show/execute.
 */

function toOperationResult(correlationId: string, r: N8nResult): OperationResult {
  return {
    correlationId,
    status: r.status,
    output: r.output ?? null,
    error: r.error ?? null,
  }
}

/** ROUTE SHOW — read-only, runs immediately (no confirmation). */
export async function routeShow(
  db: Database,
  ctx: AuditContext,
  input: RouteShowInput,
): Promise<OperationResult> {
  const correlationId = randomUUID()

  const result = await callN8n({
    module: 'ROUTE',
    action: 'SHOW',
    correlationId,
    payload: { ...input },
  })

  await record(db, {
    ...ctx,
    module: 'ROUTE',
    action: 'SHOW',
    status: result.status,
    correlationId,
    requestPayload: { filter: input.filter },
    executionPayload: result.execution ?? null,
    responsePayload: result.device || result.output || result.error
      ? { device: result.device ?? null, output: result.output ?? null, error: result.error ?? null }
      : null,
  })

  return toOperationResult(correlationId, result)
}

/** Build the redacted preview for a route add/delete (no n8n, no audit). */
export function routePreview(input: RouteExecuteInput): CommandPreview {
  return buildRoutePreview(input)
}

/** ROUTE EXECUTE — confirmed add/delete, delegated to n8n, one audit log. */
export async function routeExecute(
  db: Database,
  ctx: AuditContext,
  input: RouteExecuteInput,
): Promise<OperationResult> {
  const correlationId = randomUUID()
  const preview = buildRoutePreview(input)

  const result = await callN8n({
    module: 'ROUTE',
    action: input.operation,
    correlationId,
    payload: { ...input },
  })

  await record(db, {
    ...ctx,
    module: 'ROUTE',
    action: input.operation,
    status: result.status,
    changeTicket: input.changeTicket ?? null,
    correlationId,
    requestPayload: redactPayload({ ...input }),
    commandPayload: { device: result.device ?? null, command: preview.command },
    executionPayload: result.execution ?? null,
    responsePayload: { device: result.device ?? null, output: result.output ?? null, error: result.error ?? null },
  })

  return toOperationResult(correlationId, result)
}
