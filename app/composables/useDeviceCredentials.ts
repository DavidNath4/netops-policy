// Device Session Credentials state for the ACL/Route search pages.
//
// The engineer enters their device user/password once per session; the server
// holds them encrypted on the session row (30-min TTL) and auto-fills them for
// searches. This composable tracks the "set" status and exposes set/clear/reveal.
// Shared singleton state so every page sees the same status.

interface DeviceCredStatus {
  set: boolean
  username?: string
}

const status = ref<DeviceCredStatus>({ set: false })
const loaded = ref(false)
const pending = ref(false)

export function useDeviceCredentials() {
  const api = useApi()

  /** Load the current status once (cached for the session). */
  async function refresh(): Promise<void> {
    pending.value = true
    try {
      status.value = await api.deviceCredentials.status()
    }
    finally {
      loaded.value = true
      pending.value = false
    }
  }

  async function ensureLoaded(): Promise<void> {
    if (!loaded.value) await refresh()
  }

  async function set(username: string, password: string): Promise<void> {
    await api.deviceCredentials.set({ username, password })
    await refresh()
  }

  async function clear(): Promise<void> {
    await api.deviceCredentials.clear()
    status.value = { set: false }
  }

  function reveal(): Promise<{ username: string, password: string }> {
    return api.deviceCredentials.reveal()
  }

  const isSet = computed(() => status.value.set)

  return { status, isSet, loaded, pending, refresh, ensureLoaded, set, clear, reveal }
}
