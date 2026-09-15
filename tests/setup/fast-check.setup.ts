import * as fc from 'fast-check'

/**
 * Enforce the project-wide property-testing convention: every fast-check
 * property runs a minimum of 100 iterations (design Testing Strategy).
 * Individual tests may raise numRuns, but the global default guarantees the floor.
 */
export const PBT_MIN_RUNS = 100

fc.configureGlobal({ numRuns: PBT_MIN_RUNS })
