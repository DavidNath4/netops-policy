// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2024-11-01',

  // Application (client + universal) code lives under app/ (design: srcDir 'app').
  srcDir: 'app',

  modules: [
    '@nuxt/ui',
    '@nuxt/eslint',
  ],

  // Tailwind v4 + Nuxt UI entry; also defines the NetOps design tokens (@theme).
  css: ['~/assets/css/tailwind.css'],

  // Inter is the design font used across the Figma file.
  fonts: {
    families: [
      { name: 'Inter', provider: 'google', weights: [400, 500, 600, 700] },
    ],
  },

  // The NetOps design is a light theme only. Lock the color mode to light so
  // Nuxt UI components (modals, inputs, etc.) never render in dark mode based on
  // the OS/system preference. `storageKey` unused + forced classSuffix keeps it
  // deterministic; we don't offer a dark toggle.
  colorMode: {
    preference: 'light',
    fallback: 'light',
    classSuffix: '',
  },

  typescript: {
    strict: true,
    typeCheck: false, // typecheck runs via the `typecheck` script (nuxt typecheck)
  },

  devtools: { enabled: true },
})
