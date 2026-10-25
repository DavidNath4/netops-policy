// Shared types + pure helpers for the Bulk Add ACL row model. Extracted so the
// page (app/pages/acl/add-bulk.vue) and the per-row card component
// (components/acl/AclBulkRowCard.vue) agree on ONE row shape and ONE set of
// validation rules — no duplicated logic, no drift between the two files.
//
// Every field EXCEPT `expanded` is data sent to the API; `expanded` is UI-only.
import type { AclBulkItemInput } from '#shared/schemas/acl.schema'
import { autoCorrectAclIp, isAnyAddress, isValidIpv4 } from '#shared/schemas/network.schema'

/** One editable row of a bulk ADD. Mirrors a single-ADD's fields; the time range
 *  is per row. changeTicket + credentials are batch-global (not here). */
export interface BulkRow {
  source: string
  sourceMask: string
  destination: string
  destinationMask: string
  // Per-row bidirectional: THIS row decides one-way vs two-way independently.
  bidirectional: boolean
  timeRangeEnabled: boolean
  timeRangeMode: 'existing' | 'new'
  timeRangeObject: string
  timeRangeDate: string
  timeRangeTime: string
  // UI-only: card expanded (full form) or collapsed (summary header).
  expanded: boolean
}

/** A fresh, empty row — new rows start expanded and one-way. */
export function emptyBulkRow(): BulkRow {
  return {
    source: '',
    sourceMask: '',
    destination: '',
    destinationMask: '',
    bidirectional: false,
    timeRangeEnabled: false,
    timeRangeMode: 'existing',
    timeRangeObject: '',
    timeRangeDate: '',
    timeRangeTime: '23:59',
    expanded: true,
  }
}

/** 24-hour HH:mm. Empty means "use the 23:59 default", so it never blocks. */
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/
export function bulkRowTimeFormatValid(row: BulkRow): boolean {
  return row.timeRangeTime === '' || TIME_RE.test(row.timeRangeTime)
}

/** Both endpoints are valid IPv4. */
export function bulkRowIpsValid(row: BulkRow): boolean {
  return isValidIpv4(row.source) && isValidIpv4(row.destination)
}

/** Source and Destination resolve to the SAME IPv4 (compared after the ADD
 *  auto-correction, mirroring the server). Blank source never flags. */
export function bulkRowSameEndpoint(row: BulkRow): boolean {
  return row.source.trim() !== ''
    && autoCorrectAclIp(row.source.trim()) === autoCorrectAclIp(row.destination.trim())
}

/** The row's time range (when enabled) is complete for its active mode. */
export function bulkRowTimeRangeValid(row: BulkRow): boolean {
  if (!row.timeRangeEnabled) return true
  if (row.timeRangeMode === 'existing') return row.timeRangeObject !== ''
  return row.timeRangeDate !== '' && bulkRowTimeFormatValid(row)
}

/** True when either endpoint resolves to 0.0.0.0/0 (any) — never allowed. */
export function bulkRowAnyAddress(row: BulkRow): boolean {
  return isAnyAddress(row.source, row.sourceMask) || isAnyAddress(row.destination, row.destinationMask)
}

/** A row is submittable: valid IPs, not any-address, distinct endpoints,
 *  complete time range. */
export function bulkRowValid(row: BulkRow): boolean {
  return bulkRowIpsValid(row)
    && !bulkRowAnyAddress(row)
    && !bulkRowSameEndpoint(row)
    && bulkRowTimeRangeValid(row)
}

/** Turn a row into the API item shape (trims, drops blanks, maps the time
 *  range). `expanded` and empty optionals are omitted. */
export function bulkRowToItem(row: BulkRow): AclBulkItemInput {
  const item: AclBulkItemInput = {
    source: row.source.trim(),
    sourceMask: row.sourceMask.trim() || undefined,
    destination: row.destination.trim(),
    destinationMask: row.destinationMask.trim() || undefined,
    bidirectional: row.bidirectional || undefined,
  }
  if (row.timeRangeEnabled) {
    if (row.timeRangeMode === 'existing' && row.timeRangeObject) {
      item.timeRange = { mode: 'existing', objectName: row.timeRangeObject }
    }
    else if (row.timeRangeMode === 'new' && row.timeRangeDate) {
      item.timeRange = { mode: 'new', date: row.timeRangeDate, time: row.timeRangeTime || '23:59' }
    }
  }
  return item
}
