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
   * Returns { exists } or throws the underlying API error (e.g. creds required).
   */
  async function aclExists(source: string, destination: string): Promise<boolean> {
    const result = await api.aclOps.show(source.trim())
    const items = (result.items as unknown[] | null) ?? []
    return findAclMatch(items, source, destination)
  }

  /**
   * Route existence check. route/show is show-all, so fetch the table and match
   * the route IP against each row's destination.
   */
  async function routeExists(routeIp: string): Promise<boolean> {
    const result = await api.routeOps.show('')
    const items = (result.items as unknown[] | null) ?? []
    return findRouteMatch(items, routeIp)
  }

  return { aclExists, routeExists }
}
