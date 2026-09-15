# UI / Frontend Conventions

These rules keep every page and component visually and structurally consistent.
Apply them to ALL new frontend and design work. Match the existing patterns —
do not introduce a different styling approach, component set, or token scheme.

## Stack (do not change)

- Nuxt 4 + Vue 3 `<script setup lang="ts">` SFCs.
- Nuxt UI components (`UInput`, `UButton`, `UModal`, etc.) + Tailwind CSS v4.
- Icons: Lucide via `i-lucide-*` (e.g. `i-lucide-eye`).

## Design tokens (single source of truth)

Defined in `app/assets/css/tailwind.css` under `@theme`. Always style with these
token-backed utility classes — never hard-code hex values in components:

- `bg-surface` `#f5f7fa` — page background
- `bg-panel` `#ffffff` — cards, header, inputs
- `border-line` / `ring-line` `#dee3eb` — borders
- `text-ink` `#1a212e` — headings / body
- `text-muted` `#6e788a` — secondary text
- `bg-brand` / `text-brand` `#1a57ab` — primary blue
- `bg-sidebar` `#1a212e` — dark sidebar
- `text-ok` `#1f8c52` (success) · `text-bad` `#b22e2e` (danger)
- Font: Inter (`--font-sans`), already global.

Type scale from Figma: page title 34/600, section title 28/600, body 16/400,
helper 13/400, field label 11/600, small note 11/400.

## Inputs (must render on white)

Nuxt UI's default input can render dark depending on color mode. Always force the
light NetOps look explicitly:

```vue
<UInput
  color="neutral"
  variant="outline"
  :ui="{ base: 'bg-panel text-ink ring-line placeholder:text-muted' }"
/>
```

- Password fields get a show/hide eye toggle in the `#trailing` slot using
  `i-lucide-eye` / `i-lucide-eye-off`, `tabindex="-1"`, and an `aria-label`.

## Buttons

- Primary action: brand blue with white label.
  ```vue
  <UButton color="primary" class="bg-brand text-white hover:bg-brand/90"
           :ui="{ label: 'text-white' }" />
  ```
- Always give icon-only buttons an `aria-label`.

## Layout

- Pages that live behind auth use the `default` layout (sidebar + header).
- Auth/pre-auth pages (`login`, `mfa/*`) use the `auth` layout and set
  `definePageMeta({ layout: 'auth' })`.
- Auth screens: branding + a `max-w-[400px]` white card (`rounded-2xl`,
  `border border-line`), centered on the page with flor `items-center`.
- Prefer flex/grid centering over absolute positioning; keep it responsive
  (`lg:` breakpoints), even though Figma specs use absolute coordinates.

## Forms & accessibility

- Wrap every field in the shared `FormField` component (label + error slot).
  Do NOT restyle `FormField` for a single page — it is shared across all forms.
- Validation messages use `text-bad` and `role="alert"`.
- Loading / empty / error states use the shared `LoadingState` / `EmptyState` /
  `ErrorState` components.

## Reuse first

- Reuse existing components in `app/components/` before creating new ones.
- Keep still-mock feature pages (ACL, Routes, Administration, Logs) as they are
  until their backend phase; only protect them with auth.
