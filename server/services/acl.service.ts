import { randomUUID } from 'node:crypto'

import type { Database } from '~~/database'
import { getTicketByRef, ItopUnreachableError } from '../network/itop-client'
import { callN8n, checkTimeRangeUsage, fetchTimeRanges } from '../network/n8n-client'
import { buildAclPreview, type CommandPreview } from '../network/preview'
import { redactPayload } from '../network/redact'
import { insertAclLog } from '../repositories/acl-log.repository'
import type { AuditContext } from '../utils/audit-context'
import { apiError } from '../utils/envelope'
import { recordWithDetail } from './audit.service'
import type { DeviceCredentials } from './device-credential.service'
import { deriveAclTimeRange } from '#shared/schemas/acl.schema'
import type { AclExecuteInput, AclShowInput } from '#shared/schemas/acl.schema'
import { autoCorrectAclIp } from '#shared/schemas/network.schema'
import type { N8nResult, OperationResult } from '#shared/schemas/n8n.schema'
import type { TimeRangeList, TimeRangeUsageCheckInput, TimeRangeUsageList } from '#shared/schemas/time-range.schema'

/**
 * ACL operations: show (read-only), preview (redacted, display-only), and
 * execute (delegated to n8n). The service validates already-parsed input,
 * generates the correlation id, delegates execution to n8n, and records exactly
 * one audit log per show/execute. It never stores ACL rows and never runs a
 * device command itself.
 */

/**
 * Structured ACL row shape returned by n8n `acl/show` (normalized to
 * `result.items` by `callN8n`). Each endpoint is a `{ type?, value? }` object;
 * the live contract is `{ success, total, data[], message }` with `data[]`
 * mapped to `items`. A row may ALSO arrive as a raw Cisco command string (or an
 * object exposing a `.raw` string) — see `aclPairExists` for the fallback.
 */
interface AclShowEndpoint { type?: string, value?: string }
interface AclShowRow { raw?: string, source?: AclShowEndpoint, destination?: AclShowEndpoint }

/**
 * Parse the source/destination IP pair out of a raw Cisco ASA access-list line,
 * e.g. `access-list KSEI-JMP extended permit ip host A host B` or
 * `... permit ip A.B.C.D <mask> host B` (network form). Returns the two bare
 * endpoint IPs in order after the protocol token; `host X` → X, `X <mask>` → X
 * (mask dropped — pair match ignores mask). `object`/`object-group`/`any`
 * endpoints are NOT concrete IPv4 and yield `null` for that endpoint, so they
 * can never equal a bare IPv4 source/destination (the ADD form only ever
 * supplies concrete IPv4s). A trailing `time-range <name>` and any `eq <port>`
 * are ignored. Returns null when the line cannot be parsed into two endpoints.
 */
function parseAclPairFromRaw(raw: string): { source: string | null, destination: string | null } | null {
  // Tokenize after the `permit`/`deny` + protocol token. Strip a trailing
  // `time-range <name>` first so it is never mistaken for an endpoint.
  const line = raw.trim().replace(/\s+time-range\s+\S+\s*$/, '')
  const m = line.match(/\b(?:permit|deny)\s+\S+\s+(.*)$/)
  if (!m) return null
  const tokens = m[1]!.trim().split(/\s+/)

  // Consume one endpoint from the front of `tokens`, returning its bare IP (or
  // null for a non-IP endpoint) and the number of tokens consumed.
  function takeEndpoint(toks: string[]): { ip: string | null, used: number } | null {
    if (toks.length === 0) return null
    const t = toks[0]!
    if (t === 'host') {
      // `host A` → the address A.
      return toks.length >= 2 ? { ip: toks[1]!, used: 2 } : null
    }
    if (t === 'object' || t === 'object-group') {
      // `object NAME` / `object-group NAME` → not a concrete IPv4 → never matches.
      return toks.length >= 2 ? { ip: null, used: 2 } : null
    }
    if (t === 'any') {
      // `any` → not a concrete IPv4 → never matches.
      return { ip: null, used: 1 }
    }
    // Network form `A.B.C.D <mask>` → the address A.B.C.D (mask dropped). A lone
    // address with no mask is still taken as the address.
    const next = toks[1]
    if (next && /^\d{1,3}(?:\.\d{1,3}){3}$/.test(next)) {
      return { ip: t, used: 2 }
    }
    return { ip: t, used: 1 }
  }

  const first = takeEndpoint(tokens)
  if (!first) return null
  const second = takeEndpoint(tokens.slice(first.used))
  if (!second) return null
  return { source: first.ip, destination: second.ip }
}

/**
 * True if any ACL row matches the given source→destination IP PAIR (IP only;
 * mask, port, and time-range are ignored). Duplicates the client
 * `findAclMatch` semantics on purpose — the server must NOT import client
 * composables. The live n8n `acl/show` shape is structured `data[]` rows with
 * `source.value`/`destination.value`; a raw command-string row (or a row with a
 * `.raw` string) is parsed as a fallback. Exported so it can be unit-tested
 * without standing up n8n mocks.
 */
export function aclPairExists(items: unknown[], source: string, destination: string): boolean {
  const s = source.trim()
  const d = destination.trim()
  return (items as (AclShowRow | string)[]).some((row) => {
    // (a) Structured row: compare the trimmed source/destination values.
    if (row && typeof row === 'object') {
      const rs = row.source?.value?.trim()
      const rd = row.destination?.value?.trim()
      if (rs !== undefined || rd !== undefined) {
        if (rs === s && rd === d) return true
      }
      // (b) Fallback: the row carries a raw command string.
      if (typeof row.raw === 'string') {
        const pair = parseAclPairFromRaw(row.raw)
        if (pair && pair.source === s && pair.destination === d) return true
      }
      return false
    }
    // (b) Fallback: the row IS a raw command string.
    if (typeof row === 'string') {
      const pair = parseAclPairFromRaw(row)
      return !!pair && pair.source === s && pair.destination === d
    }
    return false
  })
}

/**
 * Join an address and its mask into the single "IP MASK" string n8n expects.
 * If the address already contains a mask (a space), it is used as-is; otherwise
 * a missing mask defaults to the /32 host mask.
 */
function joinAddr(addr: string, mask?: string): string {
  const a = addr.trim()
  if (a.includes(' ')) return a
  return `${a} ${(mask ?? '255.255.255.255').trim()}`
}

/** Build the client-facing result from a normalized n8n result. */
function toOperationResult(correlationId: string, r: N8nResult): OperationResult {
  return {
    correlationId,
    status: r.status,
    message: r.message ?? null,
    total: r.total ?? null,
    items: r.items ?? null,
    output: r.output ?? null,
    error: r.error ?? null,
  }
}

/**
 * List the device's existing time-range OBJECTS for the ACL Add "Select
 * Existing" dropdown. Read-only: delegates to the n8n `fetchTimeRanges` helper,
 * which NEVER throws — on any failure it yields an empty list, so the handler
 * still returns 200 and the page falls back to "Create New". No audit row (a
 * passive catalog fetch, not an ACL operation).
 */
export async function listAclTimeRanges(): Promise<TimeRangeList> {
  const res = await fetchTimeRanges()
  return { objects: res.objects }
}

/**
 * Check whether the given time-range object(s) are still used by any ACL rule,
 * for the ACL DELETE "Generate" advisory warning. Read-only: delegates to the
 * n8n `checkTimeRangeUsage` helper, which NEVER throws — on any failure it
 * yields an empty list, so the delete flow proceeds without the warning. No
 * audit row (a passive usage probe, not an ACL operation). Credentials come
 * from the delete page and are never persisted or logged.
 */
export async function checkAclTimeRangeUsage(input: TimeRangeUsageCheckInput): Promise<TimeRangeUsageList> {
  const res = await checkTimeRangeUsage(input.objectNames, {
    username: input.execUsername,
    password: input.execPassword,
  })
  return { usages: res.usages }
}

/**
 * ACL SHOW — search-only, read-only, runs immediately (no confirmation).
 * Credentials come from the caller's Device Session Credentials (resolved by the
 * handler). The n8n `acl/show` contract body is `{ user, pass, source }`.
 */
export async function aclShow(
  db: Database,
  ctx: AuditContext,
  input: AclShowInput,
  creds: DeviceCredentials,
): Promise<OperationResult> {
  const correlationId = randomUUID()

  const result = await callN8n({
    module: 'ACL',
    action: 'SHOW',
    correlationId,
    body: {
      user: creds.username,
      pass: creds.password,
      source: input.search,
    },
  })

  // Master audit row + acl_logs detail row, written atomically.
  await recordWithDetail(
    db,
    {
      ...ctx,
      module: 'ACL',
      action: 'SHOW',
      status: result.status,
      correlationId,
      // Only the non-secret search value is audited; the RAW n8n request body
      // (which carries user/pass) is masked by record()'s deep redactPayload.
      requestPayload: { source: input.search, n8nRequest: result.raw.request },
      executionPayload: result.execution ?? null,
      responsePayload: {
        total: result.total ?? null,
        items: result.items ?? null,
        message: result.message ?? null,
        error: result.error ?? null,
        n8nResponse: result.raw.response,
      },
    },
    async (tx, auditId) => await insertAclLog(tx, {
      auditId,
      correlationId,
      action: 'SHOW',
      status: result.status,
      device: result.device ?? null,
      // ACL SHOW: the search value is the source; there is no destination.
      source: input.search,
      destination: null,
      // SHOW has no command preview.
      commandPreview: null,
      // Defense-in-depth: metadata/summary passed through redactPayload.
      executionMeta: redactPayload(result.execution ?? null),
      responseSummary: redactPayload({
        total: result.total ?? null,
        message: result.message ?? null,
        error: result.error ?? null,
      }),
    }),
  )

  return toOperationResult(correlationId, result)
}

/**
 * Defense-in-depth IP auto-correction for ACL ADD. The form already rewrites
 * ticket IPs (10.197.x → the real 10.71.x scheme) on blur, but a direct API call
 * could bypass the UI, so the server re-applies the SAME mapping before preview,
 * audit, and the n8n call. Only ADD is corrected; DELETE is left as submitted.
 * Returns a new input object with corrected source/destination; non-matching or
 * invalid addresses are unchanged (the mapping is a no-op for them).
 */
function withCorrectedAclIps(input: AclExecuteInput): AclExecuteInput {
  if (input.operation !== 'ADD') return input
  return {
    ...input,
    source: autoCorrectAclIp(input.source),
    destination: autoCorrectAclIp(input.destination),
  }
}

/** Build the redacted preview for an ACL add/delete (no n8n, no audit). */
export function aclPreview(input: AclExecuteInput): CommandPreview {
  return buildAclPreview(withCorrectedAclIps(input))
}

/**
 * Swap source<->destination and sourceMask<->destinationMask for the reverse
 * direction of a bidirectional ACL ADD. Everything else (change ticket, time
 * range, exec credentials) is kept; `bidirectional` is dropped so the reverse
 * direction renders/executes as an ordinary one-way ADD. IPs are assumed
 * already corrected by the caller (correct first, then swap).
 */
function reverseAclDirection(input: AclExecuteInput): AclExecuteInput {
  if (input.operation !== 'ADD') return input
  return {
    ...input,
    bidirectional: false,
    source: input.destination,
    sourceMask: input.destinationMask,
    destination: input.source,
    destinationMask: input.sourceMask,
  }
}

/**
 * Run ONE ACL direction end-to-end: new correlation id → redacted preview →
 * n8n call (unchanged { user, pass, source, destination } contract, plus the
 * optional time-range keys) → one master audit row + one acl_logs detail row,
 * written atomically → client-facing result. A bidirectional ADD calls this
 * twice (forward then reverse), each independent with its own id and audit row.
 */
async function runAclDirection(
  db: Database,
  ctx: AuditContext,
  input: AclExecuteInput,
): Promise<OperationResult> {
  const correlationId = randomUUID()
  // Per-direction preview must show ONLY this direction's command lines; the
  // bidirectional two-direction preview is assembled upstream (aclPreview on
  // the full input). Clear the flag so buildAclPreview renders one direction.
  const preview = buildAclPreview(
    input.operation === 'ADD' ? { ...input, bidirectional: false } : input,
  )

  // n8n acl/add & acl/delete contract: { user, pass, source, destination },
  // where source/destination are joined "IP MASK" strings. A missing mask
  // defaults to a /32 host mask (255.255.255.255).
  const body: Record<string, string> = {
    user: input.execUsername,
    pass: input.execPassword,
    source: joinAddr(input.source, 'sourceMask' in input ? input.sourceMask : undefined),
    destination: joinAddr(input.destination, 'destinationMask' in input ? input.destinationMask : undefined),
  }

  // Optional time-range ADD, two modes (n8n detects a time-range add by the
  // presence of these keys; absence means an ordinary add; DELETE never gets them):
  // - existing: reference an on-device object by name only — ONLY `objectName`,
  //             NO `date`/`time` keys (n8n reuses the already-defined object).
  // - new:      derive the three exact keys (objectName, time, date) AS ONE UNIT.
  if (input.operation === 'ADD' && input.timeRange) {
    if (input.timeRange.mode === 'existing') {
      body.objectName = input.timeRange.objectName
    }
    else {
      const { objectName, time, date } = deriveAclTimeRange(input.timeRange)
      body.objectName = objectName
      body.time = time
      body.date = date
    }
  }

  const result = await callN8n({
    module: 'ACL',
    action: input.operation,
    correlationId,
    body,
  })

  // Master audit row + acl_logs detail row, written atomically.
  await recordWithDetail(
    db,
    {
      ...ctx,
      module: 'ACL',
      action: input.operation,
      status: result.status,
      correlationId,
      // redactPayload masks user/pass/exec*; the command snapshot is already
      // credential-free (preview never embeds creds). The RAW n8n request body
      // (user/pass) is masked by record()'s deep redactPayload.
      requestPayload: redactPayload({ ...input, n8nRequest: result.raw.request }),
      commandPayload: { command: preview.command },
      executionPayload: result.execution ?? null,
      responsePayload: {
        total: result.total ?? null,
        items: result.items ?? null,
        message: result.message ?? null,
        output: result.output ?? null,
        error: result.error ?? null,
        n8nResponse: result.raw.response,
      },
    },
    async (tx, auditId) => await insertAclLog(tx, {
      auditId,
      correlationId,
      action: input.operation,
      status: result.status,
      device: result.device ?? null,
      // ACL EXECUTE: the raw human-readable address inputs (NOT the joined
      // "IP MASK" strings sent to n8n), which contain no credentials.
      source: input.source,
      destination: input.destination,
      // preview.command lines are already credential-free; pass through
      // redactPayload for defense-in-depth.
      commandPreview: redactPayload(preview.command),
      executionMeta: redactPayload(result.execution ?? null),
      responseSummary: redactPayload({
        total: result.total ?? null,
        message: result.message ?? null,
        output: result.output ?? null,
        error: result.error ?? null,
      }),
    }),
  )

  return toOperationResult(correlationId, result)
}

/**
 * ACL EXECUTE — confirmed add/delete, delegated to n8n. A one-way operation runs
 * once (one audit row). A bidirectional ACL ADD runs TWICE via runAclDirection:
 * the forward direction then the reverse (source/destination + masks swapped),
 * each an independent n8n call with its own correlation id and its own audit
 * row. Both directions run regardless of the other's outcome (no rollback); the
 * combined result returns the forward direction at the top level with the
 * reverse nested under `reverse`. The iTop change-ticket guard runs ONCE up
 * front (both directions share the same ticket).
 */
export async function aclExecute(
  db: Database,
  ctx: AuditContext,
  rawInput: AclExecuteInput,
): Promise<OperationResult> {
  // Defense-in-depth: apply the ACL-ADD IP auto-correction server-side so a
  // direct API call (bypassing the form's on-blur fix) still executes, audits,
  // and previews the corrected 10.71.x address. From here ONLY the corrected
  // `input` is used, so nothing records an un-mapped-but-mappable IP. (Correct
  // first, then swap for the reverse direction.)
  const input = withCorrectedAclIps(rawInput)

  // Security guard: the UI forbids manual ticket entry (search + select only),
  // but a direct API call could still pass a well-formed yet FAKE ref. Confirm
  // the change ticket actually exists in iTop before executing. Run ONCE — both
  // directions of a bidirectional ADD share the same ticket. Block-total: if
  // iTop cannot verify (unreachable/unconfigured), reject rather than execute.
  const ticketRef = input.changeTicket
  try {
    const ticket = await getTicketByRef(ticketRef)
    if (ticket === null) {
      console.warn(`[acl] execute rejected: change ticket ${ticketRef} not found in iTop`)
      throw apiError(404, 'TICKET_NOT_FOUND', 'Change ticket not found in iTop')
    }
  }
  catch (err) {
    if (err instanceof ItopUnreachableError) {
      console.warn(`[acl] execute rejected: cannot verify change ticket ${ticketRef} (iTop unreachable)`)
      throw apiError(503, 'ITOP_UNREACHABLE', 'Cannot verify the change ticket: iTop is unreachable')
    }
    throw err
  }

  // Defense-in-depth ADD guards (mirror app/pages/acl/add.vue). The UI blocks
  // these three cases before they reach the server, but a direct API call could
  // bypass the form, so re-enforce them here. ADD ONLY — DELETE is never
  // guarded and falls straight through to the branch below.
  if (input.operation === 'ADD') {
    // GUARD 1 — same endpoint (pure, no n8n call): Source and Destination may
    // not resolve to the SAME IPv4. Compare the already-corrected bare IPs
    // (masks are carried separately). For a bidirectional ADD this single check
    // covers both directions — swapping two equal values is still equal.
    if (input.source.trim() === input.destination.trim()) {
      throw apiError(400, 'ACL_SAME_ENDPOINT', 'Source dan Destination tidak boleh menggunakan IP yang sama.')
    }

    // GUARDS 2 & 3 — existence pre-check (IP PAIR ALONE; mask and time range
    // ignored). Covers "same IP, different time range" AND "same IP, different
    // subnet/mask". READ-ONLY: this writes NO audit row (it does NOT route
    // through recordWithDetail); only the real execute (runAclDirection) audits.
    //
    // Fail-closed (HARD gate, same posture as the iTop ticket guard above):
    // unlike the never-throw advisory helpers for DELETE warnings
    // (fetchTimeRanges / checkTimeRangeUsage, which degrade to empty lists),
    // this guard REJECTS when the pre-check cannot produce a usable item list,
    // rather than silently allowing an unverifiable add. callN8n never throws,
    // but the call is wrapped in try/catch so any unexpected throw also fails
    // closed.
    const aclShowItems = async (searchIp: string): Promise<unknown[]> => {
      const result = await callN8n({
        module: 'ACL',
        action: 'SHOW',
        correlationId: randomUUID(),
        // Per-request exec credentials from the ADD input (execute path, NOT
        // DeviceCredentials). callN8n never logs user/pass or the API key.
        body: { user: input.execUsername, pass: input.execPassword, source: searchIp },
      })
      if (result.status === 'FAILED' || !Array.isArray(result.items)) {
        throw apiError(503, 'ACL_PRECHECK_UNAVAILABLE', 'Tidak dapat memverifikasi ACL yang sudah ada di perangkat saat ini. Coba lagi nanti.')
      }
      return result.items
    }

    let alreadyExists: boolean
    try {
      if (input.bidirectional) {
        // Bidirectional ADD: check BOTH directions and block if EITHER exists.
        // Each acl/show searches by a single source IP, so two calls are needed
        // (forward source→destination, reverse destination→source). DECISION:
        // the client's partial-add "skip one direction" UX is a UI convenience;
        // the server guard is a safety net and must REJECT rather than silently
        // half-execute, so any existing direction blocks the whole ADD.
        const forwardItems = await aclShowItems(input.source.trim())
        const reverseItems = await aclShowItems(input.destination.trim())
        alreadyExists
          = aclPairExists(forwardItems, input.source, input.destination)
            || aclPairExists(reverseItems, input.destination, input.source)
      }
      else {
        // One-way ADD: check the forward pair only.
        const items = await aclShowItems(input.source.trim())
        alreadyExists = aclPairExists(items, input.source, input.destination)
      }
    }
    catch {
      // Any throw from the pre-check (our own fail-closed apiError, or an
      // unexpected error — callN8n itself never throws) is a CLOSED gate: never
      // fall through to execute on an unverifiable pre-check. Re-raise as the
      // single 503 so the un-available posture is consistent.
      throw apiError(503, 'ACL_PRECHECK_UNAVAILABLE', 'Tidak dapat memverifikasi ACL yang sudah ada di perangkat saat ini. Coba lagi nanti.')
    }

    if (alreadyExists) {
      throw apiError(409, 'ACL_ALREADY_EXISTS', 'ACL untuk Source -> Destination ini sudah ada di perangkat. Untuk mengganti subnet atau time range-nya, hapus dulu entri yang ada melalui menu Delete ACL, lalu tambahkan kembali.')
    }
  }

  // Bidirectional ACL ADD: run the forward direction, then the reverse
  // (swapped) direction, BOTH regardless of each other's outcome. Each is a
  // self-contained n8n call + audit row via runAclDirection.
  if (input.operation === 'ADD' && input.bidirectional) {
    const forward = await runAclDirection(db, ctx, input)
    const reverse = await runAclDirection(db, ctx, reverseAclDirection(input))
    return { ...forward, reverse }
  }

  // One-way ACL add/delete (or ADD with bidirectional off): a single call.
  return runAclDirection(db, ctx, input)
}
