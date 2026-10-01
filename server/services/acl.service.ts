import { randomUUID } from 'node:crypto'

import type { Database } from '~~/database'
import { callN8n } from '../network/n8n-client'
import { buildAclPreview, type CommandPreview } from '../network/preview'
import { redactPayload } from '../network/redact'
import { insertAclLog } from '../repositories/acl-log.repository'
import type { AuditContext } from '../utils/audit-context'
import { recordWithDetail } from './audit.service'
import type { DeviceCredentials } from './device-credential.service'
import type { AclExecuteInput, AclShowInput } from '#shared/schemas/acl.schema'
import type { N8nResult, OperationResult } from '#shared/schemas/n8n.schema'

/**
 * ACL operations: show (read-only), preview (redacted, display-only), and
 * execute (delegated to n8n). The service validates already-parsed input,
 * generates the correlation id, delegates execution to n8n, and records exactly
 * one audit log per show/execute. It never stores ACL rows and never runs a
 * device command itself.
 */

/**
 * Join an address and its mask into the single "IP MASK" string n8n expects.
 * If the address already contains a mask (a space), it is used as-is; otherwise
 * a missing mask defaults to the /32 host mask.
 */
function joinAddr(addr: string, mask?: string): string {
  const a = addr.trim()
  if (a.includes(' ')) return a
  return `${a} ${(mask ?? '255.255.255.255').trim()}`
}

/** Build the client-facing result from a normalized n8n result. */
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
 * ACL SHOW — search-only, read-only, runs immediately (no confirmation).
 * Credentials come from the caller's Device Session Credentials (resolved by the
 * handler). The n8n `acl/show` contract body is `{ user, pass, source }`.
 */
export async function aclShow(
  db: Database,
  ctx: AuditContext,
  input: AclShowInput,
  creds: DeviceCredentials,
): Promise<OperationResult> {
  const correlationId = randomUUID()

  const result = await callN8n({
    module: 'ACL',
    action: 'SHOW',
    correlationId,
    body: {
      user: creds.username,
      pass: creds.password,
      source: input.search,
    },
  })

  // Master audit row + acl_logs detail row, written atomically.
  await recordWithDetail(
    db,
    {
      ...ctx,
      module: 'ACL',
      action: 'SHOW',
      status: result.status,
      correlationId,
      // Only the non-secret search value is audited; the RAW n8n request body
      // (which carries user/pass) is masked by record()'s deep redactPayload.
      requestPayload: { source: input.search, n8nRequest: result.raw.request },
      executionPayload: result.execution ?? null,
      responsePayload: {
        total: result.total ?? null,
        items: result.items ?? null,
        message: result.message ?? null,
        error: result.error ?? null,
        n8nResponse: result.raw.response,
      },
    },
    async (tx, auditId) => await insertAclLog(tx, {
      auditId,
      correlationId,
      action: 'SHOW',
      status: result.status,
      device: result.device ?? null,
      // ACL SHOW: the search value is the source; there is no destination.
      source: input.search,
      destination: null,
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

/** Build the redacted preview for an ACL add/delete (no n8n, no audit). */
export function aclPreview(input: AclExecuteInput): CommandPreview {
  return buildAclPreview(input)
}

/** ACL EXECUTE — confirmed add/delete, delegated to n8n, one audit log. */
export async function aclExecute(
  db: Database,
  ctx: AuditContext,
  input: AclExecuteInput,
): Promise<OperationResult> {
  const correlationId = randomUUID()
  const preview = buildAclPreview(input)

  // n8n acl/add & acl/delete contract: { user, pass, source, destination },
  // where source/destination are joined "IP MASK" strings. A missing mask
  // defaults to a /32 host mask (255.255.255.255).
  const result = await callN8n({
    module: 'ACL',
    action: input.operation,
    correlationId,
    body: {
      user: input.execUsername,
      pass: input.execPassword,
      source: joinAddr(input.source, 'sourceMask' in input ? input.sourceMask : undefined),
      destination: joinAddr(input.destination, 'destinationMask' in input ? input.destinationMask : undefined),
    },
  })

  // Master audit row + acl_logs detail row, written atomically.
  await recordWithDetail(
    db,
    {
      ...ctx,
      module: 'ACL',
      action: input.operation,
      status: result.status,
      correlationId,
      // redactPayload masks user/pass/exec*; the command snapshot is already
      // credential-free (preview never embeds creds). The RAW n8n request body
      // (user/pass) is masked by record()'s deep redactPayload.
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
    async (tx, auditId) => await insertAclLog(tx, {
      auditId,
      correlationId,
      action: input.operation,
      status: result.status,
      device: result.device ?? null,
      // ACL EXECUTE: the raw human-readable address inputs (NOT the joined
      // "IP MASK" strings sent to n8n), which contain no credentials.
      source: input.source,
      destination: input.destination,
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
