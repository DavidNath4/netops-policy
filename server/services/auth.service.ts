import type { UserResponse } from '#shared/schemas/user.schema'
import type { CreateLocalUserInput } from '#shared/schemas/user.schema'
import type { MfaDeviceResponse } from '#shared/schemas/mfa.schema'
import { MFA_DEVICE_LIMIT } from '#shared/schemas/mfa.schema'

import type { Database } from '~~/database'
import type { UserRow } from '../repositories/user.repository'
import * as userRepo from '../repositories/user.repository'
import * as mfaRepo from '../repositories/user-mfa.repository'
import { hashPassword, verifyPassword } from './password.service'
import {
  buildTotpUri,
  decryptSecret,
  encryptSecret,
  generateTotpSecret,
  verifyTotp,
} from './mfa.service'
import {
  AdAccountDisabledError,
  AdCredentialsError,
  authenticateAd,
} from '../auth/ad/directory'

/**
 * Authentication orchestration.
 *
 * Combines the user/MFA repositories with the password and MFA services. This
 * is the only layer that decides *whether* a login succeeds; repositories just
 * read/write and the crypto services just hash/verify.
 *
 * SECURITY:
 * - Login failures are deliberately uniform. Whether the email is unknown, the
 *   account is inactive, it isn't a LOCAL account, or the password is wrong,
 *   callers get the same failure so attackers can't enumerate accounts.
 * - DB rows are never returned directly; users are mapped to a safe shape that
 *   omits passwordHash and the MFA secret.
 */

/** Distinguishable error for expected auth failures (vs. unexpected bugs). */
export class AuthError extends Error {
  constructor(message = 'Invalid email or password') {
    super(message)
    this.name = 'AuthError'
  }
}

/**
 * The NetOps account is deactivated (`is_active = false`). Distinct from a
 * credential failure so the login endpoint can surface a clear "account
 * disabled" message and (for AD) stop before contacting the directory.
 */
export class AccountDisabledError extends Error {
  constructor(message = 'Account is disabled') {
    super(message)
    this.name = 'AccountDisabledError'
  }
}

// Re-export the directory errors so endpoints can map them without importing the
// provider module directly.
export { AdAccountDisabledError, AdCredentialsError } from '../auth/ad/directory'
export { DirectoryUnreachableError } from '../auth/ad/directory'

/** Map a DB user row to the safe, client-facing shape. */
export function toUserResponse(row: UserRow): UserResponse {
  return {
    userId: row.userId,
    email: row.email,
    displayName: row.displayName,
    username: row.username,
    authProvider: row.authProvider,
    isActive: row.isActive,
    lastLoginAt: row.lastLoginAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

/**
 * Create a LOCAL user from validated input.
 *
 * Input is expected to have already passed CreateLocalUserSchema (email
 * normalized). Throws AuthError if the email is already taken.
 */
export async function createLocalUser(
  db: Database,
  input: CreateLocalUserInput,
): Promise<UserResponse> {
  if (await userRepo.existsByEmail(db, input.email)) {
    throw new AuthError('Email is already registered')
  }

  const passwordHash = await hashPassword(input.password)
  const row = await userRepo.createLocalUser(db, {
    email: input.email,
    displayName: input.displayName,
    passwordHash,
  })

  return toUserResponse(row)
}

/**
 * Verify email + password for a LOCAL account (first factor only).
 *
 * Returns the safe user shape on success. Throws AuthError with a generic
 * message on any failure to avoid account enumeration. A verifyPassword call is
 * still performed against a dummy hash when the user is missing so response
 * timing doesn't reveal whether the account exists.
 */
export async function verifyLocalCredentials(
  db: Database,
  email: string,
  password: string,
): Promise<UserResponse> {
  const user = await userRepo.findByEmail(db, email)

  const usable
    = user !== undefined
      && user.isActive
      && user.authProvider === 'LOCAL'
      && user.passwordHash !== null

  // Always run a verification to keep timing uniform whether or not the account
  // exists / is usable. DUMMY_HASH never matches a real password.
  const hashToCheck = usable ? user.passwordHash! : DUMMY_HASH
  const ok = await verifyPassword(hashToCheck, password)

  if (!usable || !ok) {
    throw new AuthError()
  }

  return toUserResponse(user!)
}

// A valid argon2id hash of a random string. Used only to equalize timing for
// unknown/unusable accounts; it can never match a user-supplied password.
const DUMMY_HASH
  = '$argon2id$v=19$m=19456,t=2,p=1$c29tZS1zdGF0aWMtc2FsdA$RdescQjyPZWjY9d0Ck0m5xZ1oQ5rM6M8dQ0f7l0m5A'

/**
 * Verify an Active Directory login (first factor) and resolve it to a NetOps
 * user, provisioning one just-in-time on first login.
 *
 * The password is always verified live against AD (an LDAP bind); NetOps never
 * stores it. On success the user is recognized by its immutable directory id
 * (objectGUID → external_id): an existing user is refreshed, a new one is
 * created with no role (common access) until an administrator assigns one.
 *
 * Throws:
 * - AdCredentialsError      → wrong/unknown/ambiguous credentials (→ generic 401)
 * - AdAccountDisabledError  → account disabled in the directory (→ 403)
 * - AccountDisabledError    → NetOps user exists but is_active = false (→ 403)
 * - DirectoryUnreachableError → AD cannot be reached (→ 503)
 */
export async function verifyAdCredentials(
  db: Database,
  identifier: string,
  password: string,
): Promise<UserResponse> {
  // Bind + search + user-bind against AD (throws on failure/unreachable).
  const entry = await authenticateAd(identifier, password)

  const externalId = entry.objectGuid
  if (!externalId) {
    // Without an immutable id we can't safely recognize the user. Treat as a
    // credential failure rather than provisioning an unstable account.
    throw new AdCredentialsError()
  }

  const email = pickAttr(entry.attributes, 'userPrincipalName')
  const displayName = pickAttr(entry.attributes, 'displayName') ?? pickAttr(entry.attributes, 'cn')
  if (!email || !displayName) {
    throw new AdCredentialsError()
  }
  // AD username (sAMAccountName). Stored lowercase for consistent lookup.
  const username = pickAttr(entry.attributes, 'sAMAccountName')?.toLowerCase() ?? null

  const existing = await userRepo.findByExternalId(db, externalId)
  if (existing) {
    // Returning AD user. Honor the NetOps disabled gate, then refresh + return.
    if (!existing.isActive) {
      throw new AccountDisabledError()
    }
    // Refresh mutable directory-sourced fields (never role/isActive/externalId).
    // Also backfills username on accounts provisioned before the column existed.
    if (
      existing.email !== email.toLowerCase()
      || existing.displayName !== displayName
      || existing.username !== username
    ) {
      await userRepo.updateAdProfile(db, existing.userId, {
        email: email.toLowerCase(),
        displayName,
        username,
      })
    }
    return toUserResponse({ ...existing, email: email.toLowerCase(), displayName, username })
  }

  // First login → provision with no role (common access until assigned).
  const created = await userRepo.createAdUser(db, {
    externalId,
    email: email.toLowerCase(),
    displayName,
    username,
  })
  return toUserResponse(created)
}

/** Read a single-valued AD attribute (first element if multi-valued). */
function pickAttr(attributes: Record<string, string | string[]>, key: string): string | undefined {
  const raw = attributes[key]
  const value = Array.isArray(raw) ? raw[0] : raw
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Begin TOTP enrollment for a user: generate a secret, store it encrypted
 * (disabled until confirmed), and return the otpauth URI for the QR code.
 *
 * Any prior enrollment is replaced so re-enrolling can't strand a stale secret.
 * The raw secret leaves this function only inside the otpauth URI, which the
 * client needs to render the QR code.
 */
export async function prepareMfaEnrollment(
  db: Database,
  userId: string,
): Promise<{ otpauthUri: string }> {
  const user = await userRepo.findById(db, userId)
  if (!user) {
    throw new AuthError('User not found')
  }

  const secret = generateTotpSecret()

  await mfaRepo.deleteByUserId(db, userId)
  await mfaRepo.create(db, { userId, secretEncrypted: encryptSecret(secret) })

  return { otpauthUri: buildTotpUri(secret, user.email) }
}

/**
 * Confirm enrollment by verifying the first code. Only on success is the
 * enrollment marked enabled (isEnabled=true, verifiedAt set).
 */
export async function verifyMfaEnrollment(
  db: Database,
  userId: string,
  code: string,
): Promise<boolean> {
  const enrollment = await mfaRepo.findByUserId(db, userId)
  if (!enrollment) {
    return false
  }

  const secret = decryptSecret(enrollment.secretEncrypted)
  const valid = await verifyTotp(secret, code)
  if (!valid) {
    return false
  }

  await mfaRepo.enable(db, userId)
  return true
}

/**
 * Verify a TOTP code during login (second factor). A user may have up to two
 * enrolled devices; the code is valid if it matches ANY enabled device. Pending
 * (unconfirmed) enrollments never count.
 */
export async function verifyMfaLogin(
  db: Database,
  userId: string,
  code: string,
): Promise<boolean> {
  const devices = await mfaRepo.listByUserId(db, userId)
  const enabled = devices.filter(d => d.isEnabled)
  if (enabled.length === 0) {
    return false
  }

  for (const device of enabled) {
    const secret = decryptSecret(device.secretEncrypted)
    if (await verifyTotp(secret, code)) {
      return true
    }
  }
  return false
}

// ---------------------------------------------------------------------------
// Multi-device MFA management (post-authentication, from the profile)
// ---------------------------------------------------------------------------

/** Business-rule violations for device management, mapped to API errors by callers. */
export class MfaDeviceRuleError extends Error {
  constructor(
    public readonly rule: 'LIMIT_REACHED' | 'LAST_DEVICE' | 'NOT_FOUND',
    message: string,
  ) {
    super(message)
    this.name = 'MfaDeviceRuleError'
  }
}

/**
 * List a user's CONFIRMED devices in the safe client shape (never exposes the
 * secret). Pending/unconfirmed enrollments are excluded so a cancelled or
 * abandoned "add device" attempt never shows up in the profile.
 */
export async function listMfaDevices(
  db: Database,
  userId: string,
): Promise<MfaDeviceResponse[]> {
  const rows = await mfaRepo.listByUserId(db, userId)
  return rows.filter(r => r.isEnabled).map(toMfaDeviceResponse)
}

/**
 * Begin enrolling an ADDITIONAL device from the profile (user already signed
 * in). Enforces the max-2 rule against confirmed devices, clears any stranded
 * pending enrollment, then creates a fresh disabled row and returns both its id
 * and the otpauth URI so the client can render the QR and confirm it.
 *
 * Unlike {@link prepareMfaEnrollment}, this never deletes confirmed devices.
 */
export async function prepareAddMfaDevice(
  db: Database,
  userId: string,
  label?: string,
): Promise<{ mfaId: string, otpauthUri: string }> {
  const user = await userRepo.findById(db, userId)
  if (!user) {
    throw new AuthError('User not found')
  }

  const enabledCount = await mfaRepo.countEnabledByUserId(db, userId)
  if (enabledCount >= MFA_DEVICE_LIMIT) {
    throw new MfaDeviceRuleError('LIMIT_REACHED', 'Maximum number of MFA devices reached')
  }

  // Never leave more than one half-finished enrollment lying around.
  await mfaRepo.deletePendingByUserId(db, userId)

  const secret = generateTotpSecret()
  const deviceLabel = label?.trim() || `Authenticator ${enabledCount + 1}`
  const row = await mfaRepo.create(db, {
    userId,
    secretEncrypted: encryptSecret(secret),
    label: deviceLabel,
  })

  return { mfaId: row.mfaId, otpauthUri: buildTotpUri(secret, user.email) }
}

/**
 * Confirm an additional device by verifying its first code. Scoped to the
 * owner + the specific pending device; on success the device is enabled.
 */
export async function verifyAddMfaDevice(
  db: Database,
  userId: string,
  mfaId: string,
  code: string,
): Promise<boolean> {
  const device = await mfaRepo.findByMfaId(db, userId, mfaId)
  if (!device || device.isEnabled) {
    return false
  }

  const secret = decryptSecret(device.secretEncrypted)
  if (!await verifyTotp(secret, code)) {
    return false
  }

  await mfaRepo.enableByMfaId(db, userId, mfaId)
  return true
}

/**
 * Remove a device. Refuses to remove the user's last confirmed device (a user
 * must always keep at least one), and refuses unknown ids.
 */
export async function deleteMfaDevice(
  db: Database,
  userId: string,
  mfaId: string,
): Promise<void> {
  const device = await mfaRepo.findByMfaId(db, userId, mfaId)
  if (!device) {
    throw new MfaDeviceRuleError('NOT_FOUND', 'MFA device not found')
  }

  if (device.isEnabled) {
    const enabledCount = await mfaRepo.countEnabledByUserId(db, userId)
    if (enabledCount <= 1) {
      throw new MfaDeviceRuleError('LAST_DEVICE', 'Cannot remove the last MFA device')
    }
  }

  await mfaRepo.deleteByMfaId(db, userId, mfaId)
}

/** Map a DB device row to the safe client shape (drops the encrypted secret). */
function toMfaDeviceResponse(row: mfaRepo.UserMfaRow): MfaDeviceResponse {
  return {
    mfaId: row.mfaId,
    label: row.label,
    mfaType: row.mfaType,
    isEnabled: row.isEnabled,
    verifiedAt: row.verifiedAt ? row.verifiedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  }
}
