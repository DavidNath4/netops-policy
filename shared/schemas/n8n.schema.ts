import { z } from 'zod'

import { CorrelationIdSchema } from './common.schema'

// Contract between the app and n8n, plus the client-facing operation result.
//
// SECURITY: ExecCredentials are forwarded to n8n so it can act as the engineer,
// but they are NEVER persisted, NEVER returned to the client, and appear only as
// `***` in previews and audit. They are a separate object merged into each
// operation's request schema (see acl/route schemas).

/** Module + action a request/operation targets. */
export const ModuleSchema = z.enum(['ACL', 'ROUTE'])
export type Module = z.infer<typeof ModuleSchema>

export const OperationSchema = z.enum(['SHOW', 'ADD', 'DELETE'])
export type Operation = z.infer<typeof OperationSchema>

/** SUCCESS | FAILED outcome shared by results and the audit status. */
export const OutcomeSchema = z.enum(['SUCCESS', 'FAILED'])
export type Outcome = z.infer<typeof OutcomeSchema>

/**
 * Per-engineer execution credentials, supplied on every operation and forwarded
 * to n8n. Never persisted, never returned, redacted to `***` in preview/audit.
 */
export const ExecCredentialsSchema = z.object({
  execUsername: z
    .string()
    .trim()
    .min(1, 'Execution username is required')
    .max(128, 'Execution username must be at most 128 characters'),
  execPassword: z
    .string()
    .min(1, 'Execution password is required')
    .max(256, 'Execution password must be at most 256 characters'),
})
export type ExecCredentials = z.infer<typeof ExecCredentialsSchema>

/**
 * Body for setting the Device Session Credentials (read-path convenience). Held
 * encrypted on the session row; see the n8n Integration spec (Req 11).
 */
export const DeviceCredentialsSchema = z.object({
  username: z.string().trim().min(1, 'Username is required').max(128),
  password: z.string().min(1, 'Password is required').max(256),
})
export type DeviceCredentialsInput = z.infer<typeof DeviceCredentialsSchema>

/**
 * n8n execution metadata (best-effort). Stored in audit.execution_payload.
 * All fields optional so a partial/missing block never fails the audit write.
 */
export const N8nExecutionMetaSchema = z.object({
  executor: z.string().optional(),
  workflowId: z.string().optional(),
  executionId: z.string().optional(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  durationMs: z.number().optional(),
})
export type N8nExecutionMeta = z.infer<typeof N8nExecutionMetaSchema>

/**
 * Normalized result the N8N_Client returns to the service after a call.
 * `output`/`error` are safe (no credentials, no secrets).
 */
export const N8nResultSchema = z.object({
  status: OutcomeSchema,
  message: z.string().nullable().optional(),
  total: z.number().nullable().optional(),
  items: z.array(z.unknown()).nullable().optional(),
  output: z.string().nullable().optional(),
  error: z.string().nullable().optional(),
  device: z.string().optional(),
  execution: N8nExecutionMetaSchema.optional(),
  correlationId: CorrelationIdSchema.optional(),
})
export type N8nResult = z.infer<typeof N8nResultSchema>

/**
 * Client-facing result of a show/execute. Excludes all secrets; carries the
 * correlation id so the UI/audit can be tied together. `items`/`total` carry a
 * structured result (e.g. ACL show rows) for table rendering; `output` is the
 * raw text fallback; `message` is n8n's human message.
 */
const OperationResultBase = z.object({
  correlationId: CorrelationIdSchema,
  status: OutcomeSchema,
  message: z.string().nullable(),
  total: z.number().nullable(),
  items: z.array(z.unknown()).nullable(),
  output: z.string().nullable(),
  error: z.string().nullable(),
})

/**
 * A one-way execute returns no `reverse`. A bidirectional ACL ADD returns the
 * primary (forward) direction's fields at the top level plus the second
 * (reverse) direction nested under `reverse` — each direction has its own
 * correlation id and its own audit row; neither is nested inside the other
 * beyond this one optional level.
 */
export const OperationResultSchema = OperationResultBase.extend({
  reverse: OperationResultBase.optional(),
})
export type OperationResult = z.infer<typeof OperationResultSchema>

// ---------------------------------------------------------------------------
// BULK ADD ACL results
// ---------------------------------------------------------------------------
// Bulk preview/execute return a per-row result so the UI can render each row's
// status independently. These are server->client shapes (no secrets); they
// reuse OperationResult for the executed-row outcome.

/** One row of a bulk preview: its classification + redacted command lines. */
export const AclBulkPreviewRowSchema = z.object({
  index: z.number().int().nonnegative(),
  source: z.string(),
  destination: z.string(),
  // NEW          = valid and not on the device yet (will be added).
  // EXISTS       = the source→destination pair already exists on the device.
  // TR_DUPLICATE = the row's "Create New" time-range name clashes with an
  //                existing device object OR with another row's new time range.
  // EXISTS and TR_DUPLICATE both block the batch until the row is fixed/removed.
  status: z.enum(['NEW', 'EXISTS', 'TR_DUPLICATE']),
  // Human-readable reason shown for a blocking row (null for NEW).
  reason: z.string().nullable(),
  command: z.array(z.string()),
})
export type AclBulkPreviewRow = z.infer<typeof AclBulkPreviewRowSchema>

/** Bulk preview result: every row + whether any EXISTS row blocks execute. */
export const AclBulkPreviewResultSchema = z.object({
  rows: z.array(AclBulkPreviewRowSchema),
  // True when at least one row is EXISTS; the UI disables Execute while true.
  hasBlocking: z.boolean(),
})
export type AclBulkPreviewResult = z.infer<typeof AclBulkPreviewResultSchema>

/** One executed row: forward outcome + optional reverse (bidirectional). */
export const AclBulkExecuteRowSchema = z.object({
  index: z.number().int().nonnegative(),
  source: z.string(),
  destination: z.string(),
  forward: OperationResultBase,
  reverse: OperationResultBase.nullable().optional(),
})
export type AclBulkExecuteRow = z.infer<typeof AclBulkExecuteRowSchema>

/** Bulk execute result: every executed row + overall success. */
export const AclBulkExecuteResultSchema = z.object({
  rows: z.array(AclBulkExecuteRowSchema),
  // True only when every direction of every row succeeded.
  allOk: z.boolean(),
})
export type AclBulkExecuteResult = z.infer<typeof AclBulkExecuteResultSchema>
