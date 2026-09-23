import { z } from 'zod'

import { CorrelationIdSchema, PaginationQuerySchema } from './common.schema'

// Audit log query + response shapes. The audit_logs table is the app's system of
// record; these types are the safe, client-facing view of it. The four JSONB
// payloads are already redacted at write time, so they are safe to surface; they
// are typed as unknown because their shape is intentionally flexible.

export const AuditModuleSchema = z.enum(['AUTH', 'USER', 'ACL', 'ROUTE', 'N8N'])
export type AuditModule = z.infer<typeof AuditModuleSchema>

export const AuditActionSchema = z.enum(['LOGIN', 'SHOW', 'ADD', 'DELETE', 'UPDATE'])
export type AuditAction = z.infer<typeof AuditActionSchema>

export const AuditStatusSchema = z.enum(['SUCCESS', 'FAILED'])
export type AuditStatus = z.infer<typeof AuditStatusSchema>

/** Log Trail query: pagination + filters (module/action/status/ticket/date/correlation). */
export const AuditQuerySchema = PaginationQuerySchema.extend({
  module: AuditModuleSchema.optional(),
  action: AuditActionSchema.optional(),
  status: AuditStatusSchema.optional(),
  changeTicket: z.string().trim().max(64).optional(),
  correlationId: CorrelationIdSchema.optional(),
  from: z.string().trim().optional(),
  to: z.string().trim().optional(),
})
export type AuditQuery = z.infer<typeof AuditQuerySchema>

/** Safe outbound audit shape. Payloads are pre-redacted, hence safe to surface. */
export const AuditResponseSchema = z.object({
  id: z.string().uuid(),
  createdAt: z.string(),
  userId: z.string().uuid().nullable(),
  username: z.string().nullable(),
  userRole: z.string().nullable(),
  module: AuditModuleSchema,
  action: AuditActionSchema,
  status: AuditStatusSchema,
  sourceIp: z.string().nullable(),
  userAgent: z.string().nullable(),
  changeTicket: z.string().nullable(),
  correlationId: z.string().uuid(),
  requestPayload: z.unknown().nullable(),
  commandPayload: z.unknown().nullable(),
  executionPayload: z.unknown().nullable(),
  responsePayload: z.unknown().nullable(),
})
export type AuditResponse = z.infer<typeof AuditResponseSchema>
