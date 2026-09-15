<script setup lang="ts">
// Notifications modal opened from the header bell.
//
// Dummy data for now — the notifications feature is out of scope for the current
// phase. The shape is kept realistic so it can later be swapped for a real feed.

const props = defineProps<{ open: boolean, count?: number }>()
const emit = defineEmits<{ 'update:open': [value: boolean] }>()

// Writable proxy so <UModal v-model:open> can read the prop and emit updates,
// with the parent (header) owning the source of truth via v-model:open.
const open = computed({
  get: () => props.open,
  set: value => emit('update:open', value),
})

interface DummyNotification {
  id: string
  title: string
  body: string
  time: string
  icon: string
  unread: boolean
}

const notifications: DummyNotification[] = [
  {
    id: 'n1',
    title: 'New ACL policy created',
    body: 'Policy "web-dmz-inbound" was added by admin.',
    time: '2m ago',
    icon: 'i-lucide-shield-plus',
    unread: true,
  },
  {
    id: 'n2',
    title: 'Route updated',
    body: 'Static route 10.20.0.0/16 next-hop changed.',
    time: '1h ago',
    icon: 'i-lucide-route',
    unread: true,
  },
  {
    id: 'n3',
    title: 'New sign-in',
    body: 'Your account signed in from a new session.',
    time: 'Yesterday',
    icon: 'i-lucide-log-in',
    unread: true,
  },
  {
    id: 'n4',
    title: 'MFA enabled',
    body: 'Two-factor authentication was turned on.',
    time: '3d ago',
    icon: 'i-lucide-shield-check',
    unread: false,
  },
]
</script>

<template>
  <UModal
    v-model:open="open"
    title="Notifications"
    :ui="{
      content: 'bg-white text-ink ring-1 ring-line divide-y divide-line',
      header: 'text-ink',
      title: 'text-ink',
      body: 'bg-white',
      footer: 'bg-white',
    }"
  >
    <template #body>
      <ul class="flex flex-col gap-2">
        <li
          v-for="n in notifications"
          :key="n.id"
          class="flex gap-3 rounded-xl border border-line bg-surface px-3 py-3"
        >
          <div class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand/10 text-brand">
            <UIcon :name="n.icon" class="text-base" />
          </div>
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2">
              <p class="truncate text-sm font-semibold text-ink">{{ n.title }}</p>
              <span v-if="n.unread" class="h-2 w-2 shrink-0 rounded-full bg-brand" aria-label="Unread" />
            </div>
            <p class="mt-0.5 text-[13px] text-muted">{{ n.body }}</p>
            <p class="mt-1 text-[11px] text-muted">{{ n.time }}</p>
          </div>
        </li>
      </ul>
    </template>

    <template #footer>
      <div class="flex w-full items-center justify-between">
        <span class="text-[11px] text-muted">Showing recent activity</span>
        <UButton
          color="neutral"
          variant="ghost"
          label="Close"
          class="font-semibold text-brand hover:bg-brand/10"
          @click="open = false"
        />
      </div>
    </template>
  </UModal>
</template>
