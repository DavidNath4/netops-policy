<script setup lang="ts">
// Root component: UApp is the Nuxt UI provider (toasts, tooltips, overlays).
// NuxtLayout applies the current page layout (default = app shell with sidebar +
// header; auth = bare for /login). NuxtPage renders the current route.
</script>

<template>
  <UApp>
    <NuxtLayout>
      <NuxtPage />
    </NuxtLayout>
  </UApp>
</template>
