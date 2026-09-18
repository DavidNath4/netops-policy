/**
 * Standard API response envelope.
 *
 * Success: { success: true, data }
 * Error:   { success: false, error: { code, message, fields? } }
 *
 * Handlers wrap their results with `ok(...)`. For errors, throwing an
 * `apiError(...)` (an H3 error whose `data` is a `fail(...)` envelope) lets
 * Nitro send the correct HTTP status while keeping the body in this shape.
 */

import { createError } from 'h3'

export type ErrorCode =
  | 'INVALID_CREDENTIALS'
  | 'INVALID_VERIFICATION_CODE'
  | 'MFA_CHALLENGE_INVALID'
  | 'MFA_DEVICE_LIMIT_REACHED'
  | 'MFA_DEVICE_NOT_FOUND'
  | 'MFA_LAST_DEVICE'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'VALIDATION_ERROR'
  | 'FORBIDDEN_ORIGIN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'AD_UNREACHABLE'
  | 'ACCOUNT_DISABLED'
  | 'INTERNAL_ERROR'

export interface OkEnvelope<T> {
  success: true
  data: T
}

export interface FailEnvelope {
  success: false
  error: {
    code: ErrorCode
    message: string
    fields?: Record<string, string[]>
  }
}

export function ok<T>(data: T): OkEnvelope<T> {
  return { success: true, data }
}

export function fail(
  code: ErrorCode,
  message: string,
  fields?: Record<string, string[]>,
): FailEnvelope {
  return { success: false, error: fields ? { code, message, fields } : { code, message } }
}

/**
 * Build an H3 error that serializes to a FailEnvelope with the given HTTP
 * status. Throw it from a handler to short-circuit with a proper status code.
 */
export function apiError(
  statusCode: number,
  code: ErrorCode,
  message: string,
  fields?: Record<string, string[]>,
) {
  return createError({
    statusCode,
    data: fail(code, message, fields),
  })
}
