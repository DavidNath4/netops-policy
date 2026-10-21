import { describe, expect, it } from 'vitest'

import { aclPairExists } from '~~/server/services/acl.service'

// Unit tests for the PURE server matcher `aclPairExists`, which duplicates the
// client `findAclMatch` semantics (match on the source→destination IP PAIR
// only; mask, port, and time-range ignored). Two row shapes are supported: the
// live structured `data[]` rows ({ source: { value }, destination: { value } })
// and a raw Cisco command-string fallback (realistic lines from
// .design-ref/helper.txt).

describe('aclPairExists — structured rows', () => {
  const rows = [
    { source: { value: '10.71.37.15' }, destination: { value: '10.141.2.53' } },
    { source: { value: '10.71.37.19' }, destination: { value: '10.112.6.14' } },
  ]

  it('matches an exact source→destination pair', () => {
    expect(aclPairExists(rows, '10.71.37.15', '10.141.2.53')).toBe(true)
  })

  it('ignores surrounding whitespace on the search values', () => {
    expect(aclPairExists(rows, '  10.71.37.15 ', ' 10.141.2.53')).toBe(true)
  })

  it('does not match a different pair', () => {
    expect(aclPairExists(rows, '10.71.37.15', '10.112.6.14')).toBe(false)
  })

  it('does not match the reversed pair', () => {
    expect(aclPairExists(rows, '10.141.2.53', '10.71.37.15')).toBe(false)
  })

  it('matches ignoring a mask carried elsewhere (pair is IP-only)', () => {
    const masked = [{ source: { value: '10.71.37.15' }, destination: { value: '10.141.2.53' } }]
    // The matcher never sees a mask; the caller passes bare IPs.
    expect(aclPairExists(masked, '10.71.37.15', '10.141.2.53')).toBe(true)
  })
})

describe('aclPairExists — raw command-string rows', () => {
  const rows: string[] = [
    'access-list KSEI-JMP extended permit ip host 10.71.37.15 host 10.141.2.53',
    'access-list KSEI-JMP extended permit ip host 10.71.37.12 10.16.0.0 255.255.0.0',
    'access-list KSEI-JMP extended permit ip 10.16.0.0 255.255.0.0 host 10.71.37.12',
    'access-list KSEI-JMP extended permit tcp host 10.71.35.156 host 10.111.3.3 eq www',
    'access-list KSEI-JMP extended permit ip object KSEI-PROD host 10.141.2.53',
    'access-list KSEI-JMP extended permit ip object-group T-3252 host 10.111.2.135',
    'access-list KSEI-JMP extended permit ip object KSEI-PROD any',
  ]

  it('matches a host→host line', () => {
    expect(aclPairExists(rows, '10.71.37.15', '10.141.2.53')).toBe(true)
  })

  it('matches host→network (mask dropped from the destination)', () => {
    expect(aclPairExists(rows, '10.71.37.12', '10.16.0.0')).toBe(true)
  })

  it('matches network→host (mask dropped from the source)', () => {
    expect(aclPairExists(rows, '10.16.0.0', '10.71.37.12')).toBe(true)
  })

  it('matches a tcp line, ignoring the eq port', () => {
    expect(aclPairExists(rows, '10.71.35.156', '10.111.3.3')).toBe(true)
  })

  it('ignores a trailing time-range when matching the pair', () => {
    const timed = ['access-list KSEI-JMP extended permit ip host 10.1.1.1 host 10.2.2.2 time-range MAINT-WINDOW']
    expect(aclPairExists(timed, '10.1.1.1', '10.2.2.2')).toBe(true)
  })

  it('never matches an object/object-group/any endpoint against a bare IP', () => {
    // These lines carry a KSEI-PROD object / T-3252 object-group / any as one
    // endpoint, which is not a concrete IPv4 and must never match.
    expect(aclPairExists(rows, 'KSEI-PROD', '10.141.2.53')).toBe(false)
    expect(aclPairExists(rows, 'T-3252', '10.111.2.135')).toBe(false)
    expect(aclPairExists(rows, 'KSEI-PROD', 'any')).toBe(false)
  })

  it('does not match a pair that is not present', () => {
    expect(aclPairExists(rows, '10.0.0.1', '10.0.0.2')).toBe(false)
  })
})

describe('aclPairExists — edge cases', () => {
  it('returns false for an empty list', () => {
    expect(aclPairExists([], '10.0.0.1', '10.0.0.2')).toBe(false)
  })

  it('tolerates rows with a .raw string alongside missing structured fields', () => {
    const rows = [{ raw: 'access-list KSEI-JMP extended permit ip host 10.5.5.5 host 10.6.6.6' }]
    expect(aclPairExists(rows, '10.5.5.5', '10.6.6.6')).toBe(true)
    expect(aclPairExists(rows, '10.6.6.6', '10.5.5.5')).toBe(false)
  })
})
