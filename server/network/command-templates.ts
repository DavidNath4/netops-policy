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

function protocolToken(protocol: string): string {
  return protocol === 'ANY' ? 'ip' : protocol.toLowerCase()
}

/** ACL ADD preview, e.g. an access-list permit/deny line. */
export function renderAclAdd(f: AclAddInput): string[] {
  const proto = protocolToken(f.protocol)
  const verb = f.action === 'ALLOW' ? 'permit' : 'deny'
  const src = f.sourceMask ? `${f.source} ${f.sourceMask}` : f.source
  const dst = f.destinationMask ? `${f.destination} ${f.destinationMask}` : f.destination
  const port = f.port !== undefined ? ` eq ${f.port}` : ''
  return [
    'terminal pager 0',
    `access-list ${f.name} ${verb} ${proto} ${src} ${dst}${port}`.trim(),
    'exit',
  ]
}

/** ACL DELETE preview. */
export function renderAclDelete(f: AclDeleteInput): string[] {
  return [
    'terminal pager 0',
    `no access-list ${f.name} extended permit ip ${f.source} ${f.destination}`,
    'exit',
  ]
}

/** ROUTE ADD preview, e.g. a static route line. */
export function renderRouteAdd(f: RouteAddInput): string[] {
  return [
    `ip route ${f.destination} ${f.nextHop}`,
  ]
}

/** ROUTE DELETE preview. */
export function renderRouteDelete(f: RouteDeleteInput): string[] {
  const nextHop = f.nextHop ? ` ${f.nextHop}` : ''
  return [
    `no ip route ${f.destination}${nextHop}`,
  ]
}
