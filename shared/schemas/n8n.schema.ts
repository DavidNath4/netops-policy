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
  output: z.string().nullable().optional(),
  error: z.string().nullable().optional(),
  device: z.string().optional(),
  execution: N8nExecutionMetaSchema.optional(),
  correlationId: CorrelationIdSchema.optional(),
})
export type N8nResult = z.infer<typeof N8nResultSchema>

/**
 * Client-facing result of a show/execute. Excludes all secrets; carries the
 * correlation id so the UI/audit can be tied together.
 */
export const OperationResultSchema = z.object({
  correlationId: CorrelationIdSchema,
  status: OutcomeSchema,
  output: z.string().nullable(),
  error: z.string().nullable(),
})
export type OperationResult = z.infer<typeof OperationResultSchema>
