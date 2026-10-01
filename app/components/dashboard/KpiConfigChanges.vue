<script setup lang="ts">
// KPI widget — Config Changes This Month. Real device-policy mutations
// (ACL/ROUTE ADD/DELETE) recorded this month. Delta vs last month is NEUTRAL
// (more or fewer changes isn't inherently good or bad), so no semantic color.

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
    label="Config Changes This Month"
    :value="value.toLocaleString()"
    :delta="deltaLabel"
    tone="neutral"
    icon="i-lucide-settings-2"
  />
</template>
