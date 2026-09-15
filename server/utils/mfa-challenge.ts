import { createHmac, timingSafeEqual } from 'node:crypto'
import type { H3Event } from 'h3'
import { deleteCookie, getCookie, setCookie } from 'h3'

import { loadEnv } from './config'

/**
 * Pre-authentication MFA challenge.
 *
 * After a password is verified we do NOT create a full session. Instead we issue
 * a short-lived, integrity-protected challenge that proves "this browser just
 * passed the first factor for this user". The MFA endpoints require a valid
 * challenge, so an attacker cannot submit `userId + OTP` without having first
 * cleared the password step.
 *
 * The challenge is stateless (no DB table): a JSON payload carried in an
 * HttpOnly cookie, signed with HMAC-SHA256 keyed by SESSION_SECRET. The payload
 * is not secret (it holds only a userId, a purpose, and an expiry), but it is
 * tamper-proof — the signature is verified in constant time before we trust it.
 */

export const MFA_CHALLENGE_COOKIE = 'netops_mfa_challenge'

export type MfaPurpose = 'MFA_ENROLLMENT' | 'MFA_LOGIN'

interface ChallengePayload {
  userId: string
  purpose: MfaPurpose
  expiresAt: number // epoch ms
}

function isProduction(): boolean {
  return loadEnv().NODE_ENV === 'production'
}

function sign(data: string): string {
  return createHmac('sha256', loadEnv().SESSION_SECRET).update(data).digest('hex')
}

/** Constant-time comparison of two hex signatures. */
function signaturesMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'hex')
  const bufB = Buffer.from(b, 'hex')
  if (bufA.length !== bufB.length) {
    return false
  }
  return timingSafeEqual(bufA, bufB)
}

/**
 * Create a challenge for `userId`/`purpose` and set the HttpOnly cookie.
 * Expiry is driven by MFA_CHALLENGE_TTL_MINUTES.
 */
export function issueMfaChallenge(event: H3Event, userId: string, purpose: MfaPurpose): { expiresAt: number } {
  const ttlMs = loadEnv().MFA_CHALLENGE_TTL_MINUTES * 60 * 1000
  const payload: ChallengePayload = {
    userId,
    purpose,
    expiresAt: Date.now() + ttlMs,
  }

  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  const token = `${encoded}.${sign(encoded)}`

  setCookie(event, MFA_CHALLENGE_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProduction(),
    path: '/',
    maxAge: Math.floor(ttlMs / 1000),
  })

  return { expiresAt: payload.expiresAt }
}

/**
 * Read and verify the challenge cookie. Returns the payload only when the
 * signature is valid, the purpose matches, and it has not expired; otherwise
 * null. Does not clear the cookie (callers decide when to consume it).
 */
export function readMfaChallenge(event: H3Event, expectedPurpose: MfaPurpose): ChallengePayload | null {
  const token = getCookie(event, MFA_CHALLENGE_COOKIE)
  if (!token) {
    return null
  }

  const dot = token.lastIndexOf('.')
  if (dot <= 0) {
    return null
  }

  const encoded = token.slice(0, dot)
  const signature = token.slice(dot + 1)
  if (!signaturesMatch(signature, sign(encoded))) {
    return null
  }

  let payload: ChallengePayload
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as ChallengePayload
  }
  catch {
    return null
  }

  if (
    typeof payload.userId !== 'string'
    || (payload.purpose !== 'MFA_ENROLLMENT' && payload.purpose !== 'MFA_LOGIN')
    || typeof payload.expiresAt !== 'number'
  ) {
    return null
  }

  if (payload.purpose !== expectedPurpose) {
    return null
  }

  if (payload.expiresAt <= Date.now()) {
    return null
  }

  return payload
}

export function clearMfaChallenge(event: H3Event): void {
  deleteCookie(event, MFA_CHALLENGE_COOKIE, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProduction(),
    path: '/',
  })
}
