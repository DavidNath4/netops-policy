import { z } from 'zod'

import { ExecCredentialsSchema } from './n8n.schema'
import {
  AclActionSchema,
  ChangeTicketSchema,
  DescriptionSchema,
  MaskSchema,
  PortSchema,
  ProtocolSchema,
  TimeRangeSchema,
} from './network.schema'

// ACL operation request payloads (Zod, runtime). These are field payloads sent
// to n8n — NOT DB rows (there is no acl_policies table) and NOT rendered command
// strings. Exact field sets may be tuned to n8n; audit uses flexible JSONB.
//
// Server-controlled values (correlationId, audit status) are never in these
// schemas, so a client cannot set them.

/** ACL SHOW — read-only, runs immediately. A single filter value. */
export const AclShowSchema = z
  .object({
    filter: z
      .string()
      .trim()
      .min(1, 'Filter is required')
      .max(256, 'Filter must be at most 256 characters'),
  })
  .merge(ExecCredentialsSchema)
export type AclShowInput = z.infer<typeof AclShowSchema>

/** Fields collected for an ACL ADD (before credentials are merged). */
const AclAddFields = z.object({
  name: z.string().trim().min(1, 'Name is required').max(128, 'Name must be at most 128 characters'),
  source: z.string().trim().min(1, 'Source is required').max(64),
  sourceMask: MaskSchema.optional(),
  destination: z.string().trim().min(1, 'Destination is required').max(64),
  destinationMask: MaskSchema.optional(),
  protocol: ProtocolSchema,
  port: PortSchema.optional(),
  action: AclActionSchema,
  timeRange: TimeRangeSchema.optional(),
  changeTicket: ChangeTicketSchema.optional(),
  description: DescriptionSchema.optional(),
})

/**
 * Cross-field protocol/port rule: TCP/UDP require a port; ICMP/ANY must not
 * carry one.
 */
function applyPortRules(v: { protocol: string, port?: number }, ctx: z.RefinementCtx): void {
  const needsPort = v.protocol === 'TCP' || v.protocol === 'UDP'
  if (needsPort && v.port === undefined) {
    ctx.addIssue({ code: 'custom', path: ['port'], message: 'Port is required for TCP/UDP' })
  }
  if (!needsPort && v.port !== undefined) {
    ctx.addIssue({ code: 'custom', path: ['port'], message: 'Port is not allowed for ICMP/ANY' })
  }
}

/** ACL ADD field payload (with credentials). */
export const AclAddSchema = AclAddFields.merge(ExecCredentialsSchema).superRefine(applyPortRules)
export type AclAddInput = z.infer<typeof AclAddSchema>

/** Fields collected for an ACL DELETE (before credentials are merged). */
const AclDeleteFields = z.object({
  name: z.string().trim().min(1, 'Name is required').max(128),
  source: z.string().trim().min(1, 'Source is required').max(64),
  destination: z.string().trim().min(1, 'Destination is required').max(64),
  changeTicket: ChangeTicketSchema.optional(),
})

/** ACL DELETE field payload (with credentials). */
export const AclDeleteSchema = AclDeleteFields.merge(ExecCredentialsSchema)
export type AclDeleteInput = z.infer<typeof AclDeleteSchema>

/**
 * Preview request: which operation to preview + its fields. Only ADD/DELETE are
 * previewable (SHOW is read-only and runs immediately, no preview).
 */
export const AclPreviewSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('ADD') }).merge(AclAddFields).merge(ExecCredentialsSchema).superRefine(applyPortRules),
  z.object({ operation: z.literal('DELETE') }).merge(AclDeleteFields).merge(ExecCredentialsSchema),
])
export type AclPreviewInput = z.infer<typeof AclPreviewSchema>

/** Execute request: same shape as preview, but the server executes via n8n. */
export const AclExecuteSchema = AclPreviewSchema
export type AclExecuteInput = z.infer<typeof AclExecuteSchema>
