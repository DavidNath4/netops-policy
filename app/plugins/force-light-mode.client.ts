// Force light mode across the whole app.
//
// The NetOps design is light-theme only. Nuxt UI resolves component colors from
// the color mode, and @nuxtjs/color-mode persists a stored value in
// localStorage that can win over the nuxt.config `preference`. This plugin pins
// the mode to `light` on every client load so components (USelect, UInput,
// UModal, UDropdownMenu, tables, …) never render dark based on a stale stored
// value or the OS preference.
export default defineNuxtPlugin(() => {
  const colorMode = useColorMode()
  // `preference` is the writable setting; `value` is derived/read-only. Setting
  // the preference to 'light' is enough to pin the mode on every client load.
  colorMode.preference = 'light'
})
