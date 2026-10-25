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
  // Live n8n uses `raw_command`; older/mock data uses `raw`. Both tolerated.
  raw_command?: string
  raw?: string
  source?: AclEndpoint
  destination?: AclEndpoint
}
interface RouteRow {
  raw?: string
  destination?: string
}

/** The full device command string of a row (snake_case first, then fallback). */
function aclRowRaw(r: AclRow): string | null {
  return r.raw_command ?? r.raw ?? null
}

/** True when a row's source/destination values match the given pair. */
function aclRowMatchesPair(r: AclRow, source: string, destination: string): boolean {
  return r.source?.value?.trim() === source.trim() && r.destination?.value?.trim() === destination.trim()
}

/** True if an ACL row matches the given source + destination IP pair. */
export function findAclMatch(items: unknown[], source: string, destination: string): boolean {
  return (items as AclRow[]).some(r => aclRowMatchesPair(r, source, destination))
}

/**
 * The full device command (`raw_command`) of the ACL row matching the given
 * source+destination pair, or null when no row matches or the match carries no
 * raw string. Used by Delete ACL to preview `no <raw>` from the real device
 * command (exact, including any time-range clause).
 */
export function findAclRawCommand(items: unknown[], source: string, destination: string): string | null {
  const row = (items as AclRow[]).find(r => aclRowMatchesPair(r, source, destination))
  return row ? aclRowRaw(row) : null
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
   * DELETE helper: one `acl/show` lookup returning BOTH whether the
   * source→destination rule exists AND its exact device command (`raw_command`,
   * null when the match has none). The delete page uses `raw` to preview
   * `no <raw>` from the real device line, falling back to the server preview
   * when it is null.
   */
  async function aclMatchForDelete(
    source: string,
    destination: string,
    creds?: { execUsername: string, execPassword: string },
  ): Promise<{ exists: boolean, raw: string | null }> {
    const result = await api.aclOps.show(source.trim(), creds)
    const items = (result.items as unknown[] | null) ?? []
    return {
      exists: findAclMatch(items, source, destination),
      raw: findAclRawCommand(items, source, destination),
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

  return { aclExists, aclMatchForDelete, routeExists }
}
