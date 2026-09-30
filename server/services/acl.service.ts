import { randomUUID } from 'node:crypto'

import type { Database } from '~~/database'
import { callN8n } from '../network/n8n-client'
import { buildAclPreview, type CommandPreview } from '../network/preview'
import { redactPayload } from '../network/redact'
import type { AuditContext } from '../utils/audit-context'
import { record } from './audit.service'
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

  await record(db, {
    ...ctx,
    module: 'ACL',
    action: 'SHOW',
    status: result.status,
    correlationId,
    // Only the non-secret search value is audited; credentials never are.
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

  // n8n contract uses `user`/`pass`; map the form's exec credentials and send
  // the remaining fields alongside.
  const { execUsername, execPassword, operation, ...fields } = input
  const result = await callN8n({
    module: 'ACL',
    action: operation,
    correlationId,
    body: { user: execUsername, pass: execPassword, ...fields },
  })

  await record(db, {
    ...ctx,
    module: 'ACL',
    action: operation,
    status: result.status,
    changeTicket: input.changeTicket ?? null,
    correlationId,
    // redactPayload masks user/pass/exec*; the command snapshot is already
    // credential-free (preview never embeds creds).
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
