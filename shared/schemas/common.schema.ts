import { z } from 'zod'

// Cross-cutting shared shapes: pagination and the correlation id used to link
// one operation across Web App request -> n8n execution -> device -> response.

/** A correlation id (UUID) linking a single operation end to end. */
export const CorrelationIdSchema = z.string().uuid()
export type CorrelationId = z.infer<typeof CorrelationIdSchema>

/**
 * Server-side pagination query. `limit` is clamped to a max so a client cannot
 * request an unbounded page; `page` is at least 1.
 */
export const PaginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().max(256).optional(),
})
export type PaginationQuery = z.infer<typeof PaginationQuerySchema>

/** Standard paginated envelope for list responses. */
export interface Paginated<T> {
  items: T[]
  page: number
  limit: number
  total: number
}
