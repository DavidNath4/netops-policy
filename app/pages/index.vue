<script setup lang="ts">
// Dashboard (default layout). A BI overview derived entirely from audit_logs
// (this app is the audit system of record, not the source of truth for ACL/route
// counts). Five approved widgets, each extracted into its own SFC under
// app/components/dashboard/ and each backed by its OWN endpoint so they load in
// parallel and show their own loading/error/empty state:
//   1) KPI row — Activity, Config Changes, Success Rate (each "vs last month")
//   2) Activity Over Time — bar chart with a Daily/Weekly/Monthly toggle
//   3) Config Changes by Operation — ROUTE/ADD, ROUTE/DELETE, ACL/ADD, ACL/DELETE
//   4) Top Active Users — ranked by activity count only
//   5) Recent Config Changes — newest config mutations with inline status
</script>

<template>
  <div class="flex flex-col gap-6">
    <PageHeader title="Dashboard" description="Activity and configuration overview." />

    <!-- (1) Current-month KPI snapshot — Level 1 "what is happening now".
         Three separate KPI widgets; KpiRow fetches /api/dashboard/kpi once and
         distributes each value. -->
    <DashboardKpiRow />

    <!-- (2) Activity Over Time — Level 2 trend -->
    <DashboardActivityOverTime />

    <!-- Level 3 — drivers: three widgets on one row. Config Changes by
         Operation gets more room (col-span-2); Top Users and Recent Config
         Changes are compact (one column each). -->
    <div class="grid grid-cols-1 gap-6 lg:grid-cols-4">
      <DashboardConfigByOperation class="lg:col-span-2" />
      <DashboardTopActiveUsers />
      <DashboardRecentConfigChanges />
    </div>
  </div>
</template>
