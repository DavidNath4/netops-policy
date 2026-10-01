<script setup lang="ts">
// KPI widget — Activity This Month. Volume signal: activity rows recorded in
// the current calendar month. Delta vs last month is NEUTRAL (more or less
// activity isn't inherently good or bad), so no success/error color.

const props = defineProps<{
  value: number
  delta: number
}>()

/** Signed count label, e.g. "+3", "−2", "0". */
const deltaLabel = computed(() => {
  const n = props.delta
  if (n > 0) return `+${n}`
  if (n < 0) return `−${Math.abs(n)}`
  return '0'
})
</script>

<template>
  <DashboardKpiStatCard
    label="Activity This Month"
    :value="value.toLocaleString()"
    :delta="deltaLabel"
    tone="neutral"
    icon="i-lucide-activity"
  />
</template>
