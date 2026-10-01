import type { AclAddInput, AclDeleteInput } from '#shared/schemas/acl.schema'
import type { RouteAddInput, RouteDeleteInput } from '#shared/schemas/route.schema'

// Static, hardcoded command-preview templates — one each for ACL add, ACL delete,
// route add, route delete. These render the command the operator's input WOULD
// produce, for on-screen review only.
//
// IMPORTANT: these templates are PREVIEW-ONLY. They are never sent to n8n and are
// not what runs on the device — n8n composes and executes the real command from
// the field payload. Keeping them aligned with n8n's actual command is a
// maintenance goal, not a correctness guarantee. The syntax below is a generic
// Cisco-like placeholder; adjust once the real device commands are confirmed.
//
// Credentials are intentionally NOT interpolated into the command lines. They are
// device-session concerns handled inside n8n; the preview shows only the config
// intent. (redact.ts still masks any credential value defensively.)

function joinAddr(addr: string, mask?: string): string {
  return mask ? `${addr} ${mask}` : addr
}

/** ACL ADD preview, e.g. an access-list permit line. */
export function renderAclAdd(f: AclAddInput): string[] {
  const src = joinAddr(f.source, f.sourceMask)
  const dst = joinAddr(f.destination, f.destinationMask)
  return [
    'terminal pager 0',
    `access-list extended permit ip ${src} ${dst}`,
    'exit',
  ]
}

/** ACL DELETE preview. */
export function renderAclDelete(f: AclDeleteInput): string[] {
  const src = joinAddr(f.source, f.sourceMask)
  const dst = joinAddr(f.destination, f.destinationMask)
  return [
    'terminal pager 0',
    `no access-list extended permit ip ${src} ${dst}`,
    'exit',
  ]
}

/** ROUTE ADD preview, e.g. a static route line. */
export function renderRouteAdd(f: RouteAddInput): string[] {
  const route = f.routeMask ? `${f.routeIp} ${f.routeMask}` : f.routeIp
  return [
    `ip route ${route}`,
  ]
}

/** ROUTE DELETE preview. */
export function renderRouteDelete(f: RouteDeleteInput): string[] {
  const route = f.routeMask ? `${f.routeIp} ${f.routeMask}` : f.routeIp
  return [
    `no ip route ${route}`,
  ]
}
