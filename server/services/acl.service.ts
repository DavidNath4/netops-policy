import { randomUUID } from 'node:crypto'

import type { Database } from '~~/database'
import { callN8n } from '../network/n8n-client'
import { buildAclPreview, type CommandPreview } from '../network/preview'
import { redactPayload } from '../network/redact'
import type { AuditContext } from '../utils/audit-context'
import { record } from './audit.service'
import type { AclExecuteInput, AclShowInput } from '#shared/schemas/acl.schema'
import type { N8nResult } from '#shared/schemas/n8n.schema'
import type { OperationResult } from '#shared/schemas/n8n.schema'

/**
 * ACL operations: show (read-only), preview (redacted, display-only), and
 * execute (delegated to n8n). The service validates already-parsed input,
 * generates the correlation id, delegates execution to n8n, and records exactly
 * one audit log per show/execute. It never stores ACL rows and never runs a
 * device command itself.
 */

/** Build the client-facing result from a normalized n8n result. */
function toOperationResult(correlationId: string, r: N8nResult): OperationResult {
  return {
    correlationId,
    status: r.status,
    output: r.output ?? null,
    error: r.error ?? null,
  }
}

/** ACL SHOW — read-only, runs immediately (no confirmation). */
export async function aclShow(
  db: Database,
  ctx: AuditContext,
  input: AclShowInput,
): Promise<OperationResult> {
  const correlationId = randomUUID()

  const result = await callN8n({
    module: 'ACL',
    action: 'SHOW',
    correlationId,
    payload: { ...input },
  })

  await record(db, {
    ...ctx,
    module: 'ACL',
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

  const result = await callN8n({
    module: 'ACL',
    action: input.operation,
    correlationId,
    payload: { ...input },
  })

  await record(db, {
    ...ctx,
    module: 'ACL',
    action: input.operation,
    status: result.status,
    changeTicket: input.changeTicket ?? null,
    correlationId,
    // redactPayload masks execUsername/execPassword; the command snapshot is
    // already credential-free (preview never embeds creds).
    requestPayload: redactPayload({ ...input }),
    commandPayload: { device: result.device ?? null, command: preview.command },
    executionPayload: result.execution ?? null,
    responsePayload: { device: result.device ?? null, output: result.output ?? null, error: result.error ?? null },
  })

  return toOperationResult(correlationId, result)
}
