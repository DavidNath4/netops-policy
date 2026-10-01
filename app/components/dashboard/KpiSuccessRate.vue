<script setup lang="ts">
// KPI widget — Success Rate This Month. SUCCESS / total × 100 for the current
// calendar month. Higher is better, so the delta (in percentage points) DOES
// carry semantic color: green up, red down, neutral when unchanged.

const props = defineProps<{
  value: number
  delta: number
}>()

const deltaLabel = computed(() => {
  const arrow = props.delta > 0 ? '▲' : props.delta < 0 ? '▼' : '•'
  return `${arrow} ${Math.abs(props.delta)}pp`
})

const tone = computed<'positive' | 'negative' | 'neutral'>(() =>
  props.delta > 0 ? 'positive' : props.delta < 0 ? 'negative' : 'neutral',
)
</script>

<template>
  <DashboardKpiStatCard
    label="Success Rate This Month"
    :value="`${value}%`"
    :delta="deltaLabel"
    :tone="tone"
    icon="i-lucide-circle-check-big"
  />
</template>
