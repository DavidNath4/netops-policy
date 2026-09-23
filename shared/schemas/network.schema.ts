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
  .regex(/^[A-Za-z]+-\d+$/, 'Invalid change ticket (expected e.g. CHG-123456)')

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
