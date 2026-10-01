import { randomUUID } from 'node:crypto'

import type { Database } from '~~/database'
import { callN8n } from '../network/n8n-client'
import { buildRoutePreview, type CommandPreview } from '../network/preview'
import { redactPayload } from '../network/redact'
import { insertRouteLog } from '../repositories/route-log.repository'
import type { AuditContext } from '../utils/audit-context'
import { recordWithDetail } from './audit.service'
import type { DeviceCredentials } from './device-credential.service'
import type { RouteExecuteInput } from '#shared/schemas/route.schema'
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
 * Join a route IP and its mask into the single "IP MASK" string n8n expects.
 * If the IP already contains a mask (a space), it is used as-is; otherwise a
 * missing mask defaults to the /32 host mask.
 */
function joinAddr(addr: string, mask?: string): string {
  const a = addr.trim()
  if (a.includes(' ')) return a
  return `${a} ${(mask ?? '255.255.255.255').trim()}`
}

/**
 * ROUTE SHOW — show-all, read-only, runs immediately (no confirmation).
 * Credentials come from the caller's Device Session Credentials. The n8n body is
 * `{ user, pass }` only; it returns the full route table and the client filters.
 */
export async function routeShow(
  db: Database,
  ctx: AuditContext,
  creds: DeviceCredentials,
): Promise<OperationResult> {
  const correlationId = randomUUID()

  // n8n route/show contract: { user, pass } only.
  const result = await callN8n({
    module: 'ROUTE',
    action: 'SHOW',
    correlationId,
    body: {
      user: creds.username,
      pass: creds.password,
    },
  })

  // Master audit row + route_logs detail row, written atomically.
  await recordWithDetail(
    db,
    {
      ...ctx,
      module: 'ROUTE',
      action: 'SHOW',
      status: result.status,
      correlationId,
      // route/show is show-all; the only non-secret part is the RAW n8n request
      // body (user/pass), which record()'s deep redactPayload masks.
      requestPayload: { n8nRequest: result.raw.request },
      executionPayload: result.execution ?? null,
      responsePayload: {
        total: result.total ?? null,
        items: result.items ?? null,
        message: result.message ?? null,
        error: result.error ?? null,
        n8nResponse: result.raw.response,
      },
    },
    async (tx, auditId) => await insertRouteLog(tx, {
      auditId,
      correlationId,
      action: 'SHOW',
      status: result.status,
      device: result.device ?? null,
      // ROUTE SHOW is show-all: no destination, no change ticket.
      destination: null,
      changeTicket: null,
      // SHOW has no command preview.
      commandPreview: null,
      // Defense-in-depth: metadata/summary passed through redactPayload.
      executionMeta: redactPayload(result.execution ?? null),
      responseSummary: redactPayload({
        total: result.total ?? null,
        message: result.message ?? null,
        error: result.error ?? null,
      }),
    }),
  )

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

  // n8n route/add & route/delete contract: { user, pass, routeIp }, where
  // routeIp is a joined "IP MASK" string (confirmed against the live n8n webhook).
  const result = await callN8n({
    module: 'ROUTE',
    action: input.operation,
    correlationId,
    body: {
      user: input.execUsername,
      pass: input.execPassword,
      routeIp: joinAddr(input.routeIp, input.routeMask),
    },
  })

  // Master audit row + route_logs detail row, written atomically.
  await recordWithDetail(
    db,
    {
      ...ctx,
      module: 'ROUTE',
      action: input.operation,
      status: result.status,
      changeTicket: input.changeTicket ?? null,
      correlationId,
      // The RAW n8n request body (user/pass) is masked by record()'s deep
      // redactPayload before storage.
      requestPayload: redactPayload({ ...input, n8nRequest: result.raw.request }),
      commandPayload: { command: preview.command },
      executionPayload: result.execution ?? null,
      responsePayload: {
        total: result.total ?? null,
        items: result.items ?? null,
        message: result.message ?? null,
        output: result.output ?? null,
        error: result.error ?? null,
        n8nResponse: result.raw.response,
      },
    },
    async (tx, auditId) => await insertRouteLog(tx, {
      auditId,
      correlationId,
      action: input.operation,
      status: result.status,
      device: result.device ?? null,
      // ROUTE EXECUTE: the human-readable "IP MASK" destination the user sees.
      destination: joinAddr(input.routeIp, input.routeMask),
      changeTicket: input.changeTicket ?? null,
      // preview.command lines are already credential-free; pass through
      // redactPayload for defense-in-depth.
      commandPreview: redactPayload(preview.command),
      executionMeta: redactPayload(result.execution ?? null),
      responseSummary: redactPayload({
        total: result.total ?? null,
        message: result.message ?? null,
        output: result.output ?? null,
        error: result.error ?? null,
      }),
    }),
  )

  return toOperationResult(correlationId, result)
}
