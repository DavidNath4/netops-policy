# BI Dashboard — nuxt-charts Verification Note

Scope: swap the two hand-built div/SVG bar charts on the dashboard for real
`nuxt-charts` (Vue Chrts / Unovis) `<BarChart>` components. Exactly three files
changed; no commands were run (user installs/typechecks/lints/runs).

## Files changed

- `package.json` — added `"nuxt-charts": "^2.2.3"` to `dependencies`, placed
  alphabetically between `nuxt` and `otplib`. JSON kept valid. 2.2.3 is the
  current `latest` on npm (verified via the npm registry).
- `nuxt.config.ts` — appended `'nuxt-charts'` to the existing `modules` array
  (`@nuxt/ui`, `@nuxt/eslint` left intact) and added
  `nuxtCharts: { include: ['BarChart'] }` to trim the bundle to just the chart
  the dashboard uses. No other config touched.
- `app/pages/index.vue` — replaced ONLY the chart rendering of two widgets:
  - **Activity Over Time**: the manual `flex` div-bar block is now a
    `<ClientOnly>`-wrapped `<BarChart>`. Daily/Weekly/Monthly toggle preserved;
    it still switches the pre-fetched series client-side (no refetch). New
    computed `seriesChartData` maps the active series to
    `{ label: seriesLabel(bucket), count }` rows, `seriesCategories =
    { count: { name: 'Activity', color: '#1a57ab' } }`, and
    `seriesXFormatter = (i) => seriesChartData[i].label` (index-based, per the
    library's `xFormatter(i)` contract). `seriesLabel()` logic reused verbatim.
  - **Config Changes by Operation**: the manual horizontal div bars are now a
    `<ClientOnly>`-wrapped `<BarChart>` over `configChartData`
    (`{ operation, count }` rows), `configCategories =
    { count: { name: 'Config changes', color: '#1a57ab' } }`, and
    `configXFormatter = (i) => configChartData[i].operation` (e.g. 'ROUTE/ADD').

## Why this is a from-scratch nuxt-charts pass

`review.json` was `APPROVED` with zero findings, but that verdict covers the
PRIOR div-bar implementation (the earlier verification note and review.md both
describe hand-built bars and explicitly say "no charting library"). The actual
nuxt-charts task had not been done, so this iteration implements it. No findings
to fix; nothing user-visible was redesigned beyond the approved chart swap.

## Library API used (confirmed against official docs + README)

- `nuxt-charts` auto-imports `<BarChart>` in a Nuxt app (no manual import).
- Props used: `:data` (row objects), `:categories`
  (`{ key: { name, color } }`), `:height` (260), `:x-formatter` (index → label),
  `:radius` (4, rounded top corners). Matches the author's README usage example
  (`:data` / `:categories` / `:height` / `:xFormatter = (i) => data[i].month`).
- Series color is the brand hex `#1a57ab`, confirmed from
  `app/assets/css/tailwind.css` (`--color-brand: #1a57ab`). No invented colors.

## What I verified by re-reading (could not run commands)

- **package.json**: valid JSON, `nuxt-charts` present in `dependencies` with a
  caret range, ordering consistent with neighbors.
- **nuxt.config.ts**: `modules` now `['@nuxt/ui', '@nuxt/eslint', 'nuxt-charts']`
  (existing two intact); `nuxtCharts.include: ['BarChart']` added; rest of the
  config (srcDir, css, fonts, colorMode, typescript, vite, devtools) unchanged.
- **index.vue**:
  - Both widgets render `<BarChart>` inside `<ClientOnly>` with a
    `LoadingState` fallback (SSR-safe; Unovis is browser-only).
  - `:data`/`:categories`/`:x-formatter` wired to the new computeds; brand color
    `#1a57ab` in both category maps.
  - Daily/Weekly/Monthly toggle untouched → `activeSeries` → `seriesChartData`
    is reactive, so switching granularity re-feeds the chart with NO refetch.
  - Each widget keeps its own `pending`/`error`/empty handling:
    LoadingState / ErrorState(+retry) / EmptyState. Activity's EmptyState fires
    when `activeSeries.length === 0`; Config's EmptyState fires when
    `configChartData.length === 0`.
  - Removed now-dead helpers (`maxSeriesCount`, `barHeight`, `maxConfigOp`,
    `configBarWidth`) — no dangling references remain.
  - KPI row (3 cards + deltas), Top Active Users (ranked list), and Recent
    Config Changes (feed with inline SUCCESS/FAILED) are byte-for-byte unchanged.
  - Data fetching (`useApi` dashboard.* calls, the five load* functions,
    onMounted parallel kickoff) unchanged.
  - Card chrome (`rounded-lg border border-line bg-panel`, header rows, `p-5`
    body) unchanged; copy is English.
- **Sparse data**: Activity Over Time renders with only 2 non-zero daily points
  (2026-09-25, 2026-10-01) — BarChart handles a 2-row dataset fine; expected to
  show 2 bars with current dev data.

## Commands the user must run (in order)

1. `npm install`        — fetch the new `nuxt-charts` dependency.
2. `npm run typecheck`
3. `npm run lint`
4. `npm run dev` → open `/` — Activity Over Time and Config Changes by Operation
   now render as nuxt-charts bar charts; the Daily/Weekly/Monthly toggle swaps
   the series instantly. With current dev data the activity chart shows ~2 bars
   (expected). The other three widgets are unchanged.
