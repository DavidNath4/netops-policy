import { generateSecret, generateURI, verify } from 'otplib'

// AES-256-GCM secret encryption lives in the shared crypto util (also used by
// the device-credential service). Re-exported here for existing callers.
import { decryptSecret, encryptSecret } from '../utils/crypto'

export { decryptSecret, encryptSecret }

/**
 * TOTP multi-factor authentication (otplib functional API).
 *
 * The Base32 TOTP secret is encrypted at rest via the shared crypto util
 * (AES-256-GCM, MFA_ENCRYPTION_KEY) — never stored or logged in plaintext, and
 * never hashed (it must be recoverable to verify future codes).
 */

const ISSUER = 'NetOps Policy Manager'

/** Generate a fresh Base32 TOTP secret for a new enrollment. */
export function generateTotpSecret(): string {
  return generateSecret()
}

/**
 * Build the otpauth:// URI a client turns into a QR code. `label` is typically
 * the user's email so the entry is identifiable in their authenticator app.
 */
export function buildTotpUri(secret: string, label: string): string {
  return generateURI({ issuer: ISSUER, label, secret })
}

/**
 * Verify a 6-digit TOTP code against the (decrypted) secret.
 *
 * otplib's verify uses constant-time comparison internally. Returns a plain
 * boolean so callers don't have to reason about the delta window.
 */
export async function verifyTotp(secret: string, code: string): Promise<boolean> {
  // epochTolerance (seconds) accepts a code from the adjacent time steps, not
  // just the exact current 30s window. Without it, a code entered near a window
  // boundary — or with minor client/server clock skew — is rejected even though
  // it's correct, then succeeds on a retry a moment later. ±30s (one window
  // either side) is the standard 2FA tolerance and fixes that intermittent
  // "wrong now, right on retry" behavior.
  const result = await verify({ secret, token: code, epochTolerance: 30 })
  return result.valid
}
