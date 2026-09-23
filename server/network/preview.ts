import type { AclPreviewInput } from '#shared/schemas/acl.schema'
import type { RoutePreviewInput } from '#shared/schemas/route.schema'
import {
  renderAclAdd,
  renderAclDelete,
  renderRouteAdd,
  renderRouteDelete,
} from './command-templates'
import { redactText } from './redact'

// Builds the redacted command preview shown in the terminal box for an ACL/route
// ADD or DELETE. Display/audit-only — never sent to n8n.

export interface CommandPreview {
  /** The command lines, credential values already masked to `***`. */
  command: string[]
  /** The joined preview string for the terminal box. */
  text: string
}

function finalize(lines: string[], creds: { execUsername?: string, execPassword?: string }): CommandPreview {
  // Defense-in-depth: mask any credential value that might appear inline.
  const command = lines.map(line => redactText(line, [creds.execUsername, creds.execPassword]))
  return { command, text: command.join('\n') }
}

/** Build the redacted preview for an ACL add/delete. */
export function buildAclPreview(input: AclPreviewInput): CommandPreview {
  const lines = input.operation === 'ADD' ? renderAclAdd(input) : renderAclDelete(input)
  return finalize(lines, input)
}

/** Build the redacted preview for a route add/delete. */
export function buildRoutePreview(input: RoutePreviewInput): CommandPreview {
  const lines = input.operation === 'ADD' ? renderRouteAdd(input) : renderRouteDelete(input)
  return finalize(lines, input)
}
