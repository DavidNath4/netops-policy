import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

/**
 * Symmetric encryption for secrets stored at rest (TOTP secrets, device session
 * credentials). AES-256-GCM with the app-wide `MFA_ENCRYPTION_KEY`.
 *
 * SECURITY: values encrypted here are NEVER hashed (they must be recoverable),
 * NEVER stored in plaintext, and the key is never written to the DB, sent to the
 * client, or logged. Output format `iv:authTag:ciphertext` (all hex) bundles
 * everything the decryptor needs in one text column.
 */

const ALGORITHM = 'aes-256-gcm'
const IV_BYTES = 12 // GCM standard nonce length
const AUTH_TAG_BYTES = 16
const KEY_BYTES = 32 // AES-256

/**
 * Read + validate the AES key from the environment on demand. Kept as a function
 * (not a module constant) so importing this module never throws before env
 * validation has run at Nitro startup.
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

/** Encrypt a UTF-8 plaintext to `iv:authTag:ciphertext` (hex). */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, getKey(), iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()
  return [iv.toString('hex'), authTag.toString('hex'), ciphertext.toString('hex')].join(':')
}

/** Decrypt a value produced by {@link encryptSecret}. Throws if tampered. */
export function decryptSecret(encoded: string): string {
  const parts = encoded.split(':')
  if (parts.length !== 3) {
    throw new Error('Malformed encrypted value')
  }
  const [ivHex, authTagHex, ciphertextHex] = parts as [string, string, string]
  const iv = Buffer.from(ivHex, 'hex')
  const authTag = Buffer.from(authTagHex, 'hex')
  const ciphertext = Buffer.from(ciphertextHex, 'hex')
  if (iv.length !== IV_BYTES || authTag.length !== AUTH_TAG_BYTES) {
    throw new Error('Malformed encrypted value')
  }
  const decipher = createDecipheriv(ALGORITHM, getKey(), iv)
  decipher.setAuthTag(authTag)
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  return plaintext.toString('utf8')
}
