<script setup lang="ts">
// (4) Top Active Users — compact list ranked by activity count only.

interface TopUser {
  username: string
  count: number
}

const { dashboard } = useApi()

const usersData = ref<TopUser[] | null>(null)
const usersPending = ref(true)
const usersError = ref(false)

async function loadUsers() {
  usersPending.value = true
  usersError.value = false
  try {
    usersData.value = (await dashboard.topUsers()).items
  }
  catch {
    usersError.value = true
  }
  finally {
    usersPending.value = false
  }
}

onMounted(() => loadUsers())
</script>

<template>
  <div class="rounded-lg border border-line bg-panel">
    <div class="border-b border-line px-4 py-3">
      <h2 class="text-sm font-semibold text-ink">Top Active Users</h2>
    </div>

    <div v-if="usersPending" class="p-4">
      <LoadingState message="Loading users…" />
    </div>

    <div v-else-if="usersError" class="p-4">
      <ErrorState
        message="Could not load top active users."
        @retry="loadUsers"
      />
    </div>

    <EmptyState
      v-else-if="(usersData ?? []).length === 0"
      title="No activity yet"
      description="The most active users will be ranked here."
      icon="i-lucide-users"
    />

    <ul v-else class="divide-y divide-line">
      <li
        v-for="(user, index) in usersData ?? []"
        :key="`${user.username}-${index}`"
        class="flex items-center justify-between gap-3 px-4 py-2"
      >
        <div class="flex min-w-0 items-center gap-2">
          <span class="shrink-0 text-[11px] tabular-nums text-muted">#{{ index + 1 }}</span>
          <span class="truncate text-[13px] font-medium text-ink">{{ user.username }}</span>
        </div>
        <span class="shrink-0 text-[13px] tabular-nums text-muted">{{ user.count }}  Activities</span>
      </li>
    </ul>
  </div>
</template>
