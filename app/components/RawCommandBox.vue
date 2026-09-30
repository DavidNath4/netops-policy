<script setup lang="ts">
// Terminal-style box showing a raw command with a Copy button. Meant to live
// OUTSIDE/above the results table so it's visible without scrolling.
const props = defineProps<{
  /** The raw command text; when null the box renders nothing. */
  command: string | null
  title?: string
}>()

const copied = ref(false)

// Reset the "Copied" state whenever the command changes.
watch(() => props.command, () => { copied.value = false })

async function copy() {
  if (!props.command) return
  try {
    await navigator.clipboard.writeText(props.command)
    copied.value = true
    setTimeout(() => { copied.value = false }, 1500)
  }
  catch {
    // Clipboard unavailable (non-secure context); ignore.
  }
}
</script>

<template>
  <div v-if="command" class="flex flex-col gap-2">
    <div class="flex items-center justify-between">
      <h3 class="text-[13px] font-semibold text-ink">{{ title ?? 'Raw Command' }}</h3>
    </div>
    <div class="relative rounded-lg bg-terminal p-4 font-mono text-xs leading-relaxed">
        <button
          type="button"
          class="absolute top-3 right-3 inline-flex items-center gap-1.5 rounded-[5px] border border-line bg-panel px-3 py-1 text-[11px] font-semibold text-ink transition-colors hover:bg-surface"
          @click="copy"
        >
          <UIcon :name="copied ? 'i-lucide-check' : 'i-lucide-copy'" class="size-3.5" :class="copied ? 'text-ok' : ''" />
          {{ copied ? 'Copied' : 'Copy' }}
        </button>
      <pre class="whitespace-pre-wrap break-all text-terminal-text">{{ command }}</pre>
    </div>
  </div>
</template>
