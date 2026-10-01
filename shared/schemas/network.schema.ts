import { z } from 'zod'

// Reusable network-field primitives (Zod, runtime). Used to validate ACL/route
// form input on the client and re-validate on the server before a field payload
// is sent to n8n. These are validation only — they never touch a device.

/** IPv4 address, e.g. 10.0.0.1. Rejects anything that isn't a valid IPv4. */
export const Ipv4Schema = z.ipv4({ message: 'Invalid IPv4 address' })

/** IPv4 or IPv6 address. */
export const IpAddressSchema = z.union([z.ipv4(), z.ipv6()], { message: 'Invalid IP address' })

/** CIDR notation (v4 or v6), e.g. 10.200.0.0/16 or 2001:db8::/32. */
export const CidrSchema = z.union([z.cidrv4(), z.cidrv6()], { message: 'Invalid CIDR notation' })

/** TCP/UDP port, integer 1..65535 inclusive. */
export const PortSchema = z.coerce
  .number()
  .int('Port must be an integer')
  .min(1, 'Port must be between 1 and 65535')
  .max(65535, 'Port must be between 1 and 65535')

/** Transport/network protocol accepted for ACL rules. */
export const ProtocolSchema = z.enum(['TCP', 'UDP', 'ICMP', 'ANY'], {
  message: 'Protocol must be one of TCP, UDP, ICMP, ANY',
})
export type Protocol = z.infer<typeof ProtocolSchema>

/** ACL action. */
export const AclActionSchema = z.enum(['ALLOW', 'DENY'], {
  message: 'Action must be ALLOW or DENY',
})
export type AclAction = z.infer<typeof AclActionSchema>

/**
 * Change ticket reference, e.g. CHG-123456. Optional on requests; when present
 * it is stored as a fixed, indexed audit column for the Log Trail filter.
 */
export const ChangeTicketSchema = z
  .string()
  .trim()
  .min(1, 'Change ticket is required')
  .max(64, 'Change ticket must be at most 64 characters')

/**
 * Free-text time range for a rule (e.g. "31-May-26"). The exact format is
 * whatever n8n/the device expects; kept as a bounded free string here.
 */
export const TimeRangeSchema = z
  .string()
  .trim()
  .min(1, 'Time range is required')
  .max(64, 'Time range must be at most 64 characters')

/** Description / note field, length-capped. */
export const DescriptionSchema = z
  .string()
  .trim()
  .max(1000, 'Description must be at most 1000 characters')

/**
 * A subnet mask or wildcard (e.g. 255.255.255.255). Bounded free string; the
 * exact form is a device concern validated further by n8n if needed.
 */
export const MaskSchema = z
  .string()
  .trim()
  .min(1, 'Mask is required')
  .max(64, 'Mask must be at most 64 characters')

/**
 * All IPv4 subnet masks, /0 through /32, as dropdown options. `cidr` is the
 * prefix length and `mask` the dotted-decimal form the device/n8n expects.
 * Generated so there is one entry per prefix length (no hand-maintained list).
 */
export interface MaskOption {
  cidr: number
  mask: string
  /** e.g. "/24 — 255.255.255.0" */
  label: string
}

export const SUBNET_MASKS: MaskOption[] = Array.from({ length: 33 }, (_, cidr) => {
  // Build the 32-bit mask for this prefix length, then split into 4 octets.
  const bits = cidr === 0 ? 0 : (0xFFFFFFFF << (32 - cidr)) >>> 0
  const mask = [24, 16, 8, 0].map(shift => (bits >>> shift) & 0xFF).join('.')
  return { cidr, mask, label: `/${cidr} — ${mask}` }
})

/**
 * Infer the CIDR prefix length from a dotted-decimal subnet mask.
 * Returns the prefix (0–32) for a valid, contiguous mask, or null when the
 * value is malformed or not a real mask (e.g. 255.0.255.0). Used by the UI to
 * show a live "/24" hint, or "/?" when the mask makes no sense.
 */
export function maskToCidr(mask: string): number | null {
  const parts = mask.trim().split('.')
  if (parts.length !== 4) return null

  let bits = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const n = Number(part)
    if (n > 255) return null
    bits = (bits << 8) | n
  }
  bits = bits >>> 0

  // A valid mask is a run of 1s followed by a run of 0s. Invert and check the
  // zeros form a contiguous low block: (~bits + 1) must be a power of two.
  const inverted = (~bits) >>> 0
  if (((inverted + 1) & inverted) !== 0) return null

  // Count the leading 1 bits = prefix length.
  let cidr = 0
  for (let i = 31; i >= 0; i--) {
    if ((bits >>> i) & 1) cidr++
    else break
  }
  return cidr
}

/**
 * True when `value` is a valid IPv4 address (four octets 0–255). Used by the UI
 * for a live validity hint and to block submit on malformed input.
 */
export function isValidIpv4(value: string): boolean {
  return Ipv4Schema.safeParse(value.trim()).success
}

/**
 * Clamp a raw string to a legal partial-or-complete IPv4 / dotted-decimal mask
 * as the user types: keep only digits and dots, drop a leading dot, collapse
 * repeated dots, allow at most 4 octets, each at most 3 digits and capped at
 * 255. Shared by the IP and mask inputs so both lock input the same way.
 */
export function sanitizeIpv4Input(raw: string): string {
  let s = raw.replace(/[^\d.]/g, '')
  s = s.replace(/^\.+/, '').replace(/\.{2,}/g, '.')
  const octets = s.split('.').slice(0, 4).map((p) => {
    let o = p.slice(0, 3)
    if (o !== '' && Number(o) > 255) o = '255'
    return o
  })
  return octets.join('.')
}
