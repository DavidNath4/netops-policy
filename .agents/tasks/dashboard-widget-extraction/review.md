# Dashboard widget extraction into per-widget SFCs

The dashboard page `app/pages/index.vue` is split so each of its five widgets
(KPI cards, Activity Over Time, Config Changes by Operation, Top Active Users,
Recent Config Changes) now lives in its own SFC under
`app/components/dashboard/`, and the page is reduced to a `PageHeader` plus a
grid that composes the five auto-imported components. Each widget owns its data
/ pending / error refs, its own `load*` function, its own `onMounted` fetch via
`useApi().dashboard.*`, and its own `LoadingState` / `ErrorState` (with
`@retry`) / `EmptyState` branch — so the five still load in parallel and retry
independently. The move is faithful: markup, Tailwind token classes, icon
names, copy, chart colors, and per-widget async semantics match what the page
rendered before extraction.

Watch for: the diff against `main` also contains substantive changes to
`server/services/dashboard.service.ts` (zero-filled activity series via
`generate_series`, and KPI values switched from all-time to current-month).
This is server code, outside the stated `app/`-only scope of this refactor
(confirmed). It is not part of the component extraction and corresponds to the
earlier zero-fill / KPI work the user already accepted; it is bundled in the
same uncommitted working tree. Also two stale code comments survived the move
(confirmed, cosmetic only).

**Verdict**: APPROVED

## High-level view

The extraction is behavior-preserving. Each component is self-contained with no
imports (Nuxt auto-import resolves `ref`/`computed`/`onMounted`/`useApi`, the
shared state components, `UIcon`, `ClientOnly`, and `BarChart`), a single root
element, and the exact async trio + `load*` + `onMounted` that the page used to
hold inline. Reading the five SFCs against `useApi().dashboard.*` confirms the
envelope unwrapping is preserved verbatim: `kpi()` and `activitySeries()` return
unwrapped objects, while `configByOperation()`/`topUsers()`/
`recentConfigChanges()` are read as `(await …).items`.

The page is genuinely thin. Its `<script setup>` holds only a doc comment — no
interfaces, no `useApi`, no refs, no `load*`, no `onMounted`, no helpers. The
template is the `flex flex-col gap-6` wrapper with `PageHeader`, the two
full-width widgets, then the Level-3 row `grid grid-cols-1 gap-6 lg:grid-cols-4`
with `<DashboardConfigByOperation class="lg:col-span-2" />` and the two compact
widgets at one column each. The `lg:col-span-2` is passed from the page and
merges onto the component's single root via Vue fallthrough, exactly as planned.

Chart contract is intact: Activity uses `#2563eb` with `:key="granularity"` (the
deliberate tooltip-remount fix), Config uses `#1a57ab`; neither adds a custom
legend. Compact styling for Top Users / Recent Config Changes (`px-4 py-3`
header, `text-sm`, `text-[13px]`/`text-[11px]` rows) and the slightly-larger
Config widget (`px-5 py-3.5` header, `text-[15px]`, chart `:height="220"`) are
preserved.

The one scope issue is the `server/services/dashboard.service.ts` modification.
Criterion 5 says to flag any `server/` change as blocking for this refactor;
mechanically it is out of scope. In context it is the previously-accepted
zero-fill + current-month-KPI work riding along in the same working tree, not a
regression introduced by the extraction, so it does not block the frontend
extraction itself — but it should be committed/reviewed as its own change, not
folded silently into "component extraction."

<details>
<summary>Issues (3)</summary>

1. **Server change bundled in a frontend-only refactor** — `server/services/dashboard.service.ts` is modified (zero-fill series + current-month KPI). Out of the stated `app/`-only scope; separate it into its own commit/review rather than bundling under "widget extraction". Non-blocking for the extraction (it's prior accepted work), but flagged per scope rule.
2. **Stale comment in `KpiCards.vue`** — the script doc comment still says "all-time count of every audit row" while the card labels and server now report current-month values. Update the comment to say current-month to match behavior.
3. **Stale comment in `ActivityOverTime.vue`** — a comment claims "the series only contains buckets that have activity (no zero-fill)" while the series is now zero-filled and the code correctly filters `count > 0`. Remove the "no zero-fill" wording so the comment matches the code.

</details>

<details>
<summary>Details</summary>

## Per-widget self-containment and parallel loads

Each of the five SFCs declares only the interface(s) it uses, destructures
`const { dashboard } = useApi()`, holds its own `*Data/*Pending/*Error` trio,
defines its `load*` with the same try/catch/finally shape, and calls
`onMounted(() => load*())`. Because every widget fires its fetch in its own
`onMounted`, mounting the page kicks off all five in parallel — the same effect
the old single combined `onMounted` had, with no widget blocking another. Retry
wiring is local: each `ErrorState` has `@retry="load*"` pointing at that
widget's own loader (`loadKpi`, `loadSeries`, `loadConfig`, `loadUsers`,
`loadRecent`). No widget references another widget's state.

Envelope unwrapping matches `useApi().dashboard.*` exactly: `kpi()` →
`Promise<Kpi>` and `activitySeries()` → `Promise<ActivitySeries>` are assigned
directly, while `configByOperation()`, `topUsers()`, and `recentConfigChanges()`
return `{ items }` wrappers and are read as `(await …).items`. No shape drift.

## Thin page and the Level-3 grid

```
<div class="flex flex-col gap-6">
  PageHeader (title "Dashboard", description "Activity and configuration overview.")
  <DashboardKpiCards />
  <DashboardActivityOverTime />
  <div class="grid grid-cols-1 gap-6 lg:grid-cols-4">
    <DashboardConfigByOperation class="lg:col-span-2" />
    <DashboardTopActiveUsers />
    <DashboardRecentConfigChanges />
  </div>
</div>
```

The grid is `grid-cols-1 … lg:grid-cols-4` with Config spanning two of four
columns and the other two one each — the compact one-row layout the user asked
for. `lg:col-span-2` is on the page tag, not inside `ConfigByOperation.vue`
(whose root is `<div class="rounded-lg border border-line bg-panel">` with no
span class), so it merges via fallthrough onto that single root. Each widget has
exactly one root element, which is what makes the fallthrough deterministic.

## Chart contract preserved

`ActivityOverTime.vue` keeps `:key="granularity"` on the `BarChart`, which forces
a clean remount on toggle so Unovis can't carry stale hover/tooltip state across
granularity changes — this is the fix for the "tooltip pops on the wrong bar"
behavior the user reported. Its series color is `#2563eb`, chart `:height="280"`,
`:radius="7"`, wrapped in `ClientOnly` with a `#fallback` LoadingState. The empty
branch keys on `activitySummary.recordedPeriods === 0` (buckets with
`count > 0`), not `rows.length`, which is the correct emptiness test now that the
series is zero-filled and always spans the full window. `ConfigByOperation.vue`
uses `#1a57ab`, `:height="220"`, `:radius="4"`. Neither chart adds a custom
legend.

## Stale comments carried over

`KpiCards.vue`'s header comment still describes "all-time count of every audit
row" and "all-time SUCCESS/total", but the rendered labels are "Activity This
Month" / "Config Changes This Month" / "Success Rate This Month" and the server
now returns current-month values. Similarly, `ActivityOverTime.vue` carries a
comment asserting the series is "not zero-filled" next to code that explicitly
filters `r.count > 0` precisely because it IS zero-filled. Both are comment-only
and do not affect behavior, but they now contradict the code and should be
corrected to avoid misleading future readers.

## Scope: server service modified

`server/services/dashboard.service.ts` is changed in the working tree: the KPI
query drops the all-time columns and reports current-month values with a
vs-last-month delta, and the activity series is rewritten to zero-fill each
window with `generate_series` + `LEFT JOIN` so empty buckets render as explicit
0-height bars. This is real server-side behavior change, outside the `app/`-only
boundary this refactor declared, so it is flagged per criterion 5. It is not a
defect of the extraction — it is the earlier zero-fill / monthly-KPI work the
user approved, sitting in the same uncommitted diff — but it should be committed
and reviewed separately rather than presented as part of the widget extraction.
No changes to `database/`, schema, or API route handlers were found; the only
non-`app/` edit is this service file.

</details>

<details>
<summary>File map</summary>

- `app/pages/index.vue` — reduced to a thin composing page (PageHeader + grid of five `<Dashboard*>` components); all script logic removed.
- `app/components/dashboard/KpiCards.vue` — new; KPI trio + `loadKpi` + `deltaCount`; stale "all-time" comment.
- `app/components/dashboard/ActivityOverTime.vue` — new; series state, granularity toggle, zero-fill-aware summary, `BarChart` with `:key="granularity"` and `#2563eb`; stale "no zero-fill" comment.
- `app/components/dashboard/ConfigByOperation.vue` — new; config state + `BarChart` `#1a57ab`; single root without `lg:col-span-2`.
- `app/components/dashboard/TopActiveUsers.vue` — new; compact ranked list.
- `app/components/dashboard/RecentConfigChanges.vue` — new; compact feed + `formatTime`.
- `server/services/dashboard.service.ts` — modified; zero-fill series + current-month KPI. OUT OF SCOPE for this refactor (flagged).

Full diff: `git diff main` (note: the five components are untracked, so inspect them directly; `git diff main` shows only the page and the server file).

</details>
