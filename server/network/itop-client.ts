import mysql from 'mysql2/promise'

import { loadEnv } from '../utils/config'

// The ONLY component that talks to iTop. iTop is a FOREIGN, READ-ONLY MariaDB —
// it is NOT part of the Drizzle schema. Every function here issues SELECT only
// (no write/DDL, no multipleStatements), binds all input as `?` placeholders,
// is bounded by ITOP_TIMEOUT_MS, and NEVER surfaces SQL/connection string/driver
// detail upward (failures are normalized to a bare ItopUnreachableError).
//
// Column names below were confirmed against the live iTop schema (read-only
// SHOW COLUMNS); fields whose columns are absent on a given table are simply not
// selected and stay `undefined` in the mapped response.

let pool: mysql.Pool | null = null

/**
 * Lazily create the pool from ITOP_DATABASE_URL. Returns null when iTop is not
 * configured so callers can report "not configured" rather than throwing.
 */
function getPool(): mysql.Pool | null {
  const env = loadEnv()
  if (!env.ITOP_DATABASE_URL) {
    return null
  }
  if (!pool) {
    pool = mysql.createPool({
      uri: env.ITOP_DATABASE_URL,
      connectionLimit: 4,
      // Best-effort TCP-connect ceiling only; the authoritative per-request
      // bound is the Promise.race in run(). multipleStatements is left off
      // (default) as defense against statement injection.
      connectTimeout: env.ITOP_TIMEOUT_MS,
      waitForConnections: true,
      queueLimit: 0,
    })
  }
  return pool
}

/** Raised for any iTop failure (unconfigured, unreachable, timeout, query error). */
export class ItopUnreachableError extends Error {}

/**
 * Run one parameterized SELECT bounded by ITOP_TIMEOUT_MS.
 *
 * The AUTHORITATIVE deadline is the Promise.race against a setTimeout below —
 * NOT the driver's per-query `timeout` option and NOT the pool's connectTimeout.
 * `pool.getConnection()` is itself unbounded when the pool is exhausted or the
 * server is unresponsive, so wrapping the WHOLE operation (acquire + query) in
 * the race is the single enforcement point behind "never block the request,
 * always surface ItopUnreachableError". The plain `conn.query(sql, params)` form
 * is used (not the `{ sql, timeout }` object form) so array / `IN (?)` expansion
 * is unambiguous.
 */
async function run<T extends mysql.RowDataPacket[]>(sql: string, params: unknown[]): Promise<T> {
  const p = getPool()
  if (!p) {
    throw new ItopUnreachableError('iTop is not configured')
  }
  const env = loadEnv()
  const deadline = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new ItopUnreachableError('iTop timed out')), env.ITOP_TIMEOUT_MS),
  )
  const work = (async () => {
    const conn = await p.getConnection()
    try {
      const [rows] = await conn.query<T>(sql, params)
      return rows
    }
    finally {
      conn.release()
    }
  })()
  try {
    return await Promise.race([work, deadline])
  }
  catch (err) {
    // Log the real driver detail server-side (visible in container logs /
    // Portainer) for diagnostics, WITHOUT the connection string or password.
    logItopError('query', err)
    // Never leak SQL / connection string / driver detail upward to the client.
    throw new ItopUnreachableError('iTop query failed')
  }
}

/**
 * Log an iTop failure to the server console for diagnostics. Prints only the
 * driver's safe fields (name/code/errno/sqlState/message) — never the
 * connection string, password, or full SQL. Visible in `docker logs` / Portainer.
 */
function logItopError(context: string, err: unknown): void {
  const e = err as { name?: string, code?: string, errno?: number, sqlState?: string, message?: string }
  console.error(
    `[itop] ${context} failed:`,
    JSON.stringify({
      name: e?.name,
      code: e?.code,
      errno: e?.errno,
      sqlState: e?.sqlState,
      message: e?.message,
    }),
  )
}

// ---------------------------------------------------------------------------
// Row shapes (internal — mapped to Zod response shapes in the service layer).
// ---------------------------------------------------------------------------

export interface TicketRow extends mysql.RowDataPacket {
  id: number
  ref: string | null
  title: string | null
  operational_status: string | null
  start_date: Date | string | null
  end_date: Date | string | null
  description: string | null
  finalclass: string | null
  caller_id: number | null
  org_id: number | null
}

export interface RequestDetailRow extends mysql.RowDataPacket {
  status: string | null
  impact: string | null
  priority: string | null
  urgency: string | null
  origin: string | null
  resolution_code: string | null
  solution: string | null
}

export interface ProblemDetailRow extends mysql.RowDataPacket {
  status: string | null
  impact: string | null
  priority: string | null
  urgency: string | null
}

export interface ChangeDetailRow extends mysql.RowDataPacket {
  status: string | null
  impact: string | null
  reason: string | null
  outage: string | null
  fallback: string | null
  requestor_id: number | null
  acceptance_comment: string | null
}

export interface ContactRow extends mysql.RowDataPacket {
  id: number
  name: string | null
  email: string | null
}

export interface OrgRow extends mysql.RowDataPacket {
  id: number
  name: string | null
}

// ---------------------------------------------------------------------------
// SELECT-only queries. All input is bound as `?` placeholders.
// ---------------------------------------------------------------------------

/** Search the parent `ticket` table only (no joins). `q` -> `%q%` bound as a param. */
export async function searchTickets(q: string, limit: number): Promise<TicketRow[]> {
  const like = `%${q}%`
  return run<TicketRow[]>(
    `SELECT id, ref, title, operational_status, start_date, end_date, finalclass
     FROM ticket
     WHERE ref LIKE ? OR title LIKE ?
     LIMIT ?`,
    [like, like, limit],
  )
}

/** Fetch a single parent `ticket` row by its indexed `ref`. */
export async function getTicketByRef(ref: string): Promise<TicketRow | null> {
  const rows = await run<TicketRow[]>(
    `SELECT id, ref, title, operational_status, start_date, end_date, description,
            finalclass, caller_id, org_id
     FROM ticket
     WHERE ref = ?
     LIMIT 1`,
    [ref],
  )
  return rows[0] ?? null
}

/** UserRequest detail row (shares the parent `ticket.id`). */
export async function getRequestDetail(id: number): Promise<RequestDetailRow | null> {
  const rows = await run<RequestDetailRow[]>(
    `SELECT status, impact, priority, urgency, origin, resolution_code, solution
     FROM ticket_request
     WHERE id = ?
     LIMIT 1`,
    [id],
  )
  return rows[0] ?? null
}

/** Incident detail row. */
export async function getIncidentDetail(id: number): Promise<RequestDetailRow | null> {
  const rows = await run<RequestDetailRow[]>(
    `SELECT status, impact, priority, urgency, origin, resolution_code, solution
     FROM ticket_incident
     WHERE id = ?
     LIMIT 1`,
    [id],
  )
  return rows[0] ?? null
}

/** Problem detail row (no origin / resolution_code / solution columns in iTop). */
export async function getProblemDetail(id: number): Promise<ProblemDetailRow | null> {
  const rows = await run<ProblemDetailRow[]>(
    `SELECT status, impact, priority, urgency
     FROM ticket_problem
     WHERE id = ?
     LIMIT 1`,
    [id],
  )
  return rows[0] ?? null
}

/**
 * Change detail row (all four change subtypes read their base row from the
 * reserved-word table `change`, which is ALWAYS backticked). NormalChange's
 * acceptance_comment lives in change_normal, left-joined so other subtypes still
 * resolve with a null acceptance_comment.
 */
export async function getChangeDetail(id: number): Promise<ChangeDetailRow | null> {
  const rows = await run<ChangeDetailRow[]>(
    `SELECT c.status, c.impact, c.reason, c.outage, c.fallback, c.requestor_id,
            cn.acceptance_comment
     FROM \`change\` c
     LEFT JOIN change_normal cn ON cn.id = c.id
     WHERE c.id = ?
     LIMIT 1`,
    [id],
  )
  return rows[0] ?? null
}

/** Resolve contacts by PK. ids are passed WRAPPED ([ids]) for `IN (?)` expansion. */
export async function resolveContacts(ids: number[]): Promise<ContactRow[]> {
  if (ids.length === 0) {
    return [] // IN () is invalid SQL — guard before run().
  }
  return run<ContactRow[]>('SELECT id, name, email FROM contact WHERE id IN (?)', [ids])
}

/** Resolve organizations by PK. ids are passed WRAPPED ([ids]) for `IN (?)` expansion. */
export async function resolveOrganizations(ids: number[]): Promise<OrgRow[]> {
  if (ids.length === 0) {
    return []
  }
  return run<OrgRow[]>('SELECT id, name FROM organization WHERE id IN (?)', [ids])
}

/** Read-only connectivity probe. Never throws; returns a safe { ok, message }. */
export async function pingItop(): Promise<{ ok: boolean, message: string }> {
  try {
    if (!getPool()) {
      console.warn('[itop] test connection: ITOP_* env not configured (pool not created)')
      return { ok: false, message: 'iTop is not configured' }
    }
    await run('SELECT 1', [])
    console.log('[itop] test connection: OK (SELECT 1 succeeded)')
    return { ok: true, message: 'iTop connection OK' }
  }
  catch (err) {
    // run() already logged the driver detail; add a line marking the probe path.
    logItopError('test connection', err)
    return { ok: false, message: 'iTop is unreachable' }
  }
}
