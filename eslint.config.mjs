// @ts-check
import withNuxt from './.nuxt/eslint.config.mjs'

export default withNuxt(
  {
    // `Pagination` is a deliberate domain component name that wraps UPagination.
    files: ['app/components/Pagination.vue'],
    rules: {
      'vue/multi-word-component-names': 'off',
    },
  },
)
