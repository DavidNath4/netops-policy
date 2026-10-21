// Existence pre-check for ACL / Route add & delete.
//
// Before an add/delete is executed, we look the entry up via the module's show
// endpoint and decide:
//   - ADD    → if it ALREADY exists, warn and block (nothing to add).
//   - DELETE → if it does NOT exist, warn and block (nothing to delete).
//
// Two matchers, one per module, so each follows its own response shape:
//   - ACL   : match on the source + destination pair.
//   - Route : match on the route IP (destination).

interface AclEndpoint { type?: string, value?: string }
interface AclRow {
  raw?: string
  source?: AclEndpoint
  destination?: AclEndpoint
}
interface RouteRow {
  raw?: string
  destination?: string
}

/** True if an ACL row matches the given source + destination IP pair. */
export function findAclMatch(items: unknown[], source: string, destination: string): boolean {
  const s = source.trim()
  const d = destination.trim()
  return (items as AclRow[]).some((r) => {
    const rs = r.source?.value?.trim()
    const rd = r.destination?.value?.trim()
    return rs === s && rd === d
  })
}

/**
 * Extract the time-range object name from a rendered ACL command, if any. The
 * device renders a time-bound rule as `... time-range <name>` at the END of the
 * line (confirmed against live `acl/show` output), so the object name is the
 * token following the last `time-range`. Returns null when the command has no
 * time range (an ordinary rule).
 */
export function timeRangeNameFromRaw(raw: string | undefined | null): string | null {
  if (!raw) return null
  const m = raw.match(/\btime-range\s+(\S+)\s*$/)
  return m ? m[1]! : null
}

/**
 * Find the matched ACL row (source+destination pair) and return the time-range
 * object name it references, or null when the rule is matched but has no time
 * range, or when no row matches at all.
 */
export function aclTimeRangeFromItems(items: unknown[], source: string, destination: string): string | null {
  const s = source.trim()
  const d = destination.trim()
  const row = (items as AclRow[]).find((r) => {
    const rs = r.source?.value?.trim()
    const rd = r.destination?.value?.trim()
    return rs === s && rd === d
  })
  return row ? timeRangeNameFromRaw(row.raw) : null
}

/** True if a route row matches the given route IP (its destination). */
export function findRouteMatch(items: unknown[], routeIp: string): boolean {
  const ip = routeIp.trim()
  return (items as RouteRow[]).some(r => r.destination?.trim() === ip)
}

export function useOpsPrecheck() {
  const api = useApi()

  /**
   * ACL existence check. Searches by the source IP (acl/show takes one search
   * value), then matches the source+destination pair in the returned rows.
   * `creds` (optional) are the device credentials typed on the calling page; when
   * passed, the lookup runs as that engineer instead of using the Device Session
   * Credentials. Returns { exists } or throws the underlying API error.
   */
  async function aclExists(
    source: string,
    destination: string,
    creds?: { execUsername: string, execPassword: string },
  ): Promise<boolean> {
    const result = await api.aclOps.show(source.trim(), creds)
    const items = (result.items as unknown[] | null) ?? []
    return findAclMatch(items, source, destination)
  }

  /**
   * ACL match detail for the DELETE flow: one `acl/show` call returning both
   * whether the source→destination rule exists AND the time-range object it
   * references (null when none). Lets the delete page decide, in a single
   * lookup, whether to run the time-range usage check.
   */
  async function aclMatchDetail(
    source: string,
    destination: string,
    creds?: { execUsername: string, execPassword: string },
  ): Promise<{ exists: boolean, timeRange: string | null }> {
    const result = await api.aclOps.show(source.trim(), creds)
    const items = (result.items as unknown[] | null) ?? []
    return {
      exists: findAclMatch(items, source, destination),
      timeRange: aclTimeRangeFromItems(items, source, destination),
    }
  }

  /**
   * Route existence check. route/show is show-all, so fetch the table and match
   * the route IP against each row's destination. `creds` (optional) behave as in
   * aclExists.
   */
  async function routeExists(
    routeIp: string,
    creds?: { execUsername: string, execPassword: string },
  ): Promise<boolean> {
    const result = await api.routeOps.show('', creds)
    const items = (result.items as unknown[] | null) ?? []
    return findRouteMatch(items, routeIp)
  }

  return { aclExists, aclMatchDetail, routeExists }
}
