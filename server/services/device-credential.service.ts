import type { H3Event } from 'h3'
import { getCookie } from 'h3'

import type { Database } from '~~/database'
import * as sessionRepo from '../repositories/session.repository'
import { decryptSecret, encryptSecret } from '../utils/crypto'
import { SESSION_COOKIE, hashSessionToken } from './session.service'

/**
 * Device Session Credentials — the engineer's device username/password held for
 * READ operations (ACL/Route show/search) so they aren't re-typed each search.
 *
 * SECURITY:
 * - Stored ONLY as AES-256-GCM ciphertext on the caller's own `sessions` row
 *   (via the shared crypto util / MFA_ENCRYPTION_KEY); never cleartext.
 * - Scoped to the caller's session (resolved from the session cookie's token
 *   hash) — another user's session can never read them.
 * - Short TTL (30 min), independent of the session TTL.
 * - Removed with the session row on logout/expiry, or cleared manually.
 * - NEVER written to audit or logs; returned to the client only via the owner's
 *   explicit reveal.
 */

export interface DeviceCredentials {
  username: string
  password: string
}

/** Resolve the caller's session token hash from the cookie, or null. */
function tokenHashFromEvent(event: H3Event): string | null {
  const raw = getCookie(event, SESSION_COOKIE)
  return raw ? hashSessionToken(raw) : null
}

/**
 * Encrypt + store the device credentials on the caller's session. They live for
 * the lifetime of the session (no separate TTL); the handler validates them via
 * n8n before calling this.
 */
export async function setDeviceCredentials(
  db: Database,
  event: H3Event,
  creds: DeviceCredentials,
): Promise<void> {
  const tokenHash = tokenHashFromEvent(event)
  if (!tokenHash) {
    throw new Error('No session to attach device credentials to')
  }
  const encrypted = encryptSecret(JSON.stringify(creds))
  await sessionRepo.setDeviceCred(db, tokenHash, encrypted)
}

/**
 * Decrypt the caller's device credentials, or null if unset. Valid for the life
 * of the session (removed with the session on logout/expiry).
 */
export async function getDeviceCredentials(
  db: Database,
  event: H3Event,
): Promise<DeviceCredentials | null> {
  const tokenHash = tokenHashFromEvent(event)
  if (!tokenHash) {
    return null
  }
  const session = await sessionRepo.findByTokenHash(db, tokenHash)
  if (!session?.deviceCredEncrypted) {
    return null
  }
  try {
    return JSON.parse(decryptSecret(session.deviceCredEncrypted)) as DeviceCredentials
  }
  catch {
    // Tampered/undecryptable — treat as absent and clear.
    await sessionRepo.clearDeviceCred(db, tokenHash)
    return null
  }
}

/** Non-secret status for the UI: whether creds are set (+ username). */
export async function deviceCredentialStatus(
  db: Database,
  event: H3Event,
): Promise<{ set: boolean, username?: string }> {
  const creds = await getDeviceCredentials(db, event)
  return creds ? { set: true, username: creds.username } : { set: false }
}

/** Clear the caller's device credentials immediately. */
export async function clearDeviceCredentials(db: Database, event: H3Event): Promise<void> {
  const tokenHash = tokenHashFromEvent(event)
  if (tokenHash) {
    await sessionRepo.clearDeviceCred(db, tokenHash)
  }
}
