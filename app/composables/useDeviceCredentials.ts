// Global Device Session Credentials state.
//
// The engineer enters their device user/password ONCE (globally, from the head
// bar) per session window; the server holds them encrypted on the session row
// with a TTL (DEVICE_CRED_TTL_MINUTES) and auto-fills them for every device
// call. This composable is the single shared source of truth for every page and
// the head bar: the set status, the username, the expiry countdown, and the
// expired flag that drives the re-prompt.
//
// Shared singleton state (module scope) so the head bar and all pages observe
// the same status and the same countdown.

interface DeviceCredStatus {
  set: boolean
  username?: string
  expiresAt?: string
}

const status = ref<DeviceCredStatus>({ set: false })
const loaded = ref(false)
const pending = ref(false)

// `nowTs` ticks every second so the countdown is reactive. A single interval is
// started on first use (client only) and never torn down for the app's life.
const nowTs = ref(Date.now())
let ticking = false
function startTicking() {
  if (ticking || import.meta.server) return
  ticking = true
  setInterval(() => { nowTs.value = Date.now() }, 1000)
}

export function useDeviceCredentials() {
  const api = useApi()
  startTicking()

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

  /** Milliseconds left until the credentials expire, or 0 when unset/expired. */
  const msRemaining = computed(() => {
    if (!status.value.set || !status.value.expiresAt) return 0
    const diff = new Date(status.value.expiresAt).getTime() - nowTs.value
    return diff > 0 ? diff : 0
  })

  /**
   * True when credentials are set AND have time left — the only state the head
   * bar treats as "ready" (shows the username + countdown). Anything else
   * (unset, OR set without an expiry from a legacy session, OR elapsed) falls
   * back to the "Set credentials" prompt so the engineer re-sets them.
   */
  const isActive = computed(() => status.value.set && !!status.value.expiresAt && msRemaining.value > 0)

  /**
   * True once a SET credential with a known expiry has elapsed (client clock).
   * Drives the auto re-prompt. A legacy credential with no expiry is NOT counted
   * as "just expired" (it never had a countdown), so it won't trigger the
   * one-shot re-prompt watcher — the amber chip already invites a re-set.
   */
  const isExpired = computed(() => status.value.set && !!status.value.expiresAt && msRemaining.value <= 0)

  /** "MM:SS" countdown for the head bar (empty when not active). */
  const countdown = computed(() => {
    if (!isActive.value) return ''
    const total = Math.floor(msRemaining.value / 1000)
    const m = Math.floor(total / 60)
    const s = total % 60
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  })

  return {
    status,
    isSet,
    isActive,
    loaded,
    pending,
    msRemaining,
    isExpired,
    countdown,
    refresh,
    ensureLoaded,
    set,
    clear,
    reveal,
  }
}
