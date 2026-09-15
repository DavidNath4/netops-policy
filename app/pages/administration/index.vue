<script setup lang="ts">
// Administration / User Mapping page — real backend (RBAC-guarded).
//
// Lists users (Email, Name, Role, Status, Action) with loading/empty/error
// states and pagination. Per-row actions open dialogs:
//   - Add User      (email, displayName, password, roleCode) -> users.create
//   - Edit          (displayName)                            -> users.update
//   - Change Role   (roleCode)                               -> users.changeRole
//   - Change Status (enable / disable; confirm on disable)   -> users.setStatus
//   - Reset Password(confirm + new password)                 -> users.resetPassword
// The list reloads after any successful mutation.
//
// One role per user (roleCode/roleName from the roles table); email is the
// identifier; isActive is the status. Every mutating control is gated by
// ADMINISTRATION_MANAGE; the page/list needs ADMINISTRATION_SHOW.
import type { RoleOption, UserResponse } from '~/utils/api-types'

definePageMeta({ middleware: 'permission', permission: 'ADMINISTRATION_SHOW' })

const { users, roles: rolesApi } = useApi()
const { can } = usePermissions()
const toast = useToast()

const canManage = computed(() => can('ADMINISTRATION_MANAGE'))

// ---------------------------------------------------------------------------
// List state + loading
// ---------------------------------------------------------------------------
const ITEMS_PER_PAGE = 20

const rows = ref<UserResponse[]>([])
const total = ref(0)
const page = ref(1)
const pending = ref(true)
const error = ref(false)

async function load() {
  pending.value = true
  error.value = false
  try {
    const res = await users.list({ page: page.value, limit: ITEMS_PER_PAGE })
    rows.value = res.items
    total.value = res.total
  }
  catch {
    error.value = true
  }
  finally {
    pending.value = false
  }
}

onMounted(load)
watch(page, load)

// ---------------------------------------------------------------------------
// Role options (loaded from the server; roles are data, not hardcoded)
// ---------------------------------------------------------------------------
const roleOptions = ref<{ label: string, value: string }[]>([])

async function loadRoles() {
  try {
    const res = await rolesApi.list()
    roleOptions.value = res.roles.map((r: RoleOption) => ({ label: r.roleName, value: r.roleCode }))
  }
  catch {
    roleOptions.value = []
  }
}
onMounted(loadRoles)

const defaultRoleCode = computed(() => roleOptions.value[0]?.value ?? '')

function roleLabel(user: UserResponse): string {
  return user.roleName ?? user.roleCode ?? '—'
}

function statusOf(user: UserResponse): string {
  return user.isActive ? 'ACTIVE' : 'DISABLED'
}

const skeletonRows = computed(() => Array.from({ length: 5 }, (_, i) => i))

// ---------------------------------------------------------------------------
// Add User dialog
// ---------------------------------------------------------------------------
const addOpen = ref(false)
const addSubmitting = ref(false)
const addForm = reactive({
  email: '',
  displayName: '',
  password: '',
  roleCode: '',
})
const addErrors = reactive<Record<string, string>>({})

function openAdd() {
  addForm.email = ''
  addForm.displayName = ''
  addForm.password = ''
  addForm.roleCode = defaultRoleCode.value
  clearErrors(addErrors)
  addOpen.value = true
}

function validateAdd(): boolean {
  clearErrors(addErrors)
  if (!addForm.email.trim()) addErrors.email = 'Email is required.'
  if (!addForm.displayName.trim()) addErrors.displayName = 'Name is required.'
  if (!addForm.password) addErrors.password = 'Password is required.'
  else if (addForm.password.length < 8) addErrors.password = 'Password must be at least 8 characters.'
  if (!addForm.roleCode) addErrors.roleCode = 'Role is required.'
  return Object.keys(addErrors).length === 0
}

async function submitAdd() {
  if (!validateAdd()) return
  addSubmitting.value = true
  try {
    await users.create({
      email: addForm.email.trim(),
      displayName: addForm.displayName.trim(),
      password: addForm.password,
      roleCode: addForm.roleCode,
    })
    addOpen.value = false
    notifySuccess('User created')
    await load()
  }
  catch (err) {
    notifyError(errorMessage(err, 'Could not create the user.'))
  }
  finally {
    addSubmitting.value = false
  }
}

// ---------------------------------------------------------------------------
// Edit (basic info) dialog
// ---------------------------------------------------------------------------
const editOpen = ref(false)
const editSubmitting = ref(false)
const editTarget = ref<UserResponse | null>(null)
const editForm = reactive({ displayName: '' })
const editErrors = reactive<Record<string, string>>({})

function openEdit(user: UserResponse) {
  editTarget.value = user
  editForm.displayName = user.displayName
  clearErrors(editErrors)
  editOpen.value = true
}

async function submitEdit() {
  clearErrors(editErrors)
  if (!editForm.displayName.trim()) {
    editErrors.displayName = 'Name is required.'
    return
  }
  const target = editTarget.value
  if (!target) return
  editSubmitting.value = true
  try {
    await users.update(target.userId, { displayName: editForm.displayName.trim() })
    editOpen.value = false
    notifySuccess('User updated')
    await load()
  }
  catch (err) {
    notifyError(errorMessage(err, 'Could not update the user.'))
  }
  finally {
    editSubmitting.value = false
  }
}

// ---------------------------------------------------------------------------
// Change Role dialog
// ---------------------------------------------------------------------------
const roleOpen = ref(false)
const roleSubmitting = ref(false)
const roleTarget = ref<UserResponse | null>(null)
const roleForm = reactive({ roleCode: '' })

function openChangeRole(user: UserResponse) {
  roleTarget.value = user
  roleForm.roleCode = user.roleCode ?? defaultRoleCode.value
  roleOpen.value = true
}

const roleTargetInitial = computed(() => {
  const t = roleTarget.value
  const source = t?.displayName || t?.email || ''
  return source.trim().charAt(0).toUpperCase() || '?'
})

const roleTargetCurrentRole = computed(() => roleTarget.value?.roleName ?? roleTarget.value?.roleCode ?? '—')

async function submitChangeRole() {
  const target = roleTarget.value
  if (!target || !roleForm.roleCode) return
  roleSubmitting.value = true
  try {
    await users.changeRole(target.userId, roleForm.roleCode)
    roleOpen.value = false
    notifySuccess('Role updated')
    await load()
  }
  catch (err) {
    notifyError(errorMessage(err, 'Could not change the role.'))
  }
  finally {
    roleSubmitting.value = false
  }
}

// ---------------------------------------------------------------------------
// Change Status — ConfirmDialog when disabling (destructive)
// ---------------------------------------------------------------------------
const disableConfirmOpen = ref(false)
const statusSubmitting = ref(false)
const statusTarget = ref<UserResponse | null>(null)

async function setStatus(user: UserResponse, isActive: boolean) {
  statusSubmitting.value = true
  try {
    await users.setStatus(user.userId, isActive)
    notifySuccess(isActive ? 'User enabled' : 'User disabled')
    await load()
  }
  catch (err) {
    notifyError(errorMessage(err, 'Could not change the status.'))
  }
  finally {
    statusSubmitting.value = false
  }
}

function onToggleStatus(user: UserResponse) {
  if (user.isActive) {
    // Disabling is destructive -> confirm first.
    statusTarget.value = user
    disableConfirmOpen.value = true
  }
  else {
    void setStatus(user, true)
  }
}

async function confirmDisable() {
  const target = statusTarget.value
  if (!target) return
  await setStatus(target, false)
  disableConfirmOpen.value = false
}

// ---------------------------------------------------------------------------
// Reset Password — ConfirmDialog to confirm, then the new-password form
// ---------------------------------------------------------------------------
const resetConfirmOpen = ref(false)
const resetFormOpen = ref(false)
const resetSubmitting = ref(false)
const resetTarget = ref<UserResponse | null>(null)
const resetForm = reactive({ password: '' })
const resetErrors = reactive<Record<string, string>>({})

function openResetPassword(user: UserResponse) {
  resetTarget.value = user
  resetConfirmOpen.value = true
}

function onConfirmReset() {
  resetConfirmOpen.value = false
  resetForm.password = ''
  clearErrors(resetErrors)
  resetFormOpen.value = true
}

async function submitReset() {
  clearErrors(resetErrors)
  if (!resetForm.password) {
    resetErrors.password = 'New password is required.'
    return
  }
  if (resetForm.password.length < 8) {
    resetErrors.password = 'Password must be at least 8 characters.'
    return
  }
  const target = resetTarget.value
  if (!target) return
  resetSubmitting.value = true
  try {
    await users.resetPassword(target.userId, resetForm.password)
    resetFormOpen.value = false
    notifySuccess('Password reset')
  }
  catch (err) {
    notifyError(errorMessage(err, 'Could not reset the password.'))
  }
  finally {
    resetSubmitting.value = false
  }
}

// ---------------------------------------------------------------------------
// Row action menu (only when the user can manage)
// ---------------------------------------------------------------------------
function rowMenuItems(user: UserResponse) {
  return [
    [
      {
        label: 'Edit',
        icon: 'i-lucide-pencil',
        onSelect: () => openEdit(user),
      },
      {
        label: user.isActive ? 'Disable' : 'Enable',
        icon: user.isActive ? 'i-lucide-user-x' : 'i-lucide-user-check',
        onSelect: () => onToggleStatus(user),
      },
      {
        label: 'Reset Password',
        icon: 'i-lucide-key-round',
        onSelect: () => openResetPassword(user),
      },
    ],
  ]
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function clearErrors(target: Record<string, string>) {
  for (const key of Object.keys(target)) delete target[key]
}

function errorMessage(err: unknown, fallback: string): string {
  const msg = (err as { data?: { error?: { message?: string } } })?.data?.error?.message
  return msg ?? fallback
}

function notifySuccess(title: string) {
  toast.add({ title, color: 'success', icon: 'i-lucide-check' })
}

function notifyError(description: string) {
  toast.add({ title: 'Error', description, color: 'error', icon: 'i-lucide-circle-alert' })
}
</script>

<template>
  <div class="flex flex-col gap-6">
    <PageHeader title="Administration" description="Manage users and assign operational roles." />

    <!-- User Mapping section -->
    <div class="flex items-center justify-between gap-4">
      <h2 class="text-[17px] font-semibold text-ink">User Mapping</h2>
      <UButton v-if="canManage" icon="i-lucide-plus" label="Add User" @click="openAdd" />
    </div>

    <ErrorState
      v-if="error"
      message="Could not load the user list."
      @retry="load"
    />

    <template v-else>
      <!-- Empty state -->
      <EmptyState
        v-if="!pending && rows.length === 0"
        title="No users yet"
        description="Add a user to get started."
        icon="i-lucide-users"
      >
        <template v-if="canManage" #action>
          <UButton icon="i-lucide-plus" label="Add User" @click="openAdd" />
        </template>
      </EmptyState>

      <!-- Unified user table card -->
      <div v-else class="overflow-hidden rounded-lg border border-line bg-panel shadow-sm">
        <div class="overflow-x-auto">
          <div class="min-w-[640px]">
            <!-- Column headers -->
            <div
              class="grid grid-cols-[1.4fr_1.4fr_1fr_0.8fr_auto] items-center gap-4 border-b border-line bg-surface px-4 py-3"
            >
              <span class="text-xs font-semibold uppercase tracking-wide text-muted">Email</span>
              <span class="text-xs font-semibold uppercase tracking-wide text-muted">Name</span>
              <span class="text-xs font-semibold uppercase tracking-wide text-muted">Role</span>
              <span class="text-xs font-semibold uppercase tracking-wide text-muted">Status</span>
              <span class="text-right text-xs font-semibold uppercase tracking-wide text-muted">Action</span>
            </div>

            <!-- Loading skeleton -->
            <template v-if="pending">
              <div
                v-for="n in skeletonRows"
                :key="`sk-${n}`"
                class="grid grid-cols-[1.4fr_1.4fr_1fr_0.8fr_auto] items-center gap-4 border-b border-line px-4 py-3 last:border-b-0"
              >
                <USkeleton class="h-4 w-32" />
                <USkeleton class="h-4 w-32" />
                <USkeleton class="h-4 w-16" />
                <USkeleton class="h-5 w-16 rounded-full" />
                <USkeleton class="h-8 w-24 justify-self-end" />
              </div>
            </template>

            <!-- Data rows -->
            <template v-else>
              <div
                v-for="user in rows"
                :key="user.userId"
                class="grid min-h-[52px] grid-cols-[1.4fr_1.4fr_1fr_0.8fr_auto] items-center gap-4 border-b border-line px-4 py-2.5 transition-colors last:border-b-0 hover:bg-surface/60"
              >
                <span class="truncate text-sm font-medium text-ink">{{ user.email }}</span>
                <span class="truncate text-sm text-ink">{{ user.displayName }}</span>
                <span class="truncate text-sm text-ink">{{ roleLabel(user) }}</span>
                <div>
                  <StatusBadge :status="statusOf(user)" />
                </div>
                <div class="flex items-center justify-end gap-1.5">
                  <template v-if="canManage">
                    <UButton
                      size="xs"
                      color="neutral"
                      variant="outline"
                      label="Edit Role"
                      @click="openChangeRole(user)"
                    />
                    <UDropdownMenu :items="rowMenuItems(user)">
                      <UButton
                        size="xs"
                        color="neutral"
                        variant="ghost"
                        icon="i-lucide-ellipsis-vertical"
                        aria-label="More actions"
                      />
                    </UDropdownMenu>
                  </template>
                  <span v-else class="text-xs text-muted">—</span>
                </div>
              </div>
            </template>
          </div>
        </div>
      </div>

      <Pagination
        v-if="total > ITEMS_PER_PAGE"
        v-model:page="page"
        :total="total"
        :items-per-page="ITEMS_PER_PAGE"
      />
    </template>

    <!-- Add User dialog -->
    <UModal v-model:open="addOpen" title="Add User">
      <template #body>
        <form class="flex flex-col gap-4" @submit.prevent="submitAdd">
          <FormField label="Email" name="add-email" :error="addErrors.email" required>
            <template #default="{ id, describedBy, invalid }">
              <UInput
                :id="id"
                v-model="addForm.email"
                type="email"
                :aria-describedby="describedBy"
                :aria-invalid="invalid"
                placeholder="jane@netops.local"
                class="w-full"
              />
            </template>
          </FormField>

          <FormField label="Name" name="add-name" :error="addErrors.displayName" required>
            <template #default="{ id, describedBy, invalid }">
              <UInput
                :id="id"
                v-model="addForm.displayName"
                :aria-describedby="describedBy"
                :aria-invalid="invalid"
                placeholder="Jane Doe"
                class="w-full"
              />
            </template>
          </FormField>

          <FormField label="Password" name="add-password" :error="addErrors.password" required>
            <template #default="{ id, describedBy, invalid }">
              <UInput
                :id="id"
                v-model="addForm.password"
                type="password"
                :aria-describedby="describedBy"
                :aria-invalid="invalid"
                class="w-full"
              />
            </template>
          </FormField>

          <FormField label="Role" name="add-role" :error="addErrors.roleCode" required>
            <template #default="{ id }">
              <USelect
                :id="id"
                v-model="addForm.roleCode"
                :items="roleOptions"
                value-key="value"
                placeholder="Select a role"
                class="w-full"
              />
            </template>
          </FormField>
        </form>
      </template>

      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton color="neutral" variant="ghost" label="Cancel" :disabled="addSubmitting" @click="addOpen = false" />
          <UButton label="Create User" :loading="addSubmitting" @click="submitAdd" />
        </div>
      </template>
    </UModal>

    <!-- Edit (basic info) dialog -->
    <UModal v-model:open="editOpen" title="Edit User">
      <template #body>
        <form class="flex flex-col gap-4" @submit.prevent="submitEdit">
          <FormField label="Name" name="edit-name" :error="editErrors.displayName" required>
            <template #default="{ id, describedBy, invalid }">
              <UInput
                :id="id"
                v-model="editForm.displayName"
                :aria-describedby="describedBy"
                :aria-invalid="invalid"
                class="w-full"
              />
            </template>
          </FormField>
        </form>
      </template>

      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton color="neutral" variant="ghost" label="Cancel" :disabled="editSubmitting" @click="editOpen = false" />
          <UButton label="Save" :loading="editSubmitting" @click="submitEdit" />
        </div>
      </template>
    </UModal>

    <!-- Change Role dialog -->
    <UModal
      v-model:open="roleOpen"
      title="Change Role"
      description="Update the operational role assigned to this user."
    >
      <template #body>
        <div class="flex flex-col gap-4">
          <!-- Read-only user summary -->
          <div
            v-if="roleTarget"
            class="flex items-center gap-3 rounded-lg border border-line bg-surface px-4 py-3"
          >
            <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-brand/10 text-sm font-semibold text-brand">
              {{ roleTargetInitial }}
            </div>
            <div class="min-w-0 flex-1">
              <p class="truncate text-sm font-semibold text-ink">{{ roleTarget.email }}</p>
              <p class="truncate text-[13px] text-muted">{{ roleTarget.displayName }}</p>
            </div>
            <UBadge :label="roleTargetCurrentRole" color="primary" variant="soft" />
          </div>

          <FormField label="Role" name="change-role" required>
            <template #default="{ id }">
              <USelect
                :id="id"
                v-model="roleForm.roleCode"
                :items="roleOptions"
                value-key="value"
                class="w-full"
              />
            </template>
          </FormField>
        </div>
      </template>

      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton color="neutral" variant="ghost" label="Cancel" :disabled="roleSubmitting" @click="roleOpen = false" />
          <UButton label="Update Role" :loading="roleSubmitting" @click="submitChangeRole" />
        </div>
      </template>
    </UModal>

    <!-- Reset Password: new-password form (shown after confirmation) -->
    <UModal v-model:open="resetFormOpen" title="Reset Password">
      <template #body>
        <form class="flex flex-col gap-4" @submit.prevent="submitReset">
          <FormField label="New Password" name="reset-password" :error="resetErrors.password" required>
            <template #default="{ id, describedBy, invalid }">
              <UInput
                :id="id"
                v-model="resetForm.password"
                type="password"
                :aria-describedby="describedBy"
                :aria-invalid="invalid"
                class="w-full"
              />
            </template>
          </FormField>
        </form>
      </template>

      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton color="neutral" variant="ghost" label="Cancel" :disabled="resetSubmitting" @click="resetFormOpen = false" />
          <UButton label="Set Password" :loading="resetSubmitting" @click="submitReset" />
        </div>
      </template>
    </UModal>

    <!-- Destructive confirmations -->
    <ConfirmDialog
      v-model="disableConfirmOpen"
      title="Disable user?"
      :message="`This will disable ${statusTarget?.displayName ?? 'this user'} and prevent them from signing in.`"
      confirm-label="Disable"
      confirm-color="error"
      :loading="statusSubmitting"
      @confirm="confirmDisable"
    />

    <ConfirmDialog
      v-model="resetConfirmOpen"
      title="Reset password?"
      :message="`You are about to reset the password for ${resetTarget?.displayName ?? 'this user'}. Continue to set a new password.`"
      confirm-label="Continue"
      confirm-color="warning"
      @confirm="onConfirmReset"
    />
  </div>
</template>
