import argon2 from 'argon2'

/**
 * Password hashing with Argon2id.
 *
 * SECURITY:
 * - Only ever store the returned hash; the plaintext password must never be
 *   logged, returned, or persisted.
 * - Argon2id is memory-hard and resistant to both GPU and side-channel attacks.
 * - The salt is generated internally by argon2 and embedded in the encoded hash.
 */

// Deliberately explicit so hashes stay reproducible if argon2's defaults change.
const HASH_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19456, // 19 MiB (OWASP-recommended minimum for argon2id)
  timeCost: 2,
  parallelism: 1,
} as const

/** Hash a plaintext password. Returns the encoded Argon2id hash string. */
export function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, HASH_OPTIONS)
}

/**
 * Verify a plaintext password against a stored Argon2 hash.
 *
 * Returns false (never throws) when the hash is malformed, so callers can treat
 * verification failures uniformly without leaking why a login failed.
 */
export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password)
  }
  catch {
    return false
  }
}
