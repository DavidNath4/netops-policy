import { randomUUID } from 'node:crypto'

import type { Database } from '~~/database'
import { callN8n } from '../network/n8n-client'
import { buildRoutePreview, type CommandPreview } from '../network/preview'
import { redactPayload } from '../network/redact'
import type { AuditContext } from '../utils/audit-context'
import { record } from './audit.service'
import type { DeviceCredentials } from './device-credential.service'
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
    message: r.message ?? null,
    total: r.total ?? null,
    items: r.items ?? null,
    output: r.output ?? null,
    error: r.error ?? null,
  }
}

/**
 * ROUTE SHOW — search-only, read-only, runs immediately (no confirmation).
 * Credentials come from the caller's Device Session Credentials. The n8n body is
 * `{ user, pass, source }` (mirrors the acl/show contract).
 */
export async function routeShow(
  db: Database,
  ctx: AuditContext,
  input: RouteShowInput,
  creds: DeviceCredentials,
): Promise<OperationResult> {
  const correlationId = randomUUID()

  const result = await callN8n({
    module: 'ROUTE',
    action: 'SHOW',
    correlationId,
    body: {
      user: creds.username,
      pass: creds.password,
      source: input.search,
    },
  })

  await record(db, {
    ...ctx,
    module: 'ROUTE',
    action: 'SHOW',
    status: result.status,
    correlationId,
    requestPayload: { source: input.search },
    executionPayload: result.execution ?? null,
    responsePayload: {
      total: result.total ?? null,
      items: result.items ?? null,
      message: result.message ?? null,
      error: result.error ?? null,
    },
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

  const { execUsername, execPassword, operation, ...fields } = input
  const result = await callN8n({
    module: 'ROUTE',
    action: operation,
    correlationId,
    body: { user: execUsername, pass: execPassword, ...fields },
  })

  await record(db, {
    ...ctx,
    module: 'ROUTE',
    action: operation,
    status: result.status,
    changeTicket: input.changeTicket ?? null,
    correlationId,
    requestPayload: redactPayload({ ...input }),
    commandPayload: { command: preview.command },
    executionPayload: result.execution ?? null,
    responsePayload: {
      total: result.total ?? null,
      items: result.items ?? null,
      message: result.message ?? null,
      output: result.output ?? null,
      error: result.error ?? null,
    },
  })

  return toOperationResult(correlationId, result)
}
