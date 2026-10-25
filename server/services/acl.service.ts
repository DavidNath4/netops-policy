import { randomUUID } from 'node:crypto'

import type { Database } from '~~/database'
import { getTicketByRef, ItopUnreachableError } from '../network/itop-client'
import { addTimeRange, callN8n, checkTimeRangeUsage, fetchTimeRanges, safeDeleteTimeRange } from '../network/n8n-client'
import { renderTimeRangeAdd, renderTimeRangeDelete } from '../network/command-templates'
import { buildAclPreview, type CommandPreview } from '../network/preview'
import { redactPayload } from '../network/redact'
import { insertAclLog } from '../repositories/acl-log.repository'
import type { AuditContext } from '../utils/audit-context'
import { apiError } from '../utils/envelope'
import { record, recordWithDetail } from './audit.service'
import type { DeviceCredentials } from './device-credential.service'
import { deriveAclTimeRange } from '#shared/schemas/acl.schema'
import type {
  AclBulkExecuteInput,
  AclBulkItemInput,
  AclBulkPreviewInput,
  AclExecuteInput,
  AclShowInput,
} from '#shared/schemas/acl.schema'
import { autoCorrectAclIp, isAnyAddress } from '#shared/schemas/network.schema'
import type {
  AclBulkExecuteResult,
  AclBulkExecuteRow,
  AclBulkPreviewResult,
  AclBulkPreviewRow,
  N8nResult,
  OperationResult,
} from '#shared/schemas/n8n.schema'
import type {
  TimeRangeAddInput,
  TimeRangeAddResult,
  TimeRangeDeleteInput,
  TimeRangeDeleteResult,
  TimeRangeList,
  TimeRangeListRequestInput,
  TimeRangeOverviewList,
  TimeRangeUsageCheckInput,
  TimeRangeUsageList,
} from '#shared/schemas/time-range.schema'

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
 * passive catalog fetch, not an ACL operation). The `time/show` webhook now
 * authenticates, so the device credentials typed on the Add page are forwarded;
 * they are never persisted or logged.
 */
export async function listAclTimeRanges(input: TimeRangeListRequestInput): Promise<TimeRangeList> {
  const res = await fetchTimeRanges({
    username: input.execUsername,
    password: input.execPassword,
  })
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
 * Build the Time Range page overview: every device time-range OBJECT with its
 * end detail AND the ACL rules that reference it. Combines the two read-only
 * webhooks — `fetchTimeRanges` (the catalog) and `checkTimeRangeUsage` (per-name
 * usage + raw ACL commands) — into one list. Credentials come from the caller's
 * Device Session Credentials (resolved by the handler), like Show ACL/Routes.
 *
 * Read-only: no audit row, and both helpers NEVER throw (they degrade to empty).
 * When there are no objects, the usage probe is skipped (nothing to check); any
 * object missing from the usage response falls back to zero usage.
 */
export async function listTimeRangeOverview(
  creds: DeviceCredentials,
): Promise<TimeRangeOverviewList> {
  const { objects } = await fetchTimeRanges(creds)
  if (objects.length === 0) return { items: [] }

  const { usages } = await checkTimeRangeUsage(objects.map(o => o.name), creds)
  const usageByName = new Map(usages.map(u => [u.name, u]))

  const items = objects.map((o) => {
    const u = usageByName.get(o.name)
    return {
      ...o,
      usageCount: u?.usageCount ?? 0,
      rawCommands: u?.rawCommands ?? [],
    }
  })
  return { items }
}

/**
 * Create a STANDALONE time-range object on the device (Time Range page "Add").
 * Two modes: `date` derives the object name `dd-mmm-yyyy` from the picked date
 * (exactly like the ACL Add "Create New" flow); `named` takes a typed name. Both
 * send the same three keys (objectName, date, time) to the n8n `time/add`
 * webhook. Credentials come from the caller's Device Session Credentials.
 *
 * Duplicate guard (fail-closed, mirrors the ACL existence pre-check): before the
 * create, re-list the device objects and REJECT with 409 if the target name is
 * already present — so a direct API call cannot create a duplicate. Read-only
 * helpers never throw; the create itself reports real success/failure.
 */
/**
 * Derive the final object name + wire date/time for a Time Range ADD. `date`
 * mode names it from the picked date (dd-mmm-yyyy, like ACL Add "Create New");
 * `named` mode uses the typed name verbatim. Both reuse deriveAclTimeRange for
 * the date/time wire format so it matches the ACL Add contract and the n8n
 * `time/add` body. Single source shared by preview and create.
 */
function deriveTimeRangeAdd(input: TimeRangeAddInput): { objectName: string, date: string, time: string } {
  const derived = deriveAclTimeRange({ date: input.date, time: input.time })
  return {
    objectName: input.mode === 'named' ? input.objectName : derived.objectName,
    date: derived.date,
    time: derived.time,
  }
}

/**
 * Build the display-only command preview for a Time Range ADD (no n8n, no audit,
 * no device change) — the standalone `time-range` creation block. Mirrors
 * `aclPreview`: pure, credential-free.
 */
export function previewTimeRangeAdd(input: TimeRangeAddInput): CommandPreview {
  const { objectName, date, time } = deriveTimeRangeAdd(input)
  const lines = renderTimeRangeAdd({ objectName, date, time })
  return { command: lines, text: lines.join('\n') }
}

export async function createTimeRange(
  db: Database,
  ctx: AuditContext,
  input: TimeRangeAddInput,
  creds: DeviceCredentials,
): Promise<TimeRangeAddResult> {
  const { objectName, date, time } = deriveTimeRangeAdd(input)

  // Duplicate guard: reject if an object with this name already lives on the
  // device. fetchTimeRanges never throws (empty list on failure); a failed
  // lookup does not block the add here, since the n8n create is itself the final
  // authority and will reject a true duplicate. This pre-check writes NO audit
  // (nothing was attempted on the device yet).
  const { objects } = await fetchTimeRanges(creds)
  if (objects.some(o => o.name === objectName)) {
    throw apiError(409, 'TIME_RANGE_EXISTS', `Time range "${objectName}" already exists on the device.`)
  }

  const correlationId = randomUUID()
  const res = await addTimeRange({ objectName, date, time }, creds)
  const command = renderTimeRangeAdd({ objectName, date, time })

  // Master audit row (TIME_RANGE / ADD). Like ACL, but master-only (no detail
  // table). Payloads are redacted inside record(); the command is credential-
  // free. The device user/pass are never in these payloads.
  await record(db, {
    ...ctx,
    module: 'TIME_RANGE',
    action: 'ADD',
    status: res.ok ? 'SUCCESS' : 'FAILED',
    correlationId,
    requestPayload: { objectName, date, time, mode: input.mode },
    commandPayload: { command },
    responsePayload: { message: res.message },
  })

  // n8n is the final authority on duplicates (it re-checks the device): surface
  // its OBJECT_ALREADY_EXISTS as the SAME 409 as the pre-check guard above, so
  // the client handles both the same way. (The attempt is already audited above.)
  if (!res.ok && res.alreadyExists) {
    throw apiError(409, 'TIME_RANGE_EXISTS', res.message || `Time range "${objectName}" already exists on the device.`)
  }

  return {
    status: res.ok ? 'SUCCESS' : 'FAILED',
    objectName,
    message: res.message,
  }
}

/**
 * Safely delete a standalone time-range object (Time Range page row "Delete").
 * Delegates to the n8n `time/safeDelete` webhook, which re-checks the device and
 * REFUSES when ACL rules still reference the object (returning those rules). The
 * UI already disables Delete when the loaded usageCount > 0; this is the device-
 * side safety net for the race where a rule was added after the table loaded.
 *
 * Writes ONE master audit row (TIME_RANGE / DELETE), mirroring the ACL master
 * audit (no detail table). On an in-use refusal the blocking ACL rules are
 * returned so the page can warn with them. Never throws for device/n8n errors
 * (the helper degrades to a FAILED result).
 */
export async function deleteTimeRange(
  db: Database,
  ctx: AuditContext,
  input: TimeRangeDeleteInput,
  creds: DeviceCredentials,
): Promise<TimeRangeDeleteResult> {
  const correlationId = randomUUID()
  const res = await safeDeleteTimeRange(input.objectName, creds)
  const command = renderTimeRangeDelete(input.objectName)

  await record(db, {
    ...ctx,
    module: 'TIME_RANGE',
    action: 'DELETE',
    status: res.ok ? 'SUCCESS' : 'FAILED',
    correlationId,
    requestPayload: { objectName: input.objectName },
    commandPayload: { command },
    // redactPayload passes through the n8n response (no credentials in it).
    responsePayload: { message: res.message, inUse: res.inUse, blockingRules: res.blockingRules, n8nResponse: res.raw },
  })

  return {
    status: res.ok ? 'SUCCESS' : 'FAILED',
    objectName: input.objectName,
    message: res.message,
    blockingRules: res.blockingRules,
  }
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
 * Batch linkage stamped onto a bulk row's audit payload so the independent
 * per-row audit rows of ONE bulk submission can be grouped together in the Log
 * Trail. Absent for single/bidirectional (non-bulk) executes.
 */
interface AclBatchMeta {
  /** Shared id for every row (and every direction) of one bulk submission. */
  batchId: string
  /** This row's 0-based position in the batch. */
  batchIndex: number
  /** Total rows in the batch. */
  batchSize: number
}

/**
 * Run ONE ACL direction end-to-end: new correlation id → redacted preview →
 * n8n call (unchanged { user, pass, source, destination } contract, plus the
 * optional time-range keys) → one master audit row + one acl_logs detail row,
 * written atomically → client-facing result. A bidirectional ADD calls this
 * twice (forward then reverse), each independent with its own id and audit row.
 *
 * `batchMeta` (bulk only) is folded into the audit requestPayload so all rows of
 * one bulk submission share a `batchId` for grouping; it never changes the n8n
 * body or the client result.
 */
async function runAclDirection(
  db: Database,
  ctx: AuditContext,
  input: AclExecuteInput,
  batchMeta?: AclBatchMeta,
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
      // (user/pass) is masked by record()'s deep redactPayload. For a bulk row,
      // the batch linkage (batchId/index/size) is stamped here so every row of
      // one submission can be grouped in the Log Trail.
      requestPayload: redactPayload({ ...input, ...(batchMeta ? { batch: batchMeta } : {}), n8nRequest: result.raw.request }),
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
 * Security guard: confirm the change ticket actually exists in iTop before any
 * ACL execute runs. Shared by the single and bulk execute paths so both enforce
 * the same posture. The UI forbids manual ticket entry (search + select only),
 * but a direct API call could pass a well-formed yet FAKE ref. Block-total: if
 * iTop cannot verify (unreachable/unconfigured), reject rather than execute.
 */
async function assertTicketExists(ticketRef: string): Promise<void> {
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
}

/**
 * Run ONE authenticated `acl/show` for an ADD pre-check and return its rows.
 * Fail-closed (HARD gate): REJECTS with a 503 when the pre-check cannot produce
 * a usable item list, rather than allowing an unverifiable add. Credentials are
 * the per-request exec credentials (NOT DeviceCredentials); callN8n never logs
 * user/pass or the API key, and never throws (the caller still wraps it).
 */
async function aclShowItemsForPrecheck(
  searchIp: string,
  creds: { execUsername: string, execPassword: string },
): Promise<unknown[]> {
  const result = await callN8n({
    module: 'ACL',
    action: 'SHOW',
    correlationId: randomUUID(),
    body: { user: creds.execUsername, pass: creds.execPassword, source: searchIp },
  })
  if (result.status === 'FAILED' || !Array.isArray(result.items)) {
    throw apiError(503, 'ACL_PRECHECK_UNAVAILABLE', 'Could not verify existing ACLs on the device right now. Please try again later.')
  }
  return result.items
}

/**
 * ADD-only existence pre-check (IP PAIR ALONE; mask and time range ignored).
 * Covers "same IP, different time range" AND "same IP, different subnet/mask".
 * READ-ONLY: writes NO audit row (does NOT route through recordWithDetail);
 * only the real execute (runAclDirection) audits. For a bidirectional ADD it
 * checks BOTH directions and reports exists when EITHER is present — the server
 * guard is a safety net that must not half-execute. The caller is expected to
 * have already applied `withCorrectedAclIps`.
 *
 * Fail-closed: any throw (our own 503, or an unexpected error — callN8n itself
 * never throws) is re-raised as the single 503, so an unverifiable pre-check
 * never falls through to execute.
 */
async function aclAddAlreadyExists(input: AclExecuteInput): Promise<boolean> {
  if (input.operation !== 'ADD') return false
  const creds = { execUsername: input.execUsername, execPassword: input.execPassword }
  try {
    if (input.bidirectional) {
      const forwardItems = await aclShowItemsForPrecheck(input.source.trim(), creds)
      const reverseItems = await aclShowItemsForPrecheck(input.destination.trim(), creds)
      return (
        aclPairExists(forwardItems, input.source, input.destination)
        || aclPairExists(reverseItems, input.destination, input.source)
      )
    }
    const items = await aclShowItemsForPrecheck(input.source.trim(), creds)
    return aclPairExists(items, input.source, input.destination)
  }
  catch {
    throw apiError(503, 'ACL_PRECHECK_UNAVAILABLE', 'Could not verify existing ACLs on the device right now. Please try again later.')
  }
}

/**
 * Hard guard: reject an ACL ADD whose source OR destination resolves to
 * `0.0.0.0/0` ("any"). A catch-all ACL is potentially fatal (it would match all
 * traffic), so neither a `0.0.0.0` address nor a `/0` mask is ever allowed. The
 * caller passes already-corrected IPs. Pure, no device call.
 */
function assertNotAnyAclEndpoint(input: AclExecuteInput): void {
  if (input.operation !== 'ADD') return
  const srcMask = 'sourceMask' in input ? input.sourceMask : undefined
  const dstMask = 'destinationMask' in input ? input.destinationMask : undefined
  if (isAnyAddress(input.source, srcMask) || isAnyAddress(input.destination, dstMask)) {
    throw apiError(400, 'ANY_ADDRESS_FORBIDDEN', 'An ACL for 0.0.0.0/0 (any) is not allowed — it would match all traffic. Use a specific address and mask.')
  }
}

/**
 * The derived object name for an ADD whose time range is "Create New" (mode
 * `new`), or null when the ADD has no time range or uses an existing object.
 * This is the name a `new` time range WOULD create on the device.
 */
function newTimeRangeName(input: AclExecuteInput): string | null {
  if (input.operation !== 'ADD' || !input.timeRange || input.timeRange.mode !== 'new') return null
  return deriveAclTimeRange(input.timeRange).objectName
}

/**
 * Guard a "Create New" time range against DUPLICATION: reject when the derived
 * object name already exists on the device. Existing-mode time ranges are fine
 * (they intentionally reference an existing object); a plain add with no time
 * range is a no-op here. Read-only (fetchTimeRanges never throws → empty list on
 * failure, which does not block — n8n remains the final authority). Shared by
 * the single ADD guard and the bulk gate.
 */
async function assertNewTimeRangeNotDuplicate(
  name: string,
  creds: { username: string, password: string },
): Promise<void> {
  const { objects } = await fetchTimeRanges(creds)
  if (objects.some(o => o.name === name)) {
    throw apiError(
      409,
      'TIME_RANGE_EXISTS',
      `A time range named "${name}" already exists on the device. Use "Select Existing" to reference it instead of creating a new one.`,
    )
  }
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

  // Security guard: confirm the change ticket exists in iTop before executing.
  // Run ONCE — both directions of a bidirectional ADD share the same ticket.
  await assertTicketExists(input.changeTicket)

  // Defense-in-depth ADD guards (mirror app/pages/acl/add.vue). The UI blocks
  // these cases before they reach the server, but a direct API call could
  // bypass the form, so re-enforce them here. ADD ONLY — DELETE is never
  // guarded and falls straight through to the branch below.
  if (input.operation === 'ADD') {
    // GUARD 0 — reject 0.0.0.0/0 (any) on either endpoint: a catch-all ACL is
    // potentially fatal. Checked first, before anything hits the device.
    assertNotAnyAclEndpoint(input)

    // GUARD 1 — same endpoint (pure, no n8n call): Source and Destination may
    // not resolve to the SAME IPv4. For a bidirectional ADD this single check
    // covers both directions — swapping two equal values is still equal.
    if (input.source.trim() === input.destination.trim()) {
      throw apiError(400, 'ACL_SAME_ENDPOINT', 'Source and Destination must not use the same IP address.')
    }

    // GUARDS 2 & 3 — existence pre-check (IP pair alone). Fail-closed.
    if (await aclAddAlreadyExists(input)) {
      throw apiError(409, 'ACL_ALREADY_EXISTS', 'An ACL for this Source -> Destination already exists on the device. To change its subnet or time range, delete the existing entry via Delete ACL first, then add it again.')
    }

    // GUARD 4 — "Create New" time range must not duplicate an existing object
    // name on the device (no second object with the same name). Existing-mode
    // time ranges reference an object on purpose and are skipped.
    const trName = newTimeRangeName(input)
    if (trName) {
      await assertNewTimeRangeNotDuplicate(trName, { username: input.execUsername, password: input.execPassword })
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

/**
 * Turn one bulk row + the batch-global fields into the full single-ADD input
 * shape the existing helpers already understand (withCorrectedAclIps,
 * buildAclPreview, runAclDirection, aclAddAlreadyExists). Bulk never introduces
 * a new wire shape — a row is just a single ADD with shared ticket/credentials.
 */
function bulkRowToAddInput(
  item: AclBulkItemInput,
  batch: Pick<AclBulkExecuteInput, 'changeTicket' | 'execUsername' | 'execPassword' | 'globalTimeRange'>,
): AclExecuteInput {
  return {
    operation: 'ADD',
    source: item.source,
    sourceMask: item.sourceMask,
    destination: item.destination,
    destinationMask: item.destinationMask,
    changeTicket: batch.changeTicket,
    execUsername: batch.execUsername,
    execPassword: batch.execPassword,
    // The batch-global time range (existing-only) OVERRIDES the row's own when
    // present, so every row shares one on-device object; otherwise the row uses
    // its own time range. Global is existing-mode, so it never creates a dupe.
    timeRange: batch.globalTimeRange ?? item.timeRange,
    // Per-row bidirectional (NOT batch-global): aclAddAlreadyExists and
    // runAclDirection already honor this flag per input.
    bidirectional: item.bidirectional || undefined,
  }
}

/**
 * BULK ADD PREVIEW — classify every row (NEW / EXISTS) and render its redacted
 * command, with NO audit and NO n8n execute. Each row runs the SAME ADD
 * existence pre-check as the single flow (`aclAddAlreadyExists`, which honors
 * `bidirectional` by checking both directions) and the SAME preview renderer
 * (`buildAclPreview`). `hasBlocking` is true when any row already exists; the
 * UI uses it to disable Execute until the operator removes the blocking rows.
 *
 * Pre-check is one `acl/show` per direction per row (kept simple; a per-source
 * cache is a later optimization if ever needed). Fail-closed: if any row's
 * pre-check cannot verify, `aclAddAlreadyExists` throws the shared 503 and the
 * whole preview fails rather than mislabeling a row.
 */
/**
 * Detect "Create New" time-range name duplications across a corrected batch.
 * Returns, per row index, a blocking reason string when the row's `new`
 * time-range name clashes EITHER with another `new` row in the SAME batch OR
 * with an object already on the device. Rows with no `new` time range (plain,
 * existing-mode, or the global time range which is existing-only) never clash.
 *
 * One `fetchTimeRanges` call per batch (device names), plus an in-batch tally.
 * Never throws (device lookup degrades to empty — n8n stays the final authority
 * at execute time).
 */
async function bulkNewTimeRangeClashes(
  corrected: AclExecuteInput[],
  creds: { username: string, password: string },
): Promise<Map<number, string>> {
  const names = corrected.map(newTimeRangeName)
  const anyNew = names.some(n => n !== null)
  const clashes = new Map<number, string>()
  if (!anyNew) return clashes

  // In-batch tally: how many rows derive each new name.
  const counts = new Map<string, number>()
  for (const n of names) if (n) counts.set(n, (counts.get(n) ?? 0) + 1)

  // Device names (existing objects).
  const { objects } = await fetchTimeRanges(creds)
  const onDevice = new Set(objects.map(o => o.name))

  for (let i = 0; i < names.length; i++) {
    const n = names[i]
    if (!n) continue
    if (onDevice.has(n)) {
      clashes.set(i, `Time range "${n}" already exists on the device. Use the global or per-row "Select Existing" instead.`)
    }
    else if ((counts.get(n) ?? 0) > 1) {
      clashes.set(i, `Time range "${n}" is created by more than one row. Keep one "Create New" and switch the others to "Select Existing".`)
    }
  }
  return clashes
}

export async function aclBulkPreview(input: AclBulkPreviewInput): Promise<AclBulkPreviewResult> {
  const corrected = input.items.map(item => withCorrectedAclIps(bulkRowToAddInput(item, input)))
  const trClashes = await bulkNewTimeRangeClashes(corrected, {
    username: input.execUsername,
    password: input.execPassword,
  })

  const rows: AclBulkPreviewRow[] = []
  for (let index = 0; index < corrected.length; index++) {
    const row = corrected[index]!
    const srcMask = 'sourceMask' in row ? row.sourceMask : undefined
    const dstMask = 'destinationMask' in row ? row.destinationMask : undefined
    const isAny = isAnyAddress(row.source, srcMask) || isAnyAddress(row.destination, dstMask)
    const exists = isAny ? false : await aclAddAlreadyExists(row)
    const trReason = trClashes.get(index) ?? null
    // Precedence: any-address (fatal) first, then pair-exists, then TR duplicate.
    let status: AclBulkPreviewRow['status'] = 'NEW'
    let reason: string | null = null
    if (isAny) {
      status = 'EXISTS'
      reason = '0.0.0.0/0 (any) is not allowed — it would match all traffic. Use a specific address and mask.'
    }
    else if (exists) {
      status = 'EXISTS'
      reason = 'This Source → Destination already exists on the device.'
    }
    else if (trReason) {
      status = 'TR_DUPLICATE'
      reason = trReason
    }
    rows.push({
      index,
      source: row.source,
      destination: row.destination,
      status,
      reason,
      command: buildAclPreview(row).command,
    })
  }
  return { rows, hasBlocking: rows.some(r => r.status !== 'NEW') }
}

/**
 * BULK ADD EXECUTE — add several pairs under ONE iTop ticket and ONE set of
 * credentials. Posture is ALL-OR-NOTHING at the gate: the iTop ticket guard runs
 * ONCE, then EVERY row is re-checked (same-endpoint + existence) up front; if any
 * row is blocking (already exists or same endpoint), the WHOLE batch is rejected
 * with 409 and NOTHING executes — a direct API call cannot half-apply a batch.
 *
 * Only once every row is clean does the batch run: each row goes through the
 * existing per-direction `runAclDirection` (forward, then reverse when
 * bidirectional), so every direction keeps its own correlation id and audit row.
 * There is no cross-row transaction and no rollback (n8n has already executed on
 * the device), so a row that fails at the n8n call is recorded as FAILED in its
 * result while the other rows still run. `allOk` is true only when every
 * direction of every row succeeded.
 */
export async function aclBulkExecute(
  db: Database,
  ctx: AuditContext,
  input: AclBulkExecuteInput,
): Promise<AclBulkExecuteResult> {
  // 1) iTop ticket guard — ONCE for the whole batch (all rows share the ticket).
  await assertTicketExists(input.changeTicket)

  // 2) Pre-correct every row, then HARD-GATE the whole batch. Collect the rows
  //    that are blocking (same endpoint or already on the device). If ANY row is
  //    blocking, reject the batch and execute nothing (all-or-nothing posture
  //    the preview gate also enforces client-side).
  const corrected = input.items.map(item => withCorrectedAclIps(bulkRowToAddInput(item, input)))

  // "Create New" time-range name duplications (device + in-batch), computed once.
  const trClashes = await bulkNewTimeRangeClashes(corrected, {
    username: input.execUsername,
    password: input.execPassword,
  })

  const blocking = new Set<number>()
  for (let index = 0; index < corrected.length; index++) {
    const row = corrected[index]!
    const srcMask = 'sourceMask' in row ? row.sourceMask : undefined
    const dstMask = 'destinationMask' in row ? row.destinationMask : undefined
    if (isAnyAddress(row.source, srcMask) || isAnyAddress(row.destination, dstMask)) {
      blocking.add(index)
      continue
    }
    if (row.source.trim() === row.destination.trim()) {
      blocking.add(index)
      continue
    }
    if (await aclAddAlreadyExists(row)) {
      blocking.add(index)
      continue
    }
    if (trClashes.has(index)) {
      blocking.add(index)
    }
  }
  if (blocking.size > 0) {
    throw apiError(
      409,
      'ACL_BULK_HAS_BLOCKING',
      'Some rows are blocked: they already exist, use Source = Destination, or create a duplicate time-range name. Fix those rows, then run the batch again.',
      // `fields` carries the blocking row indexes so the UI can re-highlight them.
      { items: [...blocking].map(String) },
    )
  }

  // 3) All rows clean → execute each via the existing per-direction path. A row
  //    failing at the n8n call does NOT abort the batch; it is recorded FAILED.
  //    One shared batchId stamps every row's audit payload (forward AND reverse)
  //    so the whole submission can be grouped in the Log Trail while each row
  //    keeps its own SUCCESS/FAILED row — partial failure stays fully visible.
  const batchId = randomUUID()
  const batchSize = corrected.length
  const rows: AclBulkExecuteRow[] = []
  let allOk = true
  for (let index = 0; index < corrected.length; index++) {
    const row = corrected[index]!
    const batchMeta = { batchId, batchIndex: index, batchSize }
    const forward = await runAclDirection(db, ctx, row, batchMeta)
    let reverse: OperationResult | null = null
    if (row.operation === 'ADD' && row.bidirectional) {
      reverse = await runAclDirection(db, ctx, reverseAclDirection(row), batchMeta)
    }
    if (forward.status !== 'SUCCESS' || (reverse && reverse.status !== 'SUCCESS')) {
      allOk = false
    }
    rows.push({
      index,
      source: row.source,
      destination: row.destination,
      forward,
      reverse,
    })
  }

  return { rows, allOk }
}
