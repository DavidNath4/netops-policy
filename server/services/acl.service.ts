import { randomUUID } from 'node:crypto'

import type { Database } from '~~/database'
import { getTicketByRef, ItopUnreachableError } from '../network/itop-client'
import { callN8n } from '../network/n8n-client'
import { buildAclPreview, type CommandPreview } from '../network/preview'
import { redactPayload } from '../network/redact'
import { insertAclLog } from '../repositories/acl-log.repository'
import type { AuditContext } from '../utils/audit-context'
import { apiError } from '../utils/envelope'
import { recordWithDetail } from './audit.service'
import type { DeviceCredentials } from './device-credential.service'
import { deriveAclTimeRange } from '#shared/schemas/acl.schema'
import type { AclExecuteInput, AclShowInput } from '#shared/schemas/acl.schema'
import { autoCorrectAclIp } from '#shared/schemas/network.schema'
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

/**
 * Defense-in-depth IP auto-correction for ACL ADD. The form already rewrites
 * ticket IPs (10.197.x → the real 10.71.x scheme) on blur, but a direct API call
 * could bypass the UI, so the server re-applies the SAME mapping before preview,
 * audit, and the n8n call. Only ADD is corrected; DELETE is left as submitted.
 * Returns a new input object with corrected source/destination; non-matching or
 * invalid addresses are unchanged (the mapping is a no-op for them).
 */
function withCorrectedAclIps(input: AclExecuteInput): AclExecuteInput {
  if (input.operation !== 'ADD') return input
  return {
    ...input,
    source: autoCorrectAclIp(input.source),
    destination: autoCorrectAclIp(input.destination),
  }
}

/** Build the redacted preview for an ACL add/delete (no n8n, no audit). */
export function aclPreview(input: AclExecuteInput): CommandPreview {
  return buildAclPreview(withCorrectedAclIps(input))
}

/**
 * Swap source<->destination and sourceMask<->destinationMask for the reverse
 * direction of a bidirectional ACL ADD. Everything else (change ticket, time
 * range, exec credentials) is kept; `bidirectional` is dropped so the reverse
 * direction renders/executes as an ordinary one-way ADD. IPs are assumed
 * already corrected by the caller (correct first, then swap).
 */
function reverseAclDirection(input: AclExecuteInput): AclExecuteInput {
  if (input.operation !== 'ADD') return input
  return {
    ...input,
    bidirectional: false,
    source: input.destination,
    sourceMask: input.destinationMask,
    destination: input.source,
    destinationMask: input.sourceMask,
  }
}

/**
 * Run ONE ACL direction end-to-end: new correlation id → redacted preview →
 * n8n call (unchanged { user, pass, source, destination } contract, plus the
 * optional time-range keys) → one master audit row + one acl_logs detail row,
 * written atomically → client-facing result. A bidirectional ADD calls this
 * twice (forward then reverse), each independent with its own id and audit row.
 */
async function runAclDirection(
  db: Database,
  ctx: AuditContext,
  input: AclExecuteInput,
): Promise<OperationResult> {
  const correlationId = randomUUID()
  // Per-direction preview must show ONLY this direction's command lines; the
  // bidirectional two-direction preview is assembled upstream (aclPreview on
  // the full input). Clear the flag so buildAclPreview renders one direction.
  const preview = buildAclPreview(
    input.operation === 'ADD' ? { ...input, bidirectional: false } : input,
  )

  // n8n acl/add & acl/delete contract: { user, pass, source, destination },
  // where source/destination are joined "IP MASK" strings. A missing mask
  // defaults to a /32 host mask (255.255.255.255).
  const body: Record<string, string> = {
    user: input.execUsername,
    pass: input.execPassword,
    source: joinAddr(input.source, 'sourceMask' in input ? input.sourceMask : undefined),
    destination: joinAddr(input.destination, 'destinationMask' in input ? input.destinationMask : undefined),
  }

  // Optional time-range ADD: when the ADD carries a time range, append the three
  // exact keys (objectName, time, date) AS ONE UNIT. n8n detects a time-range
  // add by their presence; absence means an ordinary add. DELETE never gets them.
  if (input.operation === 'ADD' && input.timeRange) {
    const { objectName, time, date } = deriveAclTimeRange(input.timeRange)
    body.objectName = objectName
    body.time = time
    body.date = date
  }

  const result = await callN8n({
    module: 'ACL',
    action: input.operation,
    correlationId,
    body,
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

/**
 * ACL EXECUTE — confirmed add/delete, delegated to n8n. A one-way operation runs
 * once (one audit row). A bidirectional ACL ADD runs TWICE via runAclDirection:
 * the forward direction then the reverse (source/destination + masks swapped),
 * each an independent n8n call with its own correlation id and its own audit
 * row. Both directions run regardless of the other's outcome (no rollback); the
 * combined result returns the forward direction at the top level with the
 * reverse nested under `reverse`. The iTop change-ticket guard runs ONCE up
 * front (both directions share the same ticket).
 */
export async function aclExecute(
  db: Database,
  ctx: AuditContext,
  rawInput: AclExecuteInput,
): Promise<OperationResult> {
  // Defense-in-depth: apply the ACL-ADD IP auto-correction server-side so a
  // direct API call (bypassing the form's on-blur fix) still executes, audits,
  // and previews the corrected 10.71.x address. From here ONLY the corrected
  // `input` is used, so nothing records an un-mapped-but-mappable IP. (Correct
  // first, then swap for the reverse direction.)
  const input = withCorrectedAclIps(rawInput)

  // Security guard: the UI forbids manual ticket entry (search + select only),
  // but a direct API call could still pass a well-formed yet FAKE ref. Confirm
  // the change ticket actually exists in iTop before executing. Run ONCE — both
  // directions of a bidirectional ADD share the same ticket. Block-total: if
  // iTop cannot verify (unreachable/unconfigured), reject rather than execute.
  const ticketRef = input.changeTicket
  try {
    const ticket = await getTicketByRef(ticketRef)
    if (ticket === null) {
      console.warn(`[acl] execute rejected: change ticket ${ticketRef} not found in iTop`)
      throw apiError(404, 'TICKET_NOT_FOUND', 'Change ticket not found in iTop')
    }
  }
  catch (err) {
    if (err instanceof ItopUnreachableError) {
      console.warn(`[acl] execute rejected: cannot verify change ticket ${ticketRef} (iTop unreachable)`)
      throw apiError(503, 'ITOP_UNREACHABLE', 'Cannot verify the change ticket: iTop is unreachable')
    }
    throw err
  }

  // Bidirectional ACL ADD: run the forward direction, then the reverse
  // (swapped) direction, BOTH regardless of each other's outcome. Each is a
  // self-contained n8n call + audit row via runAclDirection.
  if (input.operation === 'ADD' && input.bidirectional) {
    const forward = await runAclDirection(db, ctx, input)
    const reverse = await runAclDirection(db, ctx, reverseAclDirection(input))
    return { ...forward, reverse }
  }

  // One-way ACL add/delete (or ADD with bidirectional off): a single call.
  return runAclDirection(db, ctx, input)
}
