// Small countdown helper for pre-auth MFA pages.
//
// Given a server-authoritative expiry (epoch ms), it exposes the remaining time
// as reactive seconds + an "MM:SS" label and flips `expired` to true when the
// deadline passes. The interval is cleaned up automatically on unmount.

export function useCountdown(expiresAt: Ref<number | null>) {
  const now = ref(Date.now())
  let timer: ReturnType<typeof setInterval> | undefined

  function tick() {
    now.value = Date.now()
  }

  onMounted(() => {
    tick()
    timer = setInterval(tick, 1000)
  })

  onUnmounted(() => {
    if (timer) clearInterval(timer)
  })

  const remainingMs = computed(() => {
    if (expiresAt.value === null) return 0
    return Math.max(0, expiresAt.value - now.value)
  })

  const remainingSeconds = computed(() => Math.ceil(remainingMs.value / 1000))

  const expired = computed(() => expiresAt.value !== null && remainingMs.value <= 0)

  const label = computed(() => {
    const total = remainingSeconds.value
    const m = Math.floor(total / 60)
    const s = total % 60
    return `${m}:${s.toString().padStart(2, '0')}`
  })

  return { remainingSeconds, remainingMs, expired, label }
}
