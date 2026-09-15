import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'node:crypto'

import { generateSecret, generateURI, verify } from 'otplib'

/**
 * TOTP multi-factor authentication.
 *
 * Two concerns live here:
 *  1. TOTP generation/verification via otplib's functional API. The default
 *     crypto backend is the Noble plugin, which works across runtimes without
 *     extra configuration.
 *  2. Encryption of the Base32 TOTP secret at rest using AES-256-GCM. The
 *     secret is NEVER stored or logged in plaintext, and NEVER hashed (we must
 *     be able to recover it to verify future codes).
 *
 * SECURITY: the encryption key comes from MFA_ENCRYPTION_KEY (32 bytes, 64 hex)
 * and must never be written to the database, sent to the client, or logged.
 */

const ALGORITHM = 'aes-256-gcm'
const IV_BYTES = 12 // GCM standard nonce length
const AUTH_TAG_BYTES = 16
const KEY_BYTES = 32 // AES-256

const ISSUER = 'NetOps Policy Manager'

/**
 * Read and validate the AES key from the environment on demand.
 *
 * Kept as a function (not a module-level constant) so importing this module
 * never throws before env validation has run at Nitro startup.
 */
function getKey(): Buffer {
  const hex = process.env.MFA_ENCRYPTION_KEY
  if (!hex) {
    throw new Error('MFA_ENCRYPTION_KEY is not set')
  }

  const key = Buffer.from(hex, 'hex')
  if (key.length !== KEY_BYTES) {
    throw new Error('MFA_ENCRYPTION_KEY must decode to exactly 32 bytes')
  }

  return key
}

/**
 * Encrypt a plaintext TOTP secret.
 *
 * Output format: `iv:authTag:ciphertext`, each part hex-encoded. Bundling the
 * random IV and GCM auth tag with the ciphertext keeps everything the
 * decryptor needs in a single text column.
 */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, getKey(), iv)

  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()

  return [iv.toString('hex'), authTag.toString('hex'), ciphertext.toString('hex')].join(':')
}

/** Decrypt a secret produced by {@link encryptSecret}. Throws if tampered. */
export function decryptSecret(encoded: string): string {
  const parts = encoded.split(':')
  if (parts.length !== 3) {
    throw new Error('Malformed encrypted secret')
  }

  const [ivHex, authTagHex, ciphertextHex] = parts as [string, string, string]
  const iv = Buffer.from(ivHex, 'hex')
  const authTag = Buffer.from(authTagHex, 'hex')
  const ciphertext = Buffer.from(ciphertextHex, 'hex')

  if (iv.length !== IV_BYTES || authTag.length !== AUTH_TAG_BYTES) {
    throw new Error('Malformed encrypted secret')
  }

  const decipher = createDecipheriv(ALGORITHM, getKey(), iv)
  decipher.setAuthTag(authTag)

  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  return plaintext.toString('utf8')
}

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
  const result = await verify({ secret, token: code })
  return result.valid
}
