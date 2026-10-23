// Autofill the per-form device credential inputs (execUsername/execPassword)
// from the GLOBAL Device Session Credentials set in the head bar.
//
// The ACL Add / Bulk Add / Delete forms still POST execUsername/execPassword in
// their body (the server uses them as the acting engineer for the pre-check and
// n8n call). Rather than retype them, this fills those fields from the global
// credentials via the owner-only `reveal` endpoint. The fields stay editable —
// autofill only seeds them.
//
// Behavior:
// - Fills once on mount when global creds are set (and valid/non-expired).
// - Re-fills whenever the global creds change (e.g. the engineer updates them in
//   the head bar) and the form fields are still empty, so a fresh set flows in
//   without clobbering anything the user has typed.

interface CredTarget {
  execUsername: string
  execPassword: string
}

/**
 * @param target reactive object holding `execUsername` / `execPassword` (e.g. a
 *   `reactive(form)` or a single bulk-batch creds object). Mutated in place.
 */
export function useAutofillDeviceCreds(target: CredTarget) {
  const { isSet, isExpired, status, ensureLoaded, reveal } = useDeviceCredentials()

  async function fill(force = false) {
    if (!isSet.value || isExpired.value) return
    // Don't clobber values the user already typed unless forced.
    if (!force && (target.execUsername.trim() !== '' || target.execPassword !== '')) return
    try {
      const { username, password } = await reveal()
      target.execUsername = username
      target.execPassword = password
    }
    catch {
      // Reveal can fail if creds expired between the status check and now; leave
      // the fields empty so the user sets them (the head bar re-prompts).
    }
  }

  onMounted(async () => {
    await ensureLoaded()
    await fill()
  })

  // A global credential change (new username) re-seeds empty fields.
  watch(() => status.value.username, () => { void fill() })

  return { fill }
}
