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
  if (input.operation !== 'ADD') {
    return finalize(renderAclDelete(input), input)
  }

  // Bidirectional ADD: render ONE configure-terminal block containing both the
  // forward permit line and the reverse one (source/destination + masks swapped,
  // same time range). The reverse direction is passed to renderAclAdd via its
  // `reverse` field so both permit lines sit in a single ordered block — no
  // duplicated `configure terminal`/`exit` and no new device syntax.
  if (input.bidirectional) {
    return finalize(renderAclAdd({
      ...input,
      reverse: {
        ...input,
        source: input.destination,
        sourceMask: input.destinationMask,
        destination: input.source,
        destinationMask: input.sourceMask,
      },
    }), input)
  }

  return finalize(renderAclAdd(input), input)
}

/** Build the redacted preview for a route add/delete. */
export function buildRoutePreview(input: RoutePreviewInput): CommandPreview {
  const lines = input.operation === 'ADD' ? renderRouteAdd(input) : renderRouteDelete(input)
  return finalize(lines, input)
}
