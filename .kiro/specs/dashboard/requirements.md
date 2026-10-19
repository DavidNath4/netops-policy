# Requirements Document — Dashboard

## Introduction

This spec is the authoritative document for the **Dashboard** at `/` (the default
layout landing page): a BI overview derived entirely from `audit_logs`. Because
the application is the audit system of record and NOT the source of truth for
device state, every dashboard number summarizes recorded ACTIVITY (operations and
their outcomes), not counts of ACLs or routes on devices.

The dashboard is composed of **five independent widgets**, each backed by its own
auth-only endpoint and each fetching in parallel with its own loading / error /
empty state. `app/pages/index.vue` is a thin composing page that places the
widget components; the aggregation lives in `server/services/dashboard.service.ts`.

Related specs:

- **log-trail/** — the `audit_logs` source of every dashboard number.
- **general/** — system overview and the API envelope.

### Scope

In scope: the five widget endpoints and their service functions, the data shape
and aggregation semantics of each widget, the composing page, and the chart
rendering approach. Out of scope: any device-state counting (there is none), the
audit schema itself (see log-trail/), and feature-level RBAC (the dashboard is
common access).

## Glossary

- **Dashboard_Service**: The server component (`server/services/dashboard.service.ts`) exposing `getKpi`, `getActivitySeries`, `getConfigByOperation`, `getTopUsers`, and `getRecentConfigChanges`, each aggregating over `audit_logs`.
- **Config_Change**: A real device-policy mutation — `module IN ('ACL','ROUTE') AND action IN ('ADD','DELETE')`. Used by the KPI, Config-by-Operation, and Recent-Config-Changes widgets.
- **Widget**: A self-contained SFC under `app/components/dashboard/` that owns one fetch and its own loading/error/empty state.

## Requirements

### Requirement 1: Composition and access

**User Story:** As any authenticated operator, I want an at-a-glance activity overview, so that I can see system health without a special permission.

#### Acceptance Criteria

1. THE Dashboard SHALL be common access — every endpoint SHALL require only an authenticated session (`requireAuthenticatedUser`) and SHALL NOT require a feature permission.
2. THE five widgets SHALL each fetch an INDEPENDENT endpoint in parallel and SHALL each render its own loading, error, and empty state.
3. `app/pages/index.vue` SHALL be a thin composing page that places the widget components and holds no data-fetching logic.
4. THE Dashboard_Service SHALL derive every value by SQL aggregation over `audit_logs`; nothing SHALL be hardcoded or read from device state.
5. WHERE a widget renders a chart, it SHALL use the `nuxt-charts` `<BarChart>` wrapped in `<ClientOnly>` (with a loading fallback) so the chart renders only in the browser.

### Requirement 2: Component inventory

**User Story:** As a developer, I want the real component layout documented, so that I can find and extend each widget.

#### Acceptance Criteria

1. THE dashboard components under `app/components/dashboard/` SHALL be: `KpiRow.vue`, `KpiActivity.vue`, `KpiConfigChanges.vue`, `KpiSuccessRate.vue`, `KpiStatCard.vue`, `ActivityOverTime.vue`, `ConfigByOperation.vue`, `TopActiveUsers.vue`, and `RecentConfigChanges.vue`.
2. `KpiRow.vue` SHALL fetch `/api/dashboard/kpi` ONCE and distribute each value to the three presentational KPI widgets (`KpiActivity`, `KpiConfigChanges`, `KpiSuccessRate`), which render through the shared presentational `KpiStatCard.vue`.
3. THE composing page SHALL reference the widgets with their `Dashboard`-prefixed auto-import names (e.g. `<DashboardKpiRow />`, `<DashboardActivityOverTime />`).

### Requirement 3: Widget — KPI row (`GET /api/dashboard/kpi`)

**User Story:** As an operator, I want current-month headline numbers with a month-over-month comparison, so that I can gauge recent activity at a glance.

#### Acceptance Criteria

1. THE `GET /api/dashboard/kpi` endpoint SHALL return `getKpi` as `{ totalActivity, configChanges, successRate }`, each a `{ value, delta }` pair.
2. `value` SHALL be computed for the CURRENT calendar month and `delta` SHALL be `(current month − previous month)`; month boundaries SHALL be evaluated in the database (`date_trunc('month', now())`) over `created_at` (timestamptz).
3. `totalActivity.value` SHALL be the count of all audit rows this month; `configChanges.value` SHALL be the count of Config_Change rows this month; `successRate.value` SHALL be `round(SUCCESS / total * 100)` for the month (0 when the window is empty).
4. `successRate.delta` SHALL be a percentage-point change (this month's rate − last month's rate); the activity and config deltas SHALL be count differences.
5. THE three cards SHALL render through `KpiStatCard`; the success-rate delta tone SHALL be semantic (positive/negative), while the volume deltas SHALL be neutral.

### Requirement 4: Widget — Activity Over Time (`GET /api/dashboard/activity-series`)

**User Story:** As an operator, I want an activity trend I can view by day, week, or month, so that I can spot patterns over time.

#### Acceptance Criteria

1. THE `GET /api/dashboard/activity-series` endpoint SHALL return `getActivitySeries` as `{ daily, weekly, monthly }`, each an array of `{ bucket, count }` points, in ONE response.
2. THE windows SHALL be: daily = last 14 days, weekly = last 12 ISO weeks, monthly = last 12 months; each series SHALL be ZERO-FILLED via `generate_series` so every bucket in the window is present (periods with no activity render as a 0 bar).
3. THE bucket keys SHALL be `YYYY-MM-DD` (daily), `IYYY-"W"IW` (weekly), and `YYYY-MM` (monthly), produced by `date_trunc` + `to_char`.
4. THE widget SHALL expose a Daily / Weekly / Monthly toggle that switches the already-fetched series CLIENT-SIDE with no refetch.
5. THE widget SHALL render a `<BarChart>` in `<ClientOnly>` whose series color is `#2563eb` (category name "Activity"), remounting on granularity change (keyed) to clear stale tooltip state.

### Requirement 5: Widget — Config Changes by Operation (`GET /api/dashboard/config-by-operation`)

**User Story:** As an operator, I want to see how config changes break down by operation, so that I know which operations dominate.

#### Acceptance Criteria

1. THE `GET /api/dashboard/config-by-operation` endpoint SHALL return `getConfigByOperation` as `{ items: { operation, count }[] }`.
2. THE items SHALL be exactly the fixed four operations, ZERO-FILLED and in this stable order: `ROUTE/ADD`, `ROUTE/DELETE`, `ACL/ADD`, `ACL/DELETE`.
3. THE counts SHALL be computed by grouping Config_Change rows by `module` and `action`; a combination with no rows SHALL appear with `count = 0`.
4. THE widget SHALL render a `<BarChart>` in `<ClientOnly>` whose series color is `#1a57ab` (category name "Config changes").

### Requirement 6: Widget — Top Active Users (`GET /api/dashboard/top-users`)

**User Story:** As an operator, I want to see who is most active, so that I can understand usage distribution.

#### Acceptance Criteria

1. THE `GET /api/dashboard/top-users` endpoint SHALL return `getTopUsers` as `{ items: { username, count }[] }`.
2. THE results SHALL be grouped by `username`, ordered by activity count descending, and limited to the top 8; a null username SHALL be presented as `—`.
3. THE widget SHALL render a compact ranked list (no chart) with its own loading/error/empty states.

### Requirement 7: Widget — Recent Config Changes (`GET /api/dashboard/recent-config-changes`)

**User Story:** As an operator, I want a feed of the newest config mutations, so that I can see recent activity with its outcome.

#### Acceptance Criteria

1. THE `GET /api/dashboard/recent-config-changes` endpoint SHALL return `getRecentConfigChanges` as `{ items: { id, module, action, username, status, createdAt }[] }`.
2. THE results SHALL be the latest Config_Change rows, newest-first, limited to 8.
3. THE projection SHALL be a safe shape only — no JSONB payload, no raw row, and no secret; `createdAt` SHALL be an ISO string.
4. THE widget SHALL render a compact feed with inline status and a readable local timestamp (matching the Log Trail format).

## Non-Functional Requirements

### Security

1. EVERY dashboard endpoint SHALL return only aggregated or safe-projected data through the standard `{ success, data }` envelope and SHALL expose no JSONB payload, raw row, SQL, or secret.

### Performance

1. THE KPI endpoint SHALL compute all windows in a single grouped scan (SQL `FILTER`), and the activity series SHALL compute its three windows as parallel queries, so each widget resolves in one round trip.
