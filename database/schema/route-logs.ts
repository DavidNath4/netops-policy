import {
  index,
  jsonb,
  pgTable,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'

import { execLogActionEnum, execLogStatusEnum } from './acl-logs'
import { auditLogs } from './audit-logs'

/**
 * ROUTE execution-inspection detail log — a COMPLEMENT to `audit_logs`.
 *
 * Mirror of `acl_logs` for the sensitive route operations. `audit_logs` remains
 * the master system of record; this table holds the deeper inspection detail and
 * links back via `auditId` (FK, cascade) and the shared `correlationId`. Each
 * detail row is written in the SAME DB transaction as its audit row.
 *
 * The shared enums `exec_log_action` / `exec_log_status` are imported from
 * `./acl-logs` — Postgres enum names are global and must not be redefined.
 *
 * SECURITY: the three JSONB columns are written AFTER redaction. `destination`
 * holds the human-readable "IP MASK" input; `changeTicket` is a non-secret
 * reference. There is deliberately no update/delete path.
 */
export const routeLogs = pgTable(
  'route_logs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    // Master audit row this detail belongs to. CASCADE: detail dies with its master.
    auditId: uuid('audit_id').references(() => auditLogs.id, { onDelete: 'cascade' }).notNull(),
    // Links one operation across Web App request -> n8n execution -> device.
    correlationId: uuid('correlation_id').notNull(),
    action: execLogActionEnum('action').notNull(),
    status: execLogStatusEnum('status').notNull(),
    device: varchar('device', { length: 255 }),
    // Human-readable "IP MASK" destination (non-secret).
    destination: varchar('destination', { length: 255 }),
    // Optional change ticket (e.g. CHG-123456) — indexed as an inspection filter.
    changeTicket: varchar('change_ticket', { length: 64 }),
    // Redacted preview command lines (array). Null for SHOW.
    commandPreview: jsonb('command_preview'),
    // n8n execution metadata (redacted before write).
    executionMeta: jsonb('execution_meta'),
    // Redacted { total, message, output, error } summary.
    responseSummary: jsonb('response_summary'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  table => [
    index('route_logs_created_at_idx').on(table.createdAt),
    index('route_logs_correlation_id_idx').on(table.correlationId),
    index('route_logs_audit_id_idx').on(table.auditId),
    index('route_logs_change_ticket_idx').on(table.changeTicket),
  ],
)
