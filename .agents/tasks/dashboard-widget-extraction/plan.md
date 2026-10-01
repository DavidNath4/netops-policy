# Implementation Plan — Dashboard Widget Component Extraction

Pure FRONTEND component-extraction refactor. Pull the five dashboard widgets
out of `app/pages/index.vue` into their own SFCs under
`app/components/dashboard/`, keeping behavior, markup, tokens, chart colors, and
per-widget async semantics EXACTLY as they are today. No `server/`, `database/`,
API, or data-shape changes.

## Context discovered during exploration (ground truth)

- `app/pages/index.vue` holds, in `<script setup lang="ts">`: 7 local interfaces
  (`KpiDelta`, `Kpi`, `SeriesPoint`, `ActivitySeries`, `ConfigByOperation`,
  `TopUser`, `RecentConfigChange`), `const { dashboard } = useApi()`, five
  independent `*/Pending/Error` ref trios + `load*` functions, a single
  `onMounted` that fires all five loads in parallel, and widget-specific helpers.
- Auto-imports are active (Nuxt 4 + modules): `ref`, `computed`, `onMounted`,
  `useApi`, the shared `LoadingState`/`ErrorState`/`EmptyState`/`PageHeader`
  components, `UIcon`, `ClientOnly`, and `BarChart` (from the registered
  `nuxt-charts` module in `nuxt.config.ts`) all resolve WITHOUT imports inside
  any SFC. New widget SFCs need NO `import` statements — match `AppSidebar.vue`,
  which imports nothing.
- Component auto-import names are PascalCase of the path under `components/`:
  `components/layout/AppSidebar.vue` → `<LayoutAppSidebar>`. Therefore
  `components/dashboard/KpiCards.vue` → `<DashboardKpiCards>`, etc.
- `useApi().dashboard` methods and their payloads (UNWRAPPED envelope):
  `kpi()` → `Kpi`; `activitySeries()` → `ActivitySeries` (`{ daily, weekly,
  monthly }`); `configByOperation()` / `topUsers()` / `recentConfigChanges()` →
  `{ items: [...] }`. The page currently does `(await dashboard.X()).items` for
  the latter three — preserve that exactly in the moved code.
- Chart series colors are the ONE allowed hard-coded hex exception:
  `#2563eb` (Activity Over Time) and `#1a57ab` (Config by Operation). Preserve
  verbatim.
- `BarChart` for Activity uses `:key="granularity"` — this is the deliberate
  tooltip-remount bug fix (prevents Unovis carrying stale hover state across
  toggle changes). Must be preserved. Neither chart has a custom legend
  (`BarChart` renders its own); do not add one.
- The three-widget row is `<div class="grid grid-cols-1 gap-6 lg:grid-cols-4">`
  with Config by Operation at `lg:col-span-2` and the other two at one column.

## Design decisions

- **State lives inside each widget.** Each widget owns its `data/pending/error`
  refs, its `load*` function, its own `onMounted(() => loadX())`, and its own
  helpers/computeds. Rationale: the task requires "no per-widget fetching logic
  left in the page," and because each widget calls its endpoint in its own
  `onMounted`, the five still fire in parallel on page mount exactly as the
  single combined `onMounted` does today. Per-widget retry stays local (the
  `@retry` already points at the same `load*` now moving into the widget).
- **Interfaces move WITH their widget**, not into a shared file. Rationale:
  minimal, scoped change; `useApi.ts` already declares its own private copies, so
  no shared type module exists to reuse and creating one is out of scope. Each
  widget declares only the interface(s) it uses.
- **Single root element per widget** so a `class` passed by the page (e.g.
  `lg:col-span-2`) merges onto the root via Vue's fallthrough attributes. KPI
  and Activity wrap their content in the existing single root they already have
  (the `<div>` / `<section>`); the three row widgets each already have a single
  root `<div class="rounded-lg border …">`.
- **No props/emits.** Widgets are self-contained; the page passes nothing except
  the optional `class` on Config by Operation. Rationale: there is no shared data
  to thread, and keeping them prop-free is the smallest faithful extraction.

## Preservation checklist (must hold after refactor)

- [ ] Five independent loads still fire in parallel on mount (one `onMounted`
      per widget).
- [ ] Per-widget `LoadingState` / `ErrorState` (with `@retry` → local `load*`) /
      `EmptyState` branches identical to today.
- [ ] Markup, class strings, tokens, icon names, and copy identical to today.
- [ ] Chart colors `#2563eb` (activity) and `#1a57ab` (config) unchanged.
- [ ] Activity `BarChart` keeps `:key="granularity"`; no custom legend on either
      chart.
- [ ] Top Active Users + Recent Config Changes keep their compact styling
      (`rounded-lg`, `px-4 py-3` header, `text-sm`, `text-[13px]`/`text-[11px]`
      rows); Config by Operation keeps its slightly-larger styling (`px-5 py-3.5`
      header, `text-[15px]`, chart height `220`).
- [ ] Page layout order and grid unchanged: KPI → Activity →
      `grid-cols-1 … lg:grid-cols-4` row with Config (`lg:col-span-2`), Top
      Users, Recent Config Changes.

---

## Steps

- [ ] 1. Create `app/components/dashboard/KpiCards.vue` (`<DashboardKpiCards>`).
      Move into it: the `KpiDelta` + `Kpi` interfaces, `const { dashboard } =
      useApi()`, the `kpiData/kpiPending/kpiError` trio, `loadKpi()`, a
      `onMounted(() => loadKpi())`, the `deltaCount()` helper, and the entire
      KPI template block — the outer `<div>` wrapping the `LoadingState` /
      `ErrorState` (`@retry="loadKpi"`) / `v-else-if="kpiData"` grid of three
      cards. Keep that outer `<div>` as the single root element. No imports.
      Files: app/components/dashboard/KpiCards.vue
      Verify: re-read the file; confirm it is a complete `<script setup lang="ts">`
      + `<template>` SFC with one root `<div>`, the `deltaCount` logic and all
      three card markup blocks byte-for-byte matching the current page (icons
      `i-lucide-activity` / `i-lucide-settings-2` / `i-lucide-circle-check-big`,
      the `successRate.delta` ▲/▼/• color logic, `pp` suffix), and no leftover
      references to other widgets' state.

- [ ] 2. Create `app/components/dashboard/ActivityOverTime.vue`
      (`<DashboardActivityOverTime>`). Move into it: `SeriesPoint` +
      `ActivitySeries` interfaces, `useApi()` destructure, the
      `seriesData/seriesPending/seriesError` trio, `loadSeries()`,
      `onMounted(() => loadSeries())`, the `Granularity` type, `granularity` ref,
      `granularityOptions`, and ALL activity helpers/computeds: `activeSeries`,
      `seriesLabel`, `seriesChartData`, `seriesCategories` (color `#2563eb`),
      `seriesXFormatter`, `activitySummary`, `activityPeriodLabel`,
      `activityPeriodUnit`. Move the entire `<section …>` template block
      (header + granularity toggle + Loading/Error/Empty + the insights row + the
      chart container with the `:key="granularity"` `BarChart`). Keep the
      `<section>` as the single root element. No imports.
      Files: app/components/dashboard/ActivityOverTime.vue
      Verify: re-read the file; confirm single root `<section>`, `BarChart` still
      has `:key="granularity"`, `:radius="7"`, `:height="280"`,
      `color: '#2563eb'`, the `ClientOnly` + `#fallback` LoadingState, the
      granularity `<button>` toggle wired to `granularity = opt.value`, and the
      empty branch keyed on `activitySummary.recordedPeriods === 0`.

- [ ] 3. Create `app/components/dashboard/ConfigByOperation.vue`
      (`<DashboardConfigByOperation>`). Move into it: the `ConfigByOperation`
      interface, `useApi()` destructure, the `configData/configPending/
      configError` trio, `loadConfig()` (preserving `(await
      dashboard.configByOperation()).items`), `onMounted(() => loadConfig())`,
      and the `configChartData` / `configCategories` (color `#1a57ab`) /
      `configXFormatter` helpers. Move the widget's single root `<div class="…
      lg:col-span-2">` template block — BUT remove the `lg:col-span-2` from the
      component's own root; the page will pass it as a `class` so it merges via
      fallthrough. Keep the slightly-larger styling (`px-5 py-3.5` header,
      `text-[15px]`, chart `:height="220"`, `:radius="4"`). No imports.
      Files: app/components/dashboard/ConfigByOperation.vue
      Verify: re-read the file; confirm single root `<div class="rounded-lg
      border border-line bg-panel">` (NO `lg:col-span-2`), the Loading/Error
      (`@retry="loadConfig"`)/Empty branches, and `BarChart` with
      `color: '#1a57ab'`, `:height="220"`, `:radius="4"`, `:x-formatter=
      "configXFormatter"`.

- [ ] 4. Create `app/components/dashboard/TopActiveUsers.vue`
      (`<DashboardTopActiveUsers>`). Move into it: the `TopUser` interface,
      `useApi()` destructure, the `usersData/usersPending/usersError` trio,
      `loadUsers()` (preserving `(await dashboard.topUsers()).items`),
      `onMounted(() => loadUsers())`, and the widget's single root `<div
      class="rounded-lg border border-line bg-panel">` template block (compact
      header `px-4 py-3` / `text-sm`, the ranked `<ul>` with `#{{ index + 1 }}`
      and `text-[13px]` rows, Loading/Error/Empty branches). No imports.
      Files: app/components/dashboard/TopActiveUsers.vue
      Verify: re-read the file; confirm single root `<div>`, compact styling
      intact, `@retry="loadUsers"`, empty branch keyed on
      `(usersData ?? []).length === 0`, and the `:key="`${user.username}-${index}`"`
      list key preserved.

- [ ] 5. Create `app/components/dashboard/RecentConfigChanges.vue`
      (`<DashboardRecentConfigChanges>`). Move into it: the `RecentConfigChange`
      interface, `useApi()` destructure, the `recentData/recentPending/
      recentError` trio, `loadRecent()` (preserving `(await
      dashboard.recentConfigChanges()).items`), `onMounted(() => loadRecent())`,
      the `formatTime()` helper, and the widget's single root `<div class=
      "rounded-lg border border-line bg-panel">` template block (compact header,
      the `<ul>` listing `module / action`, username/time line, and the
      SUCCESS/else `text-ok`/`text-bad` status). No imports.
      Files: app/components/dashboard/RecentConfigChanges.vue
      Verify: re-read the file; confirm single root `<div>`, compact styling,
      `formatTime` using `toLocaleString('en-GB')`, `@retry="loadRecent"`, empty
      branch keyed on `(recentData ?? []).length === 0`, and `:key="change.id"`.

- [ ] 6. Rewrite `app/pages/index.vue` as the thin composing page. The
      `<script setup lang="ts">` keeps ONLY the top doc comment (optional) and
      becomes effectively empty of logic — remove ALL interfaces, the `useApi()`
      call, every `*/Pending/Error` ref, every `load*`, the `onMounted`, and
      every helper/computed (they now live in the widgets). The `<template>`
      becomes the outer `<div class="flex flex-col gap-6">` with: `PageHeader`
      (unchanged), `<DashboardKpiCards />`, `<DashboardActivityOverTime />`, then
      `<div class="grid grid-cols-1 gap-6 lg:grid-cols-4">` containing
      `<DashboardConfigByOperation class="lg:col-span-2" />`,
      `<DashboardTopActiveUsers />`, `<DashboardRecentConfigChanges />`. Preserve
      the layout comments if desired.
      Files: app/pages/index.vue
      Verify: re-read the file; confirm no interfaces/`load*`/refs/`onMounted`/
      helpers remain in `<script setup>`, the template order and grid classes
      match the preservation checklist exactly, and the four widget tags plus
      `PageHeader` are the only children of the root `<div>`.

- [ ] 7. Cross-check parity between the new widgets and the pre-refactor page.
      Re-read all five new SFCs and the rewritten `index.vue` together and walk
      the preservation checklist above item by item: parallel loads (five
      `onMounted`), per-widget retry wiring, identical markup/tokens/copy, chart
      colors `#2563eb`/`#1a57ab`, Activity `:key="granularity"`, no custom
      legends, compact vs. slightly-larger styling, and layout order. Fix any
      drift found.
      Files: app/pages/index.vue, app/components/dashboard/*.vue
      Verify: every preservation-checklist box can be ticked by reading the
      files; no widget references another widget's state; no `import` statements
      were added; no hard-coded hex other than the two chart colors.

## Notes / assumptions

- CLI is intentionally not run (constraint). Verification is by re-reading files
  against the preservation checklist, since this is a mechanical move of code
  whose runtime behavior is unchanged.
- The doc comment at the top of `index.vue` describes all five widgets; it may be
  trimmed to the page-composition role or left as-is. Either is acceptable — it
  is a comment and does not affect behavior. Keeping a short version is suggested.
