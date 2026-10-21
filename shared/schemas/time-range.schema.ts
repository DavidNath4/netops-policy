import { z } from 'zod'

// Time-range OBJECTS that already live on the device, fetched read-only from the
// n8n `GET /time/show` webhook so an ACL ADD can reference one by name (the
// "Select Existing" mode) instead of defining a brand-new object. These are NOT
// DB rows (there is no time-range table) and NOT rendered command strings — just
// the catalog the Add page shows in its dropdown.

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
 * The full `GET /time/show` response envelope. `data` defaults to `[]` so a body
 * missing the array still parses (the helper then returns an empty catalog).
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
