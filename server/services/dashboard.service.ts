import { count, desc, sql } from 'drizzle-orm'

import type { Database } from '~~/database'
import { auditLogs } from '~~/database/schema/audit-logs'

/**
 * Dashboard widgets — each derived entirely from `audit_logs`.
 *
 * This app is not the source of truth for ACL/route configuration, so the
 * dashboard summarizes ACTIVITY (executions and their outcomes), not counts of
 * ACLs/routes on devices. Every number here is computed by SQL aggregation over
 * `audit_logs`; nothing is hardcoded.
 *
 * The dashboard is split into FIVE independent widget functions so the frontend
 * can fire them in parallel and each widget shows its own loading/error state:
 *   - getKpi                 — three KPI cards (this month vs last month).
 *   - getActivitySeries      — daily/weekly/monthly series in one response.
 *   - getConfigByOperation   — the fixed four config operations, zero-filled.
 *   - getTopUsers            — most active users (grouped by username).
 *   - getRecentConfigChanges — newest config mutations (safe projection).
 *
 * A "config change" is a real device-policy mutation:
 *   module IN ('ACL','ROUTE') AND action IN ('ADD','DELETE').
 *
 * Month boundaries are evaluated in the DB (`date_trunc('month', now())`) so the
 * current-vs-previous-month deltas are server-consistent (no Node/DB tz drift);
 * `created_at` is timestamptz.
 */

/** A KPI card value plus its "vs last month" change. */
interface KpiDelta {
  /** Big number shown on the card. */
  value: number
  /** thisMonth − lastMonth (count), or percentage-point change (success rate). */
  delta: number
}

/** The three KPI cards. */
export interface Kpi {
  /** All-time activity count + (thisMonth − lastMonth). */
  totalActivity: KpiDelta
  /** All-time config-change count + delta. */
  configChanges: KpiDelta
  /** All-time SUCCESS/total*100 (rounded) + percentage-point delta. */
  successRate: KpiDelta
}

/** One point in a time series (bucket key + count). */
interface SeriesPoint {
  /** Stable bucket key from the DB (e.g. '2026-10-01', '2026-W40', '2026-10'). */
  bucket: string
  count: number
}

/** All three activity series in one response (client toggles without refetch). */
export interface ActivitySeries {
  /** Daily buckets, last ~14 days. */
  daily: SeriesPoint[]
  /** ISO-week buckets, last ~12 weeks. */
  weekly: SeriesPoint[]
  /** Month buckets, last ~12 months. */
  monthly: SeriesPoint[]
}

/** A single config operation bar (fixed four). */
interface ConfigByOperation {
  /** 'ROUTE/ADD' | 'ROUTE/DELETE' | 'ACL/ADD' | 'ACL/DELETE'. */
  operation: string
  count: number
}

/** The fixed four config operations, zero-filled, in a stable order. */
export interface ConfigByOperationResult {
  items: ConfigByOperation[]
}

/** A top-active-user row (grouped by username). */
interface TopUser {
  username: string
  count: number
}

/** Most active users, count desc, limited. */
export interface TopUsersResult {
  items: TopUser[]
}

/** A recent config-change feed row — a safe projection (no raw rows/payloads). */
interface RecentConfigChange {
  id: string
  module: string
  action: string
  username: string | null
  status: string
  createdAt: string
}

/** Newest-first config changes, limited; safe shape only. */
export interface RecentConfigChangesResult {
  items: RecentConfigChange[]
}

// `count()` / `sql<number>` from the postgres.js driver can come back as
// strings; coerce before any arithmetic.
function num(value: unknown): number {
  return Number(value ?? 0)
}

/** SUCCESS/total*100 rounded; 0 when the window is empty (guards div-by-zero). */
function rate(success: number, total: number): number {
  return total > 0 ? Math.round((success / total) * 100) : 0
}

// Reusable SQL fragments for month windows (evaluated in the DB).
const inThisMonth = sql`${auditLogs.createdAt} >= date_trunc('month', now())`
const inLastMonth = sql`${auditLogs.createdAt} >= date_trunc('month', now()) - interval '1 month' and ${auditLogs.createdAt} < date_trunc('month', now())`
const isConfigChange = sql`${auditLogs.module} in ('ACL','ROUTE') and ${auditLogs.action} in ('ADD','DELETE')`

/**
 * KPI cards: Total Activity, Config Changes, Success Rate — each with a static
 * "this calendar month vs previous calendar month" delta. One grouped query
 * using FILTER so a single scan computes every window.
 */
export async function getKpi(db: Database): Promise<Kpi> {
  const kpiRows = await db
    .select({
      totalAll: count(),
      totalThis: sql<number>`count(*) filter (where ${inThisMonth})`,
      totalLast: sql<number>`count(*) filter (where ${inLastMonth})`,
      successAll: sql<number>`count(*) filter (where ${auditLogs.status} = 'SUCCESS')`,
      successThis: sql<number>`count(*) filter (where ${auditLogs.status} = 'SUCCESS' and ${inThisMonth})`,
      successLast: sql<number>`count(*) filter (where ${auditLogs.status} = 'SUCCESS' and ${inLastMonth})`,
      cfgAll: sql<number>`count(*) filter (where ${isConfigChange})`,
      cfgThis: sql<number>`count(*) filter (where ${isConfigChange} and ${inThisMonth})`,
      cfgLast: sql<number>`count(*) filter (where ${isConfigChange} and ${inLastMonth})`,
    })
    .from(auditLogs)

  const k = kpiRows[0]!

  const totalAll = num(k.totalAll)
  const totalThis = num(k.totalThis)
  const totalLast = num(k.totalLast)
  const successAll = num(k.successAll)
  const successThis = num(k.successThis)
  const successLast = num(k.successLast)
  const cfgAll = num(k.cfgAll)
  const cfgThis = num(k.cfgThis)
  const cfgLast = num(k.cfgLast)

  return {
    totalActivity: { value: totalAll, delta: totalThis - totalLast },
    configChanges: { value: cfgAll, delta: cfgThis - cfgLast },
    successRate: {
      value: rate(successAll, totalAll),
      delta: rate(successThis, totalThis) - rate(successLast, totalLast),
    },
  }
}

/**
 * Activity Over Time: daily/weekly/monthly series in ONE response so the
 * client's Daily/Weekly/Monthly toggle switches instantly without refetching.
 * Each series uses date_trunc; the bucket is formatted to a stable string key.
 */
export async function getActivitySeries(db: Database): Promise<ActivitySeries> {
  const dailyQuery = db
    .select({
      bucket: sql<string>`to_char(date_trunc('day', ${auditLogs.createdAt}), 'YYYY-MM-DD')`,
      count: count(),
    })
    .from(auditLogs)
    .where(sql`${auditLogs.createdAt} >= date_trunc('day', now()) - interval '13 days'`)
    .groupBy(sql`date_trunc('day', ${auditLogs.createdAt})`)
    .orderBy(sql`date_trunc('day', ${auditLogs.createdAt})`)

  const weeklyQuery = db
    .select({
      bucket: sql<string>`to_char(date_trunc('week', ${auditLogs.createdAt}), 'IYYY-"W"IW')`,
      count: count(),
    })
    .from(auditLogs)
    .where(sql`${auditLogs.createdAt} >= date_trunc('week', now()) - interval '11 weeks'`)
    .groupBy(sql`date_trunc('week', ${auditLogs.createdAt})`)
    .orderBy(sql`date_trunc('week', ${auditLogs.createdAt})`)

  const monthlyQuery = db
    .select({
      bucket: sql<string>`to_char(date_trunc('month', ${auditLogs.createdAt}), 'YYYY-MM')`,
      count: count(),
    })
    .from(auditLogs)
    .where(sql`${auditLogs.createdAt} >= date_trunc('month', now()) - interval '11 months'`)
    .groupBy(sql`date_trunc('month', ${auditLogs.createdAt})`)
    .orderBy(sql`date_trunc('month', ${auditLogs.createdAt})`)

  const [daily, weekly, monthly] = await Promise.all([dailyQuery, weeklyQuery, monthlyQuery])

  const toSeries = (rows: { bucket: string, count: number }[]): SeriesPoint[] =>
    rows.map(r => ({ bucket: r.bucket, count: num(r.count) }))

  return {
    daily: toSeries(daily),
    weekly: toSeries(weekly),
    monthly: toSeries(monthly),
  }
}

/**
 * Config Changes by Operation: the fixed four (ROUTE/ADD, ROUTE/DELETE,
 * ACL/ADD, ACL/DELETE), zero-filled and in a stable order.
 */
export async function getConfigByOperation(db: Database): Promise<ConfigByOperationResult> {
  const cfgRows = await db
    .select({ module: auditLogs.module, action: auditLogs.action, count: count() })
    .from(auditLogs)
    .where(isConfigChange)
    .groupBy(auditLogs.module, auditLogs.action)

  // Fixed order; zero-fill combos with no rows.
  const cfgLookup = new Map(cfgRows.map(r => [`${r.module}/${r.action}`, num(r.count)]))
  const items: ConfigByOperation[] = ['ROUTE/ADD', 'ROUTE/DELETE', 'ACL/ADD', 'ACL/DELETE'].map(
    operation => ({ operation, count: cfgLookup.get(operation) ?? 0 }),
  )

  return { items }
}

/** Top Active Users: grouped by username, count desc, limited. */
export async function getTopUsers(db: Database): Promise<TopUsersResult> {
  const users = await db
    .select({ username: auditLogs.username, count: count() })
    .from(auditLogs)
    .groupBy(auditLogs.username)
    .orderBy(desc(sql`count(*)`))
    .limit(8)

  const items: TopUser[] = users.map(r => ({ username: r.username ?? '—', count: num(r.count) }))

  return { items }
}

/** Recent Config Changes: newest-first, limited, safe projection (no payloads/secrets). */
export async function getRecentConfigChanges(db: Database): Promise<RecentConfigChangesResult> {
  const recent = await db
    .select({
      id: auditLogs.id,
      module: auditLogs.module,
      action: auditLogs.action,
      username: auditLogs.username,
      status: auditLogs.status,
      createdAt: auditLogs.createdAt,
    })
    .from(auditLogs)
    .where(isConfigChange)
    .orderBy(desc(auditLogs.createdAt))
    .limit(8)

  const items: RecentConfigChange[] = recent.map(r => ({
    id: r.id,
    module: r.module,
    action: r.action,
    username: r.username,
    status: r.status,
    createdAt: r.createdAt.toISOString(),
  }))

  return { items }
}
