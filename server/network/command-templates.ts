import type { AclAddInput, AclDeleteInput, AclTimeRangeInput } from '#shared/schemas/acl.schema'
import type { RouteAddInput, RouteDeleteInput } from '#shared/schemas/route.schema'

// Static, hardcoded command-preview templates — one each for ACL add, ACL delete,
// route add, route delete. These render the command the operator's input WOULD
// produce, for on-screen review only.
//
// IMPORTANT: these templates are PREVIEW-ONLY. They are never sent to n8n and are
// not what runs on the device — n8n composes and executes the real command from
// the field payload. The lines below mirror the device command lines n8n runs
// (the `echo "..."` steps inside its `configure terminal … exit` block), WITHOUT
// the ssh/sshpass transport or any credential — those are n8n's concern. The ACL
// / route list name is the fixed `KSEI-JMP`, and the route next-hop + metric are
// the fixed values n8n uses (add: 192.197.120.1 1, delete: 10.100.100.5 1).
//
// Credentials are intentionally NOT interpolated into the command lines. They are
// device-session concerns handled inside n8n; the preview shows only the config
// intent. (redact.ts still masks any credential value defensively.)

/** Fixed access-list / route list name used by the device (per n8n). */
const LIST_NAME = 'KSEI-JMP'
/** Fixed route next-hop + metric per n8n (add and delete differ). */
const ROUTE_ADD_NEXTHOP = '192.197.120.1 1'
const ROUTE_DELETE_NEXTHOP = '10.100.100.5 1'

function joinAddr(addr: string, mask?: string): string {
  return mask ? `${addr} ${mask}` : addr
}

/** Full English month names, indexed 0=January..11=December. */
const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const

/**
 * Local copy of the time-range wire-format derivation for PREVIEW only. The
 * authoritative derivation that feeds the real n8n body lives in
 * `shared/schemas/acl.schema.ts` (`deriveAclTimeRange`); this mirrors it so the
 * preview shows the same `objectName`/`date`/`time` without importing a schema
 * helper into the preview templates. Kept in sync by hand.
 */
function previewTimeRange(tr: AclTimeRangeInput): { objectName: string, date: string, time: string } {
  const [year, month, day] = tr.date.split('-')
  const monthFull = MONTH_NAMES[Number(month) - 1]!
  return {
    objectName: `${day}-${monthFull.slice(0, 3).toLowerCase()}-${year}`,
    date: `${day} ${monthFull} ${year}`,
    time: tr.time,
  }
}

/**
 * ACL ADD preview — mirrors n8n's device commands inside a single
 * `configure terminal … exit` block (no ssh/credentials).
 *
 * - Plain add:            access-list KSEI-JMP extended permit ip <src> <dst>
 * - With a time range:    the `time-range <objectName>` object (name +
 *                         `absolute end <time> <date>`) is defined first, then
 *                         the permit line references it (`… time-range <name>`),
 *                         all ordered in the ONE block.
 * - Bidirectional:        both the forward and the reverse permit lines appear,
 *                         in order, inside the same block (reverse is prepared
 *                         by the caller by swapping source/destination + masks).
 *                         When passed via `reverse`, the second permit line is
 *                         appended; when the caller renders each direction
 *                         separately it still produces a valid single block.
 */
export function renderAclAdd(
  f: AclAddInput & { timeRange?: AclTimeRangeInput, reverse?: AclAddInput },
): string[] {
  const permit = (a: AclAddInput, objectName?: string): string => {
    const src = joinAddr(a.source, a.sourceMask)
    const dst = joinAddr(a.destination, a.destinationMask)
    const suffix = objectName ? ` time-range ${objectName}` : ''
    return `access-list ${LIST_NAME} extended permit ip ${src} ${dst}${suffix}`
  }

  const lines = ['configure terminal']
  let objectName: string | undefined

  // Build the time-range object first (as n8n does) when one is attached.
  if (f.timeRange) {
    const { objectName: name, date, time } = previewTimeRange(f.timeRange)
    objectName = name
    lines.push(`time-range ${objectName}`, `absolute end ${time} ${date}`)
  }

  // Forward permit line, then the reverse one (if a bidirectional reverse is
  // supplied). Both reference the same time-range object when present.
  lines.push(permit(f, objectName))
  if (f.reverse) lines.push(permit(f.reverse, objectName))

  // Close with `end` when a time-range object was configured (matches n8n),
  // otherwise just `exit`.
  lines.push(objectName ? 'end' : 'exit')
  if (objectName) lines.push('exit')
  return lines
}

/** ACL DELETE preview — `no access-list …` inside the configure block. */
export function renderAclDelete(f: AclDeleteInput): string[] {
  const src = joinAddr(f.source, f.sourceMask)
  const dst = joinAddr(f.destination, f.destinationMask)
  return [
    'configure terminal',
    `no access-list ${LIST_NAME} extended permit ip ${src} ${dst}`,
    'exit',
  ]
}

/** ROUTE ADD preview — `route KSEI-JMP <ip[ mask]> 192.197.120.1 1`. */
export function renderRouteAdd(f: RouteAddInput): string[] {
  const route = joinAddr(f.routeIp, f.routeMask)
  return [
    'configure terminal',
    `route ${LIST_NAME} ${route} ${ROUTE_ADD_NEXTHOP}`,
    'exit',
  ]
}

/** ROUTE DELETE preview — `no route KSEI-JMP <ip[ mask]> 10.100.100.5 1`. */
export function renderRouteDelete(f: RouteDeleteInput): string[] {
  const route = joinAddr(f.routeIp, f.routeMask)
  return [
    'configure terminal',
    `no route ${LIST_NAME} ${route} ${ROUTE_DELETE_NEXTHOP}`,
    'exit',
  ]
}
