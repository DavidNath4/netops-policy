import { z } from 'zod'

import { AclTimeRangeSchema } from './acl.schema'

// Time-range OBJECTS that already live on the device, fetched read-only from the
// authenticated n8n `POST /time/show` webhook (body `{ user, pass }`) so an ACL
// ADD can reference one by name (the "Select Existing" mode) instead of defining
// a brand-new object. These are NOT DB rows (there is no time-range table) and
// NOT rendered command strings — just the catalog the Add page shows in its
// dropdown.

/**
 * One raw time-range row as n8n returns it. Validated defensively: n8n may send
 * `null`/omit most fields (only `name` is relied on), so everything except the
 * name tolerates null/undefined. The app maps this to the clean client shape
 * below before anything leaves the server.
 */
export const N8nTimeRangeRowSchema = z.object({
  name: z.string(),
  type: z.string().nullish(),
  start_date: z.string().nullable().optional(),
  start_time: z.string().nullable().optional(),
  end_date: z.string().nullable().optional(),
  end_time: z.string().nullable().optional(),
  end_local: z.string().nullable().optional(),
  raw_config: z.string().nullable().optional(),
})
export type N8nTimeRangeRow = z.infer<typeof N8nTimeRangeRowSchema>

/**
 * The full `POST /time/show` response envelope. `data` defaults to `[]` so a
 * body missing the array still parses (the helper then returns an empty
 * catalog).
 */
export const N8nTimeShowResponseSchema = z.object({
  success: z.boolean().optional(),
  message: z.string().nullish(),
  total: z.number().nullish(),
  data: z.array(N8nTimeRangeRowSchema).default([]),
})
export type N8nTimeShowResponse = z.infer<typeof N8nTimeShowResponseSchema>

/**
 * Clean, mapped client shape — only the fields the Add page needs to label an
 * option (`name — ends <endDate> <endTime>`, falling back to `rawConfig`). The
 * snake_case n8n fields are mapped to camelCase here; nulls stay null.
 */
export const TimeRangeObjectSchema = z.object({
  name: z.string(),
  endDate: z.string().nullable(),
  endTime: z.string().nullable(),
  rawConfig: z.string().nullable(),
})
export type TimeRangeObject = z.infer<typeof TimeRangeObjectSchema>

/** The mapped list returned by the API to the client. */
export const TimeRangeListSchema = z.object({
  objects: z.array(TimeRangeObjectSchema),
})
export type TimeRangeList = z.infer<typeof TimeRangeListSchema>

/**
 * Request body the ACL ADD page sends to list the device's existing time-range
 * objects. The `time/show` webhook now authenticates like the other n8n calls,
 * so the device credentials typed on the Add page are POSTed (never in the URL/
 * logs). The server never persists them and redacts them from any audit.
 */
export const TimeRangeListRequestSchema = z.object({
  execUsername: z.string().trim().min(1).max(128),
  execPassword: z.string().min(1).max(256),
})
export type TimeRangeListRequestInput = z.infer<typeof TimeRangeListRequestSchema>

/** Map a validated raw n8n row to the clean client shape (undefined → null). */
export function toTimeRangeObject(row: N8nTimeRangeRow): TimeRangeObject {
  return {
    name: row.name,
    endDate: row.end_date ?? null,
    endTime: row.end_time ?? null,
    rawConfig: row.raw_config ?? null,
  }
}

// ---------------------------------------------------------------------------
// Time-range USAGE check (n8n `POST /time/isUsed`).
//
// Before an ACL DELETE removes an entry whose rule references a time-range
// object, the app asks n8n whether that object is still used by OTHER ACL rules.
// If it is, deleting this ACL (and letting the object be cleaned up) would
// orphan those other rules — so the app shows an advisory warning listing the
// device commands that still use it. Read-only: changes no device state, writes
// no audit row.
// ---------------------------------------------------------------------------

/** One usage row as n8n returns it for a single time-range object. */
export const N8nTimeUsageRowSchema = z.object({
  name: z.string(),
  is_used: z.boolean().optional(),
  usage_count: z.number().nullish(),
  raw_commands: z.array(z.string()).default([]),
})
export type N8nTimeUsageRow = z.infer<typeof N8nTimeUsageRowSchema>

/** The full `POST /time/isUsed` response envelope. `data` defaults to `[]`. */
export const N8nTimeUsageResponseSchema = z.object({
  success: z.boolean().optional(),
  message: z.string().nullish(),
  total: z.number().nullish(),
  data: z.array(N8nTimeUsageRowSchema).default([]),
})
export type N8nTimeUsageResponse = z.infer<typeof N8nTimeUsageResponseSchema>

/**
 * Request body the ACL DELETE page sends to check whether the time-range
 * object(s) referenced by the ACL being deleted are still used elsewhere. The
 * `objectName` list is derived client-side from the matched ACL row's rendered
 * command; credentials are the ones typed on the delete page. The server never
 * persists them and redacts them from any audit.
 */
export const TimeRangeUsageCheckSchema = z.object({
  objectNames: z.array(z.string().trim().min(1).max(128)).min(1).max(16),
  execUsername: z.string().trim().min(1).max(128),
  execPassword: z.string().min(1).max(256),
})
export type TimeRangeUsageCheckInput = z.infer<typeof TimeRangeUsageCheckSchema>

/** Clean, mapped client shape for one object's usage result. */
export const TimeRangeUsageSchema = z.object({
  name: z.string(),
  isUsed: z.boolean(),
  usageCount: z.number(),
  rawCommands: z.array(z.string()),
})
export type TimeRangeUsage = z.infer<typeof TimeRangeUsageSchema>

/** The mapped usage list returned by the API to the client. */
export const TimeRangeUsageListSchema = z.object({
  usages: z.array(TimeRangeUsageSchema),
})
export type TimeRangeUsageList = z.infer<typeof TimeRangeUsageListSchema>

/** Map a validated raw n8n usage row to the clean client shape. */
export function toTimeRangeUsage(row: N8nTimeUsageRow): TimeRangeUsage {
  return {
    name: row.name,
    isUsed: row.is_used ?? false,
    usageCount: row.usage_count ?? row.raw_commands.length,
    rawCommands: row.raw_commands,
  }
}

// ---------------------------------------------------------------------------
// Time Range OVERVIEW (the Time Range menu under ACL Policies).
//
// The Time Range page lists every device time-range object in a table with its
// end detail AND how many ACL rules reference it, and a row click shows those
// rules. This combines the two existing read-only webhooks — `time/show` (the
// object catalog) and `time/isUsed` (per-object usage + the raw ACL commands) —
// into ONE client shape so the page loads both in a single request. Credentials
// come from the caller's Device Session Credentials (like Show ACL/Routes), not
// the request body. Read-only: no audit, no device change.
// ---------------------------------------------------------------------------

/** One table row: a time-range object plus its ACL-rule usage. */
export const TimeRangeOverviewSchema = TimeRangeObjectSchema.extend({
  // How many ACL rules reference this object (from `time/isUsed`).
  usageCount: z.number(),
  // The raw ACL command lines that use it — shown in the row's usage pop-up and
  // filtered client-side (never a second API call).
  rawCommands: z.array(z.string()),
})
export type TimeRangeOverview = z.infer<typeof TimeRangeOverviewSchema>

/** The overview list returned by the API to the Time Range page. */
export const TimeRangeOverviewListSchema = z.object({
  items: z.array(TimeRangeOverviewSchema),
})
export type TimeRangeOverviewList = z.infer<typeof TimeRangeOverviewListSchema>

// ---------------------------------------------------------------------------
// Time Range ADD (create a standalone object via n8n `POST /time/add`).
//
// Two modes, discriminated on `mode` (mirrors the ACL ADD time-range unit):
// - `date`: pick a date (+ optional HH:mm, default 23:59); the server derives
//           the object name `dd-mmm-yyyy` via `deriveAclTimeRange` — identical
//           to the ACL Add "Create New" flow.
// - `named`: type a free-form object name; the date + time still come from the
//            same picker, but the name is taken verbatim.
// Either way the server sends the SAME three keys to n8n (objectName, date,
// time). Credentials come from the Device Session Credentials, not the body.
// ---------------------------------------------------------------------------

/** `date` mode: reuse the existing `{ date, time }` unit (23:59 default). */
export const TimeRangeAddDateSchema = AclTimeRangeSchema.extend({
  mode: z.literal('date'),
})
export type TimeRangeAddDateInput = z.infer<typeof TimeRangeAddDateSchema>

/** A device time-range object name: no spaces, a safe character set, <=128. */
const TimeRangeObjectNameSchema = z
  .string()
  .trim()
  .min(1, 'Object name is required')
  .max(128, 'Object name must be at most 128 characters')
  .regex(/^[A-Za-z0-9._-]+$/, 'Use letters, digits, dot, underscore or hyphen (no spaces)')

/** `named` mode: a typed object name + the same date/time picker unit. */
export const TimeRangeAddNamedSchema = AclTimeRangeSchema.extend({
  mode: z.literal('named'),
  objectName: TimeRangeObjectNameSchema,
})
export type TimeRangeAddNamedInput = z.infer<typeof TimeRangeAddNamedSchema>

/** The ADD request body (discriminated on `mode`). No credentials — the server
 *  auto-fills them from the Device Session Credentials. */
export const TimeRangeAddSchema = z.discriminatedUnion('mode', [
  TimeRangeAddDateSchema,
  TimeRangeAddNamedSchema,
])
export type TimeRangeAddInput = z.infer<typeof TimeRangeAddSchema>

/** Result of a create: the final object name + n8n's status/message. */
export const TimeRangeAddResultSchema = z.object({
  status: z.enum(['SUCCESS', 'FAILED']),
  objectName: z.string(),
  message: z.string().nullable(),
})
export type TimeRangeAddResult = z.infer<typeof TimeRangeAddResultSchema>

// ---------------------------------------------------------------------------
// Time Range DELETE (remove a standalone object via n8n `POST /time/safeDelete`).
//
// Safe delete: n8n re-checks the device for ACL rules that reference the object
// and REFUSES when any still use it (returning those rules), so the app never
// orphans a rule. The Time Range page also disables Delete up front when the
// loaded usageCount > 0; this is the server/device-side safety net. Credentials
// come from the Device Session Credentials, not the body. Writes one audit row.
// ---------------------------------------------------------------------------

/** The DELETE request body — just the object name (creds auto-filled server-side). */
export const TimeRangeDeleteSchema = z.object({
  objectName: z
    .string()
    .trim()
    .min(1, 'Object name is required')
    .max(128, 'Object name must be at most 128 characters'),
})
export type TimeRangeDeleteInput = z.infer<typeof TimeRangeDeleteSchema>

/** One ACL rule still using the object (returned when delete is refused). */
export const TimeRangeBlockingRuleSchema = z.object({
  aclName: z.string().nullable(),
  rawRule: z.string(),
})
export type TimeRangeBlockingRule = z.infer<typeof TimeRangeBlockingRuleSchema>

/** Result of a delete: status + the object name + n8n's message, plus the ACL
 *  rules that blocked it (empty unless n8n refused for OBJECT_IN_USE). */
export const TimeRangeDeleteResultSchema = z.object({
  status: z.enum(['SUCCESS', 'FAILED']),
  objectName: z.string(),
  message: z.string().nullable(),
  // When the delete was refused because the object is still used, the ACL rules
  // that reference it — shown in the warning pop-up.
  blockingRules: z.array(TimeRangeBlockingRuleSchema),
})
export type TimeRangeDeleteResult = z.infer<typeof TimeRangeDeleteResultSchema>
