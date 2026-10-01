import {
  index,
  jsonb,
  pgEnum,
  pgTable,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'

import { auditLogs } from './audit-logs'

/**
 * ACL execution-inspection detail log — a COMPLEMENT to `audit_logs`.
 *
 * `audit_logs` remains the single master system of record for every module. This
 * table holds the deeper inspection detail for the sensitive ACL operations and
 * links back to its master audit row via `auditId` (FK, cascade) and the shared
 * `correlationId`. Each detail row is written in the SAME DB transaction as its
 * audit row, so the two never diverge.
 *
 * SECURITY: the three JSONB columns are written AFTER redaction — the per-engineer
 * execution credentials and any secret are never persisted; credentials appear
 * only as `***`. `source`/`destination` hold the human-readable address inputs
 * (no credentials). There is deliberately no update/delete path.
 */

// Shared enums for both acl_logs and route_logs. Declared once here and imported
// by route-logs.ts — Postgres enum names are global, so they must not be redefined.
export const execLogActionEnum = pgEnum('exec_log_action', ['SHOW', 'ADD', 'DELETE'])
export const execLogStatusEnum = pgEnum('exec_log_status', ['SUCCESS', 'FAILED'])

export const aclLogs = pgTable(
  'acl_logs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    // Master audit row this detail belongs to. CASCADE: detail dies with its
    // master (audit rows are never deleted during normal operation).
    auditId: uuid('audit_id').references(() => auditLogs.id, { onDelete: 'cascade' }).notNull(),
    // Links one operation across Web App request -> n8n execution -> device.
    correlationId: uuid('correlation_id').notNull(),
    action: execLogActionEnum('action').notNull(),
    status: execLogStatusEnum('status').notNull(),
    device: varchar('device', { length: 255 }),
    // Human-readable address inputs (non-secret).
    source: varchar('source', { length: 255 }),
    destination: varchar('destination', { length: 255 }),
    // Redacted preview command lines (array). Null for SHOW.
    commandPreview: jsonb('command_preview'),
    // n8n execution metadata (redacted before write).
    executionMeta: jsonb('execution_meta'),
    // Redacted { total, message, output, error } summary.
    responseSummary: jsonb('response_summary'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  table => [
    index('acl_logs_created_at_idx').on(table.createdAt),
    index('acl_logs_correlation_id_idx').on(table.correlationId),
    index('acl_logs_audit_id_idx').on(table.auditId),
  ],
)
