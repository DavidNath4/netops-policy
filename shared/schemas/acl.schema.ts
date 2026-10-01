import { z } from 'zod'

import { ExecCredentialsSchema } from './n8n.schema'
import { ChangeTicketSchema, MaskSchema } from './network.schema'

// ACL operation request payloads (Zod, runtime). These are field payloads sent
// to n8n — NOT DB rows (there is no acl_policies table) and NOT rendered command
// strings. Exact field sets may be tuned to n8n; audit uses flexible JSONB.
//
// Server-controlled values (correlationId, audit status) are never in these
// schemas, so a client cannot set them.

/**
 * ACL SHOW — search-only, read-only, runs immediately. Carries a required search
 * value (an IP address); credentials are NOT in the body — the server auto-fills
 * them from the caller's Device Session Credentials.
 */
export const AclShowSchema = z.object({
  search: z
    .string()
    .trim()
    .min(1, 'Search value is required')
    .max(256, 'Search value must be at most 256 characters'),
})
export type AclShowInput = z.infer<typeof AclShowSchema>

/**
 * Fields for ACL ADD/DELETE, matching the n8n contract: a source and a
 * destination, each an IP with an optional mask. The service joins "IP MASK"
 * before sending. ADD and DELETE share the same shape for now (dev phase);
 * extra fields (name, protocol, audit metadata) are added back as needed.
 */
const AclFields = z.object({
  source: z.string().trim().min(1, 'Source is required').max(64),
  sourceMask: MaskSchema.optional(),
  destination: z.string().trim().min(1, 'Destination is required').max(64),
  destinationMask: MaskSchema.optional(),
  changeTicket: ChangeTicketSchema.optional(),
})

/** ACL ADD field payload (with credentials). */
export const AclAddSchema = AclFields.merge(ExecCredentialsSchema)
export type AclAddInput = z.infer<typeof AclAddSchema>

/** ACL DELETE field payload (with credentials). */
export const AclDeleteSchema = AclFields.merge(ExecCredentialsSchema)
export type AclDeleteInput = z.infer<typeof AclDeleteSchema>

/**
 * Preview request: which operation to preview + its fields. Only ADD/DELETE are
 * previewable (SHOW is read-only and runs immediately, no preview).
 */
export const AclPreviewSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('ADD') }).merge(AclFields).merge(ExecCredentialsSchema),
  z.object({ operation: z.literal('DELETE') }).merge(AclFields).merge(ExecCredentialsSchema),
])
export type AclPreviewInput = z.infer<typeof AclPreviewSchema>

/** Execute request: same shape as preview, but the server executes via n8n. */
export const AclExecuteSchema = AclPreviewSchema
export type AclExecuteInput = z.infer<typeof AclExecuteSchema>
