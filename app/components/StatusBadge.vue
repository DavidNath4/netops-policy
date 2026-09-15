<script setup lang="ts">
import type { BadgeProps } from '@nuxt/ui'

const props = defineProps<{
  /** Status value, e.g. ACTIVE, DISABLED, DRAFT. Matched case-insensitively. */
  status: string
}>()

type BadgeColor = BadgeProps['color']

// Maps a status to a badge color: Active -> green, Disabled -> gray, Draft -> amber.
const COLOR_MAP: Record<string, BadgeColor> = {
  ACTIVE: 'success',
  DISABLED: 'neutral',
  DRAFT: 'warning',
}

const normalized = computed(() => (props.status ?? '').trim().toUpperCase())
const color = computed<BadgeColor>(() => COLOR_MAP[normalized.value] ?? 'neutral')
const label = computed(() => {
  const s = normalized.value
  return s ? s.charAt(0) + s.slice(1).toLowerCase() : props.status
})
</script>

<template>
  <UBadge :color="color" variant="soft" :label="label" />
</template>
