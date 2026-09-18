import { Client, escapeFilter } from 'ldapts'

import { loadEnv } from '../../utils/config'

/**
 * Read-only Active Directory access: bind + search + user-bind ONLY.
 *
 * This module never performs a write (add/modify/delete/moddn) against the
 * directory. It exists to verify a user's identity + password against AD and
 * return the located directory entry. Everything after a successful bind
 * (provisioning, MFA, session) is owned by NetOps and lives elsewhere.
 *
 * SECURITY: never logs the bind password or the user's password.
 */

/** A located directory entry (raw attributes as returned by AD). */
export interface DirectoryEntry {
  dn: string
  /** objectGUID formatted as a canonical GUID string (immutable id), if present. */
  objectGuid: string | null
  attributes: Record<string, string | string[]>
}

/**
 * Thrown when the directory itself cannot be reached or the service account
 * cannot bind — distinct from a wrong user password (which is a normal, generic
 * invalid-credentials outcome). The caller maps this to an informative 503.
 */
export class DirectoryUnreachableError extends Error {
  constructor(
    message: string,
    /** A safe identifier for ops, e.g. 'ECONNREFUSED' / 'ETIMEDOUT'. */
    readonly code: string,
  ) {
    super(message)
    this.name = 'DirectoryUnreachableError'
  }
}

/** Thrown for a normal authentication failure (no/ambiguous match, bad password). */
export class AdCredentialsError extends Error {
  constructor(message = 'Invalid credentials') {
    super(message)
    this.name = 'AdCredentialsError'
  }
}

/** Thrown when the AD account itself is disabled (userAccountControl ACCOUNTDISABLE bit). */
export class AdAccountDisabledError extends Error {
  constructor(message = 'Account is disabled in the directory') {
    super(message)
    this.name = 'AdAccountDisabledError'
  }
}

/** userAccountControl flag: the account is disabled in AD. */
const UAC_ACCOUNTDISABLE = 0x2

/** True when the entry's userAccountControl marks the account as disabled. */
function isAdAccountDisabled(attributes: Record<string, string | string[]>): boolean {
  const raw = attributes.userAccountControl
  const value = Array.isArray(raw) ? raw[0] : raw
  if (typeof value !== 'string') return false
  const uac = Number.parseInt(value, 10)
  return Number.isFinite(uac) && (uac & UAC_ACCOUNTDISABLE) !== 0
}

/** Node connection errors that mean "directory unreachable", not "bad password". */
const UNREACHABLE_CODES = new Set([
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ECONNRESET',
  'EAI_AGAIN',
])

function unreachableCodeOf(err: unknown): string | undefined {
  const code = (err as { code?: unknown })?.code
  if (typeof code === 'string' && UNREACHABLE_CODES.has(code)) {
    return code
  }
  // ldapts surfaces connection timeouts as a generic error message.
  if (err instanceof Error && /timeout/i.test(err.message)) {
    return 'ETIMEDOUT'
  }
  return undefined
}

/**
 * Build the user-search filter.
 *
 * By design the login identifier is flexible: a user may enter their
 * sAMAccountName (e.g. "jdoe"), their userPrincipalName/email (e.g.
 * "jdoe@mov.co.id"), or a `mail` value. The identifier is escaped (RFC 4515)
 * via the `escapeFilter` tagged template — it is untrusted input. A match on
 * more than one entry is rejected by the caller as invalid credentials.
 */
function buildUserFilter(identifier: string): string {
  return escapeFilter`(&(objectClass=user)(|(sAMAccountName=${identifier})(userPrincipalName=${identifier})(mail=${identifier})))`
}

/**
 * Authenticate a user against AD.
 *
 * 1. Bind the service account (failure here → DirectoryUnreachableError, since it
 *    indicates the directory/config, not the end-user's password).
 * 2. Search within AD_BASE_DN for the identifier; require exactly one entry.
 * 3. Bind that entry's DN with the supplied password to verify it.
 *
 * Returns the located entry on success. Throws AdCredentialsError for 0/>1
 * matches or a failed user bind, and DirectoryUnreachableError when AD can't be
 * reached. Always releases the connection.
 */
export async function authenticateAd(identifier: string, password: string): Promise<DirectoryEntry> {
  const env = loadEnv()

  const client = new Client({
    url: env.AD_URL!,
    timeout: env.AD_TIMEOUT_MS,
    connectTimeout: env.AD_TIMEOUT_MS,
  })

  try {
    // Step 1: service-account bind (connectivity + config).
    try {
      await client.bind(env.AD_BIND_DN!, env.AD_BIND_PASSWORD!)
    }
    catch (err) {
      const code = unreachableCodeOf(err)
      if (code) {
        throw new DirectoryUnreachableError('Directory unreachable', code)
      }
      // A failed service-account bind is a server-side misconfiguration, not an
      // end-user credential problem — surface it as unreachable, not 401.
      throw new DirectoryUnreachableError('Directory service bind failed', 'SERVICE_BIND_FAILED')
    }

    // Step 2: locate the user (read-only search).
    // objectGUID is binary — request it explicitly as a Buffer so we can format
    // it into a stable canonical GUID string for use as the immutable external_id.
    let entries
    try {
      const result = await client.search(env.AD_BASE_DN!, {
        scope: 'sub',
        filter: buildUserFilter(identifier),
        explicitBufferAttributes: ['objectGUID'],
      })
      entries = result.searchEntries
    }
    catch (err) {
      const code = unreachableCodeOf(err)
      if (code) {
        throw new DirectoryUnreachableError('Directory unreachable', code)
      }
      throw err
    }

    // Exactly one match required; 0 or >1 → generic invalid credentials.
    if (entries.length !== 1) {
      throw new AdCredentialsError()
    }

    const entry = entries[0]!
    const dn = entry.dn
    const attributes = normalizeAttributes(entry)

    // Reject accounts disabled in the directory (distinct from NetOps is_active).
    // Checked before the user bind so a disabled account never proceeds.
    if (isAdAccountDisabled(attributes)) {
      throw new AdAccountDisabledError()
    }

    // Step 3: verify the password by binding as the user.
    try {
      await client.bind(dn, password)
    }
    catch (err) {
      const code = unreachableCodeOf(err)
      if (code) {
        throw new DirectoryUnreachableError('Directory unreachable', code)
      }
      // Any other bind failure here means the password was wrong.
      throw new AdCredentialsError()
    }

    return { dn, objectGuid: extractObjectGuid(entry), attributes }
  }
  finally {
    // Always release the connection; ignore unbind errors.
    try {
      await client.unbind()
    }
    catch {
      // no-op
    }
  }
}

/**
 * Reduce a raw ldapts entry to a plain attribute map (string | string[]),
 * dropping the `dn` key (kept separately) and Buffer-typed values we don't use.
 */
function normalizeAttributes(entry: Record<string, unknown>): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {}
  for (const [key, value] of Object.entries(entry)) {
    if (key === 'dn') continue
    if (typeof value === 'string') {
      out[key] = value
    }
    else if (Array.isArray(value)) {
      const strings = value.filter((v): v is string => typeof v === 'string')
      if (strings.length > 0) out[key] = strings
    }
    else if (Buffer.isBuffer(value)) {
      // Surface objectGUID as its canonical string; other binary attrs omitted.
      if (key.toLowerCase() === 'objectguid') {
        out[key] = formatGuid(value)
      }
    }
    // Other non-string types are intentionally omitted from the plain map.
  }
  return out
}

/** Pull objectGUID (Buffer or already-string) from a raw entry as a canonical GUID string. */
function extractObjectGuid(entry: Record<string, unknown>): string | null {
  const raw = entry.objectGUID
  if (Buffer.isBuffer(raw)) return formatGuid(raw)
  if (Array.isArray(raw) && Buffer.isBuffer(raw[0])) return formatGuid(raw[0])
  if (typeof raw === 'string' && raw.length > 0) return raw
  return null
}

/**
 * Format an AD objectGUID (16-byte binary) as the canonical GUID string.
 *
 * AD stores the GUID mixed-endian: the first three groups are little-endian,
 * the last two are big-endian. Produces e.g. "12345678-1234-1234-1234-1234567890ab".
 */
function formatGuid(buf: Buffer): string {
  if (buf.length !== 16) return buf.toString('hex')
  const h = (i: number) => buf[i]!.toString(16).padStart(2, '0')
  return [
    h(3) + h(2) + h(1) + h(0),
    h(5) + h(4),
    h(7) + h(6),
    h(8) + h(9),
    h(10) + h(11) + h(12) + h(13) + h(14) + h(15),
  ].join('-')
}
