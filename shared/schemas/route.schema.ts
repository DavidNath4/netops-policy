import { z } from 'zod'

import { ExecCredentialsSchema } from './n8n.schema'
import {
  ChangeTicketSchema,
  CidrSchema,
  IpAddressSchema,
  TimeRangeSchema,
} from './network.schema'

// Route operation request payloads (Zod, runtime). Field payloads sent to n8n —
// not DB rows and not rendered command strings. Mirrors the ACL schemas.

/** ROUTE SHOW — read-only, runs immediately. A single filter value. */
export const RouteShowSchema = z
  .object({
    filter: z
      .string()
      .trim()
      .min(1, 'Filter is required')
      .max(256, 'Filter must be at most 256 characters'),
  })
  .merge(ExecCredentialsSchema)
export type RouteShowInput = z.infer<typeof RouteShowSchema>

/** Fields collected for a ROUTE ADD (before credentials are merged). */
const RouteAddFields = z.object({
  name: z.string().trim().min(1, 'Name is required').max(128, 'Name must be at most 128 characters'),
  destination: CidrSchema,
  source: z.string().trim().min(1).max(64).optional(),
  nextHop: IpAddressSchema,
  policy: z.string().trim().max(128).optional(),
  timeRange: TimeRangeSchema.optional(),
  changeTicket: ChangeTicketSchema.optional(),
})

/** ROUTE ADD field payload (with credentials). */
export const RouteAddSchema = RouteAddFields.merge(ExecCredentialsSchema)
export type RouteAddInput = z.infer<typeof RouteAddSchema>

/** Fields collected for a ROUTE DELETE (before credentials are merged). */
const RouteDeleteFields = z.object({
  destination: CidrSchema,
  nextHop: IpAddressSchema.optional(),
  changeTicket: ChangeTicketSchema.optional(),
})

/** ROUTE DELETE field payload (with credentials). */
export const RouteDeleteSchema = RouteDeleteFields.merge(ExecCredentialsSchema)
export type RouteDeleteInput = z.infer<typeof RouteDeleteSchema>

/** Preview request: which operation + its fields (ADD/DELETE only). */
export const RoutePreviewSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('ADD') }).merge(RouteAddFields).merge(ExecCredentialsSchema),
  z.object({ operation: z.literal('DELETE') }).merge(RouteDeleteFields).merge(ExecCredentialsSchema),
])
export type RoutePreviewInput = z.infer<typeof RoutePreviewSchema>

/** Execute request: same shape as preview, executed via n8n on the server. */
export const RouteExecuteSchema = RoutePreviewSchema
export type RouteExecuteInput = z.infer<typeof RouteExecuteSchema>
