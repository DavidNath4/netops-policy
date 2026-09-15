import type { UserResponse } from '#shared/schemas/user.schema'
import type { CreateLocalUserInput } from '#shared/schemas/user.schema'

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

/** Map a DB user row to the safe, client-facing shape. */
export function toUserResponse(row: UserRow): UserResponse {
  return {
    userId: row.userId,
    email: row.email,
    displayName: row.displayName,
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
 * Verify a TOTP code during login (second factor). Only enabled enrollments
 * count; a pending (unconfirmed) enrollment cannot satisfy login MFA.
 */
export async function verifyMfaLogin(
  db: Database,
  userId: string,
  code: string,
): Promise<boolean> {
  const enrollment = await mfaRepo.findByUserId(db, userId)
  if (!enrollment || !enrollment.isEnabled) {
    return false
  }

  const secret = decryptSecret(enrollment.secretEncrypted)
  return verifyTotp(secret, code)
}
