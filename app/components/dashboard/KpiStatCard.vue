<script setup lang="ts">
// Presentational KPI stat card used by the three current-month KPI widgets.
// It renders only — the parent supplies the already-formatted number, delta
// label, delta tone (color), icon, and card label. No data fetching here.

withDefaults(defineProps<{
  /** Card label, e.g. "Activity This Month". */
  label: string
  /** Pre-formatted main value, e.g. "78" or "94%". */
  value: string
  /** Pre-formatted delta label, e.g. "+63" or "▲ 5pp". */
  delta: string
  /**
   * Semantic tone for the delta pill:
   * - 'neutral' — volume metric (more/less isn't inherently good or bad)
   * - 'positive' / 'negative' — only when the direction is meaningful (success rate)
   */
  tone?: 'neutral' | 'positive' | 'negative'
  /** Lucide icon name for the accent badge. */
  icon: string
}>(), {
  tone: 'neutral',
})
</script>

<template>
  <div
    class="group rounded-xl border border-line bg-panel p-5 transition-all duration-200 hover:shadow-sm"
  >
    <div class="flex items-start justify-between gap-4">
      <div>
        <p class="text-xs font-medium text-muted">{{ label }}</p>
        <p class="mt-2 text-[30px] font-semibold leading-none tracking-tight text-ink">
          {{ value }}
        </p>
      </div>
      <div class="flex h-9 w-9 items-center justify-center rounded-lg bg-brand/10 text-brand">
        <UIcon :name="icon" class="h-4.5 w-4.5" />
      </div>
    </div>
    <div class="mt-3 flex items-center gap-1.5">
      <span
        class="rounded-full px-2 py-0.5 text-[11px] font-medium"
        :class="tone === 'positive'
          ? 'bg-ok/10 text-ok'
          : tone === 'negative'
            ? 'bg-bad/10 text-bad'
            : 'bg-surface text-muted'"
      >
        {{ delta }}
      </span>
      <span class="text-[11px] text-muted">vs last month</span>
    </div>
  </div>
</template>
