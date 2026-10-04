import {
  getChangeDetail,
  getIncidentDetail,
  getProblemDetail,
  getRequestDetail,
  getTicketByRef,
  resolveContacts,
  resolveOrganizations,
  searchTickets,
} from '../network/itop-client'
import type { ChangeDetailRow, ContactRow, OrgRow, ProblemDetailRow, RequestDetailRow, TicketRow } from '../network/itop-client'
import type {
  ItopTicketDetail,
  ItopTicketDetailBlock,
  ItopTicketSearchInput,
  ItopTicketSummary,
  ItopTicketType,
} from '#shared/schemas/itop.schema'

// iTop business logic: the finalclass resolver (class-table inheritance) and the
// row -> Zod-response-shape mappers. NEVER returns a raw DB row — only the mapped,
// whitelisted shapes from shared/schemas/itop.schema.ts.

interface ItopClassInfo {
  type: ItopTicketType
  detailTable: 'ticket_request' | 'ticket_incident' | 'ticket_problem' | 'change' | null
}

/**
 * Resolve the concrete subclass from the parent `ticket.finalclass`. Driven by
 * finalclass, NOT by the ref prefix. Unknown/unmatched -> type 'Unknown' with no
 * detail table (defensive: preview still returns summary + description).
 */
function resolveClass(finalclass: string | null): ItopClassInfo {
  switch (finalclass) {
    case 'UserRequest':
      return { type: 'UserRequest', detailTable: 'ticket_request' }
    case 'Incident':
      return { type: 'Incident', detailTable: 'ticket_incident' }
    case 'Problem':
      return { type: 'Problem', detailTable: 'ticket_problem' }
    case 'Change':
      return { type: 'Change', detailTable: 'change' }
    case 'NormalChange':
      return { type: 'NormalChange', detailTable: 'change' }
    case 'RoutineChange':
      return { type: 'RoutineChange', detailTable: 'change' }
    case 'EmergencyChange':
      return { type: 'EmergencyChange', detailTable: 'change' }
    default:
      return { type: 'Unknown', detailTable: null }
  }
}

/** MariaDB DATETIME/DATE comes back as a Date or string; normalize to a string | null. */
function toDateString(value: Date | string | null | undefined): string | null {
  if (value == null) {
    return null
  }
  return value instanceof Date ? value.toISOString() : String(value)
}

function toSummary(row: TicketRow): ItopTicketSummary {
  return {
    ref: row.ref ?? '',
    title: row.title ?? '',
    type: resolveClass(row.finalclass).type,
    operationalStatus: row.operational_status ?? null,
    startDate: toDateString(row.start_date),
    endDate: toDateString(row.end_date),
  }
}

/**
 * Search tickets by ref/title across all types. Threads the Zod-validated limit
 * (default 20, max 50) through to the SQL LIMIT.
 */
export async function searchItopTickets(input: ItopTicketSearchInput): Promise<ItopTicketSummary[]> {
  const rows = await searchTickets(input.q, input.limit)
  return rows.map(toSummary)
}

function requestBlock(row: RequestDetailRow): ItopTicketDetailBlock {
  return {
    status: row.status,
    impact: row.impact,
    priority: row.priority,
    urgency: row.urgency,
    origin: row.origin,
    resolutionCode: row.resolution_code,
    solution: row.solution,
  }
}

function problemBlock(row: ProblemDetailRow): ItopTicketDetailBlock {
  return {
    status: row.status,
    impact: row.impact,
    priority: row.priority,
    urgency: row.urgency,
  }
}

function changeBlock(row: ChangeDetailRow): ItopTicketDetailBlock {
  return {
    status: row.status,
    impact: row.impact,
    reason: row.reason,
    outage: row.outage,
    fallback: row.fallback,
    acceptanceComment: row.acceptance_comment,
  }
}

/**
 * Fetch a single ticket preview by ref. Returns null when no ticket matches
 * (handler maps to NOT_FOUND). Assembles summary + description + resolved
 * caller/organization + the per-type detail block (per the confirmed iTop
 * column -> block-field mapping).
 */
export async function getItopTicketDetail(ref: string): Promise<ItopTicketDetail | null> {
  const ticket = await getTicketByRef(ref)
  if (!ticket) {
    return null
  }

  const info = resolveClass(ticket.finalclass)

  let block: ItopTicketDetailBlock = {}
  // The caller shown in the preview header: ticket.caller_id for the ticket-side
  // types; change.requestor_id for the change types.
  let callerId: number | null = ticket.caller_id ?? null

  if (info.detailTable === 'ticket_request') {
    const row = await getRequestDetail(ticket.id)
    if (row) {
      block = requestBlock(row)
    }
  }
  else if (info.detailTable === 'ticket_incident') {
    const row = await getIncidentDetail(ticket.id)
    if (row) {
      block = requestBlock(row)
    }
  }
  else if (info.detailTable === 'ticket_problem') {
    const row = await getProblemDetail(ticket.id)
    if (row) {
      block = problemBlock(row)
    }
  }
  else if (info.detailTable === 'change') {
    const row = await getChangeDetail(ticket.id)
    if (row) {
      block = changeBlock(row)
      if (row.requestor_id) {
        callerId = row.requestor_id
      }
    }
  }

  const contactIds = callerId ? [callerId] : []
  const orgIds = ticket.org_id ? [ticket.org_id] : []
  const [contacts, orgs] = await Promise.all([
    resolveContacts(contactIds),
    resolveOrganizations(orgIds),
  ])

  const contact: ContactRow | undefined = contacts.find(c => c.id === callerId)
  const org: OrgRow | undefined = orgs.find(o => o.id === ticket.org_id)

  return {
    ...toSummary(ticket),
    description: ticket.description ?? null,
    caller: {
      name: contact?.name ?? null,
      email: contact?.email ?? null,
    },
    organization: {
      name: org?.name ?? null,
    },
    detail: block,
  }
}
