import { z } from 'zod'

import { CorrelationIdSchema, PaginationQuerySchema } from './common.schema'

// Exec-log (ACL/ROUTE detail) query + response shapes. acl_logs / route_logs are
// COMPLEMENT detail tables to audit_logs for execution inspection; these types
// are the safe, client-facing view of them. The three JSONB fields are already
// redacted at write time, so they are safe to surface; they are typed as unknown
// because their shape is intentionally flexible (tracks n8n without a migration).

export const ExecLogActionSchema = z.enum(['SHOW', 'ADD', 'DELETE'])
export type ExecLogAction = z.infer<typeof ExecLogActionSchema>

export const ExecLogStatusSchema = z.enum(['SUCCESS', 'FAILED'])
export type ExecLogStatus = z.infer<typeof ExecLogStatusSchema>

/** Fields common to both ACL and ROUTE detail responses. */
const ExecLogBaseFields = {
  id: z.string().uuid(),
  auditId: z.string().uuid(),
  correlationId: z.string().uuid(),
  action: ExecLogActionSchema,
  status: ExecLogStatusSchema,
  device: z.string().nullable(),
  commandPreview: z.unknown().nullable(),
  executionMeta: z.unknown().nullable(),
  responseSummary: z.unknown().nullable(),
  createdAt: z.string(),
}

/** Safe outbound ACL detail-log shape. JSONB fields are pre-redacted. */
export const AclLogResponseSchema = z.object({
  ...ExecLogBaseFields,
  source: z.string().nullable(),
  destination: z.string().nullable(),
})
export type AclLogResponse = z.infer<typeof AclLogResponseSchema>

/** Safe outbound ROUTE detail-log shape. JSONB fields are pre-redacted. */
export const RouteLogResponseSchema = z.object({
  ...ExecLogBaseFields,
  destination: z.string().nullable(),
  changeTicket: z.string().nullable(),
})
export type RouteLogResponse = z.infer<typeof RouteLogResponseSchema>

/** ACL-log list query: pagination + filters (action/status/correlation/date). */
export const AclLogQuerySchema = PaginationQuerySchema.extend({
  action: ExecLogActionSchema.optional(),
  status: ExecLogStatusSchema.optional(),
  correlationId: CorrelationIdSchema.optional(),
  from: z.string().trim().optional(),
  to: z.string().trim().optional(),
})
export type AclLogQuery = z.infer<typeof AclLogQuerySchema>

/** ROUTE-log list query: ACL filters + a change-ticket filter. */
export const RouteLogQuerySchema = AclLogQuerySchema.extend({
  changeTicket: z.string().trim().max(64).optional(),
})
export type RouteLogQuery = z.infer<typeof RouteLogQuerySchema>
