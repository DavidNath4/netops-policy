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
  changeTicket: ChangeTicketSchema,
})

/** ACL ADD field payload (with credentials). */
export const AclAddSchema = AclFields.merge(ExecCredentialsSchema)
export type AclAddInput = z.infer<typeof AclAddSchema>

/** ACL DELETE field payload (with credentials). */
export const AclDeleteSchema = AclFields.merge(ExecCredentialsSchema)
export type AclDeleteInput = z.infer<typeof AclDeleteSchema>

/**
 * Optional time-range for an ACL ADD. The user picks ONE date (`date`, an ISO
 * `yyyy-mm-dd` string from a native date input) and ONE time (`time`, 24h
 * `HH:mm`, default "23:59"). When present, the service derives the three exact
 * n8n keys (objectName, date, time) from this unit; its absence means an
 * ordinary ACL add. This is the source-of-truth shape (raw picker inputs); the
 * wire formatting lives server-side so DELETE and no-time-range ADD are
 * unaffected.
 */
export const AclTimeRangeSchema = z.object({
  // ISO yyyy-mm-dd from the date input; must be a real calendar date.
  date: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be a valid calendar date')
    .refine((v) => {
      const d = new Date(`${v}T00:00:00Z`)
      if (Number.isNaN(d.getTime())) return false
      // Reject rollovers like 2027-02-30 (Date would normalize them).
      return v === d.toISOString().slice(0, 10)
    }, 'Date must be a valid calendar date'),
  // 24-hour HH:mm; defaults to 23:59 when the user leaves it unchanged.
  time: z
    .string()
    .trim()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Time must be a valid 24-hour HH:mm')
    .default('23:59'),
})
export type AclTimeRangeInput = z.infer<typeof AclTimeRangeSchema>

/** Full English month names, indexed 0=January..11=December. */
const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const

/**
 * Derive the three exact n8n wire keys from a validated time-range input. Single
 * source of this wire format, shared by the service (the real n8n body) and the
 * command preview (display). Input `date` is an ISO `yyyy-mm-dd` string.
 * - `objectName`: `dd-MMM-yyyy`, MMM = lowercase 3-letter English month ("30-oct-2026").
 * - `date`: `dd MonthFullEnglish yyyy` ("30 October 2026").
 * - `time`: 24-hour `HH:mm` ("23:59").
 */
export function deriveAclTimeRange(tr: AclTimeRangeInput): {
  objectName: string
  date: string
  time: string
} {
  const [year, month, day] = tr.date.split('-')
  const monthFull = MONTH_NAMES[Number(month) - 1]!
  return {
    objectName: `${day}-${monthFull.slice(0, 3).toLowerCase()}-${year}`,
    date: `${day} ${monthFull} ${year}`,
    time: tr.time,
  }
}

/**
 * Preview request: which operation to preview + its fields. Only ADD/DELETE are
 * previewable (SHOW is read-only and runs immediately, no preview).
 */
export const AclPreviewSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('ADD') })
    .merge(AclFields)
    .merge(ExecCredentialsSchema)
    // Optional: present only for an ADD with a time range (all-or-none unit).
    .extend({ timeRange: AclTimeRangeSchema.optional() })
    // Optional bidirectional ADD (ADD only): when true the server ALSO adds the
    // reverse direction (source<->destination and their masks swapped) as a
    // second, independent n8n ACL ADD call. Absent/false = ordinary one-way add.
    .extend({ bidirectional: z.boolean().optional() }),
  z.object({ operation: z.literal('DELETE') }).merge(AclFields).merge(ExecCredentialsSchema),
])
export type AclPreviewInput = z.infer<typeof AclPreviewSchema>

/** Execute request: same shape as preview, but the server executes via n8n. */
export const AclExecuteSchema = AclPreviewSchema
export type AclExecuteInput = z.infer<typeof AclExecuteSchema>
