<script setup lang="ts">
// Level 1 — current-month KPI snapshot. This thin container fetches the single
// /api/dashboard/kpi endpoint ONCE (it returns all three values together) and
// hands each value to its own presentational widget. The three cards are
// separate widgets visually, but share this one request — no redundant fetches.

interface KpiDelta {
  value: number
  delta: number
}
interface Kpi {
  totalActivity: KpiDelta
  configChanges: KpiDelta
  successRate: KpiDelta
}

const { dashboard } = useApi()

const kpiData = ref<Kpi | null>(null)
const kpiPending = ref(true)
const kpiError = ref(false)

async function loadKpi() {
  kpiPending.value = true
  kpiError.value = false
  try {
    kpiData.value = await dashboard.kpi()
  }
  catch {
    kpiError.value = true
  }
  finally {
    kpiPending.value = false
  }
}

onMounted(() => loadKpi())
</script>

<template>
  <div>
    <LoadingState v-if="kpiPending" message="Loading KPIs…" />

    <ErrorState
      v-else-if="kpiError"
      message="Could not load the KPIs."
      @retry="loadKpi"
    />

    <div v-else-if="kpiData" class="grid grid-cols-1 gap-4 sm:grid-cols-3">
      <DashboardKpiActivity
        :value="kpiData.totalActivity.value"
        :delta="kpiData.totalActivity.delta"
      />
      <DashboardKpiConfigChanges
        :value="kpiData.configChanges.value"
        :delta="kpiData.configChanges.delta"
      />
      <DashboardKpiSuccessRate
        :value="kpiData.successRate.value"
        :delta="kpiData.successRate.delta"
      />
    </div>
  </div>
</template>
