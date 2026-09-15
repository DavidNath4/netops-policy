import { createHash, randomBytes } from 'node:crypto'
import type { H3Event } from 'h3'
import { deleteCookie, getCookie, getRequestHeader, getRequestIP, setCookie } from 'h3'

import type { Database } from '~~/database'
import type { UserRow } from '../repositories/user.repository'
import { findById as findUserById } from '../repositories/user.repository'
import * as sessionRepo from '../repositories/session.repository'
import { loadEnv } from '../utils/config'

/**
 * Server-side session lifecycle.
 *
 * Token model (Req 1.4, NFR Security 2):
 *   raw token = base64url(randomBytes(32))   -> sent ONLY in the HttpOnly cookie
 *   token_hash = SHA-256(raw token)          -> the only thing stored in the DB
 *
 * The raw token never touches the database or the logs. A session row is
 * created only after MFA has succeeded (callers enforce that ordering).
 */

export const SESSION_COOKIE = 'netops_session'

// Only refresh last_used_at when it's older than this, to avoid a DB write on
// every authenticated request (Req 1.6 throttling).
const LAST_USED_THROTTLE_MS = 5 * 60 * 1000

/** Generate a high-entropy raw session token (never stored server-side). */
export function generateSessionToken(): string {
  return randomBytes(32).toString('base64url')
}

/** Hash a raw session token for storage/lookup. */
export function hashSessionToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex')
}

function sessionTtlMs(): number {
  return loadEnv().SESSION_TTL_HOURS * 60 * 60 * 1000
}

/** True in production, where the cookie must be Secure (HTTPS-only). */
function isProduction(): boolean {
  return loadEnv().NODE_ENV === 'production'
}

/**
 * Create a persisted session for a user and set the HttpOnly cookie.
 * Returns the expiry so callers can report it if needed.
 */
export async function createSession(
  db: Database,
  event: H3Event,
  userId: string,
): Promise<{ expiresAt: Date }> {
  const rawToken = generateSessionToken()
  const tokenHash = hashSessionToken(rawToken)
  const expiresAt = new Date(Date.now() + sessionTtlMs())

  const userAgent = getRequestHeader(event, 'user-agent')?.slice(0, 512) ?? null
  // Framework-derived client IP only; we don't trust arbitrary forwarding
  // headers without a configured proxy (Req 28).
  const sourceIp = getRequestIP(event)?.slice(0, 64) ?? null

  await sessionRepo.createSession(db, { userId, tokenHash, expiresAt, sourceIp, userAgent })

  setCookie(event, SESSION_COOKIE, rawToken, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProduction(),
    path: '/',
    maxAge: Math.floor(sessionTtlMs() / 1000),
  })

  return { expiresAt }
}

/**
 * Resolve the session cookie to an active user, or null.
 *
 * Invalid when: no cookie, unknown token, expired session, missing user, or
 * inactive user. Expired/orphaned sessions are cleaned up and the cookie is
 * cleared. last_used_at is refreshed at most once per throttle window.
 */
export async function validateSession(db: Database, event: H3Event): Promise<UserRow | null> {
  const rawToken = getCookie(event, SESSION_COOKIE)
  if (!rawToken) {
    return null
  }

  const tokenHash = hashSessionToken(rawToken)
  const session = await sessionRepo.findByTokenHash(db, tokenHash)

  if (!session) {
    clearSessionCookie(event)
    return null
  }

  const now = Date.now()
  if (session.expiresAt.getTime() <= now) {
    await sessionRepo.deleteByTokenHash(db, tokenHash)
    clearSessionCookie(event)
    return null
  }

  const user = await findUserById(db, session.userId)
  if (!user || !user.isActive) {
    await sessionRepo.deleteByTokenHash(db, tokenHash)
    clearSessionCookie(event)
    return null
  }

  // Throttled last_used_at refresh (Req 18).
  const lastUsed = session.lastUsedAt?.getTime() ?? 0
  if (now - lastUsed > LAST_USED_THROTTLE_MS) {
    await sessionRepo.updateLastUsed(db, tokenHash, new Date(now))
  }

  return user
}

/** Revoke the current session (if any) and clear the cookie. Idempotent. */
export async function revokeSession(db: Database, event: H3Event): Promise<void> {
  const rawToken = getCookie(event, SESSION_COOKIE)
  if (rawToken) {
    await sessionRepo.deleteByTokenHash(db, hashSessionToken(rawToken))
  }
  clearSessionCookie(event)
}

/** Revoke every session for a user (e.g. on password reset or disable). */
export async function revokeAllUserSessions(db: Database, userId: string): Promise<void> {
  await sessionRepo.deleteAllByUserId(db, userId)
}

export function clearSessionCookie(event: H3Event): void {
  deleteCookie(event, SESSION_COOKIE, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProduction(),
    path: '/',
  })
}
