import { z } from 'zod'

// iTop (read-only MariaDB) ticket search/preview shapes. Zod is the source of
// truth; types are derived via z.infer (no parallel hand-written interfaces).
// These are the client+server contract — never a raw DB row.

/** Ticket subtype labels the API exposes (derived from finalclass). */
export const ItopTicketTypeSchema = z.enum([
  'UserRequest',
  'Incident',
  'Problem',
  'Change',
  'NormalChange',
  'RoutineChange',
  'EmergencyChange',
  'Unknown',
])
export type ItopTicketType = z.infer<typeof ItopTicketTypeSchema>

/** Search request body (POST). */
export const ItopTicketSearchSchema = z.object({
  q: z
    .string()
    .trim()
    .min(1, 'Search value is required')
    .max(64, 'Search value must be at most 64 characters'),
  limit: z.coerce.number().int().positive().max(50).default(20),
})
export type ItopTicketSearchInput = z.infer<typeof ItopTicketSearchSchema>

/** Preview request body (POST) — selected ticket ref. */
export const ItopTicketRefSchema = z.object({
  ref: z.string().trim().min(1).max(64),
})
export type ItopTicketRefInput = z.infer<typeof ItopTicketRefSchema>

/** List item — parent `ticket` columns only, no secrets. */
export const ItopTicketSummarySchema = z.object({
  ref: z.string(),
  title: z.string(),
  type: ItopTicketTypeSchema, // from finalclass
  operationalStatus: z.string().nullable(),
  startDate: z.string().nullable(), // ISO string (DATETIME -> string)
  endDate: z.string().nullable(),
})
export type ItopTicketSummary = z.infer<typeof ItopTicketSummarySchema>

/** Resolved people/org for the preview header. */
export const ItopTicketPartySchema = z.object({
  name: z.string().nullable(),
  email: z.string().nullable(),
})

/**
 * Per-type detail block. A pragmatic common header plus optional fields that
 * only some types have — the UI renders whatever is present (no v-if explosion).
 * All optional/nullable so one shape covers every type.
 */
export const ItopTicketDetailBlockSchema = z.object({
  status: z.string().nullable().optional(), // subtype status (distinct from operational_status)
  impact: z.string().nullable().optional(),
  priority: z.string().nullable().optional(),
  urgency: z.string().nullable().optional(),
  origin: z.string().nullable().optional(),
  // Change-only
  reason: z.string().nullable().optional(),
  outage: z.string().nullable().optional(),
  fallback: z.string().nullable().optional(),
  acceptanceComment: z.string().nullable().optional(),
  // Request/Incident-only
  resolutionCode: z.string().nullable().optional(),
  solution: z.string().nullable().optional(),
})
export type ItopTicketDetailBlock = z.infer<typeof ItopTicketDetailBlockSchema>

/** Full preview response. */
export const ItopTicketDetailSchema = ItopTicketSummarySchema.extend({
  description: z.string().nullable(), // plain text, UI escapes it
  caller: ItopTicketPartySchema, // resolved from caller_id/requestor_id -> contact
  organization: z.object({ name: z.string().nullable() }),
  detail: ItopTicketDetailBlockSchema,
})
export type ItopTicketDetail = z.infer<typeof ItopTicketDetailSchema>

/**
 * Shared result shape for BOTH Test Connection endpoints (iTop AND n8n).
 * It lives in itop.schema.ts for proximity to the iTop work; this is
 * intentional and both /api/itop/test and /api/n8n/test import it from here.
 */
export const ConnectionTestResultSchema = z.object({
  ok: z.boolean(),
  message: z.string(),
})
export type ConnectionTestResult = z.infer<typeof ConnectionTestResultSchema>
