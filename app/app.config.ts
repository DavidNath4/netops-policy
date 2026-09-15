// Global Nuxt UI defaults for the NetOps look.
//
// Every solid button (the primary action buttons across the app: Add User,
// Create User, Save, Login, Verify, …) uses the brand blue background with
// white label/icon — set once here instead of per button, so we never get a
// dark/black default button again.
export default defineAppConfig({
  ui: {
    button: {
      variants: {
        variant: {
          solid: 'bg-brand text-white hover:bg-brand/90 disabled:bg-brand/60',
        },
      },
    },
  },
})
