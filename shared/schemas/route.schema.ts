import { z } from 'zod'

import { ExecCredentialsSchema } from './n8n.schema'
import { ChangeTicketSchema, MaskSchema } from './network.schema'

// Route operation request payloads (Zod, runtime). Field payloads sent to n8n —
// not DB rows and not rendered command strings. Mirrors the ACL schemas.

/**
 * ROUTE SHOW — show-all, read-only, runs immediately. The n8n route/show
 * contract takes only credentials ({ user, pass }); there is no search value
 * (filtering happens client-side on the returned rows). `search` is accepted
 * but optional and ignored server-side. Credentials are auto-filled from the
 * caller's Device Session Credentials, not sent in the body.
 */
export const RouteShowSchema = z.object({
  search: z.string().trim().max(256).optional(),
})
export type RouteShowInput = z.infer<typeof RouteShowSchema>

/**
 * Fields for ROUTE ADD/DELETE: a route IP with an optional mask. UI phase —
 * ADD and DELETE share the same shape; the n8n contract is wired in later.
 */
const RouteFields = z.object({
  routeIp: z.string().trim().min(1, 'Route IP is required').max(64),
  routeMask: MaskSchema.optional(),
  changeTicket: ChangeTicketSchema.optional(),
})

/** ROUTE ADD field payload (with credentials). */
export const RouteAddSchema = RouteFields.merge(ExecCredentialsSchema)
export type RouteAddInput = z.infer<typeof RouteAddSchema>

/** ROUTE DELETE field payload (with credentials). */
export const RouteDeleteSchema = RouteFields.merge(ExecCredentialsSchema)
export type RouteDeleteInput = z.infer<typeof RouteDeleteSchema>

/** Preview request: which operation + its fields (ADD/DELETE only). */
export const RoutePreviewSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('ADD') }).merge(RouteFields).merge(ExecCredentialsSchema),
  z.object({ operation: z.literal('DELETE') }).merge(RouteFields).merge(ExecCredentialsSchema),
])
export type RoutePreviewInput = z.infer<typeof RoutePreviewSchema>

/** Execute request: same shape as preview, executed via n8n on the server. */
export const RouteExecuteSchema = RoutePreviewSchema
export type RouteExecuteInput = z.infer<typeof RouteExecuteSchema>
