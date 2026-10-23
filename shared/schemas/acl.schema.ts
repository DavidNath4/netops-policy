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
  // Optional per-request device credentials. The ACL Add/Delete "Generate"
  // pre-check sends the credentials typed ON THAT page so the lookup runs as
  // that engineer. When BOTH are present the server uses them; otherwise it
  // falls back to the caller's Device Session Credentials (the search page,
  // which has no credential inputs, relies on that fallback). Never persisted.
  execUsername: z.string().trim().min(1).max(128).optional(),
  execPassword: z.string().min(1).max(256).optional(),
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

/**
 * The ACL ADD time range comes in TWO modes, discriminated on `mode`:
 *
 * - `new`:      define a brand-new object — the existing `{ date, time }` unit
 *               (same validation + the 23:59 default) tagged with `mode: 'new'`.
 *               The service derives the three n8n keys (objectName/date/time)
 *               via `deriveAclTimeRange`, exactly as before.
 * - `existing`: reference an object that already lives on the device, picked by
 *               its opaque `objectName` (from `GET /time/show`). The service
 *               sends ONLY `objectName` — never a date or time — and the preview
 *               references it without the time-range definition lines.
 *
 * Either mode is optional on the ADD branch; its absence is an ordinary add.
 * DELETE/SHOW never carry a time range.
 */
export const AclTimeRangeNewSchema = AclTimeRangeSchema.extend({
  mode: z.literal('new'),
})
export type AclTimeRangeNewInput = z.infer<typeof AclTimeRangeNewSchema>

export const AclTimeRangeExistingSchema = z.object({
  mode: z.literal('existing'),
  objectName: z
    .string()
    .trim()
    .min(1, 'Select a time range object')
    .max(128, 'Time range object name must be at most 128 characters'),
})
export type AclTimeRangeExistingInput = z.infer<typeof AclTimeRangeExistingSchema>

export const AclAddTimeRangeSchema = z.discriminatedUnion('mode', [
  AclTimeRangeExistingSchema,
  AclTimeRangeNewSchema,
])
export type AclAddTimeRange = z.infer<typeof AclAddTimeRangeSchema>

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
    // Optional: present only for an ADD with a time range. Discriminated on
    // `mode` — `new` carries the `{date,time}` unit (derived server-side),
    // `existing` carries only the picked `objectName`.
    .extend({ timeRange: AclAddTimeRangeSchema.optional() })
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

// ---------------------------------------------------------------------------
// BULK ADD ACL
// ---------------------------------------------------------------------------
// Add several source<->destination pairs in ONE batch under ONE iTop ticket and
// ONE set of device credentials. Bulk is NOT a new n8n contract: the service
// loops the existing per-direction `acl/add` call (exactly as the bidirectional
// ADD already does), so each direction keeps its own correlation id and audit
// row. Only ADD is bulk-able (SHOW/DELETE are untouched).

/** Max number of DIRECTIONS a single batch may run (rows x2 when bidirectional). */
export const ACL_BULK_MAX_DIRECTIONS = 20

/**
 * One row of a bulk ADD: a source+destination pair (each IP + optional mask) and
 * an optional per-row time range (same `new`/`existing` modes as a single ADD).
 * A row carries NO changeTicket and NO credentials — those are batch-global so
 * the whole batch is one tracked change under one ticket, run as one engineer.
 */
export const AclBulkItemSchema = z.object({
  source: z.string().trim().min(1, 'Source is required').max(64),
  sourceMask: MaskSchema.optional(),
  destination: z.string().trim().min(1, 'Destination is required').max(64),
  destinationMask: MaskSchema.optional(),
  timeRange: AclAddTimeRangeSchema.optional(),
  // PER-ROW bidirectional: when true, THIS row also adds the reverse direction
  // (source<->destination and masks swapped) as a second independent n8n call.
  // Decided per row, so a batch may mix one-way and two-way rows (the total
  // direction count can be odd).
  bidirectional: z.boolean().optional(),
})
export type AclBulkItemInput = z.infer<typeof AclBulkItemSchema>

/**
 * Bulk ADD payload: the rows plus the batch-global change ticket and
 * credentials (one ticket tracks the whole batch; one engineer runs it).
 * `bidirectional` is PER ROW on each item, NOT batch-global. `superRefine`
 * enforces the 20-DIRECTION ceiling as the SUM over rows — each row counts 1,
 * or 2 when its own `bidirectional` is on — so a mixed batch may total an odd
 * number of directions.
 */
export const AclBulkExecuteSchema = z
  .object({
    items: z
      .array(AclBulkItemSchema)
      .min(1, 'Add at least one ACL row')
      .max(ACL_BULK_MAX_DIRECTIONS, `A batch may have at most ${ACL_BULK_MAX_DIRECTIONS} rows`),
    changeTicket: ChangeTicketSchema,
  })
  .merge(ExecCredentialsSchema)
  .superRefine((v, ctx) => {
    const directions = v.items.reduce((sum, item) => sum + (item.bidirectional ? 2 : 1), 0)
    if (directions > ACL_BULK_MAX_DIRECTIONS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['items'],
        message: `A batch may run at most ${ACL_BULK_MAX_DIRECTIONS} directions (each bidirectional row counts as 2).`,
      })
    }
  })
export type AclBulkExecuteInput = z.infer<typeof AclBulkExecuteSchema>

/** Preview request for a bulk ADD — same shape as execute. */
export const AclBulkPreviewSchema = AclBulkExecuteSchema
export type AclBulkPreviewInput = z.infer<typeof AclBulkPreviewSchema>
