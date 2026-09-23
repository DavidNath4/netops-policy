import {
  index,
  jsonb,
  pgEnum,
  pgTable,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'

import { users } from './users'

/**
 * Audit log — the operational system of record.
 *
 * This app is an interface + audit/logging layer: it does NOT store ACL/route
 * configuration state (there are no `acl_policies`/`routes` tables). Every login,
 * user-admin change, and ACL/route operation (executed by n8n) is captured here.
 *
 * SECURITY: the four JSONB payloads and every column are written AFTER redaction —
 * the per-engineer execution credentials, the n8n API key, session tokens, and any
 * secret are never persisted; credentials appear only as `***`.
 *
 * The four JSONB columns are intentionally flexible so their shape can track n8n's
 * evolving request/response without a migration to the fixed columns.
 */
export const auditModuleEnum = pgEnum('audit_module', ['AUTH', 'USER', 'ACL', 'ROUTE', 'N8N'])
export const auditActionEnum = pgEnum('audit_action', ['LOGIN', 'SHOW', 'ADD', 'DELETE', 'UPDATE'])
export const auditStatusEnum = pgEnum('audit_status', ['SUCCESS', 'FAILED'])

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    // Nullable: a failed login may have no known user. SET NULL keeps the audit
    // row even if the user is later removed (audit rows are never deleted here).
    userId: uuid('user_id').references(() => users.userId, { onDelete: 'set null' }),
    // Snapshots at action time (survive later user/role changes).
    username: varchar('username', { length: 150 }),
    userRole: varchar('user_role', { length: 100 }),
    module: auditModuleEnum('module').notNull(),
    action: auditActionEnum('action').notNull(),
    status: auditStatusEnum('status').notNull(),
    sourceIp: varchar('source_ip', { length: 64 }),
    userAgent: varchar('user_agent', { length: 512 }),
    // Optional change ticket (e.g. CHG-123456). Promoted to a fixed, indexed
    // column (not just JSONB) because it is a Log Trail filter criterion.
    changeTicket: varchar('change_ticket', { length: 64 }),
    // Links one operation across Web App request -> n8n execution -> device.
    correlationId: uuid('correlation_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    // Flexible payloads (all redacted before write). See notes above.
    requestPayload: jsonb('request_payload'),
    commandPayload: jsonb('command_payload'),
    executionPayload: jsonb('execution_payload'),
    responsePayload: jsonb('response_payload'),
  },
  table => [
    index('audit_created_at_idx').on(table.createdAt),
    index('audit_user_id_idx').on(table.userId),
    index('audit_module_idx').on(table.module),
    index('audit_action_idx').on(table.action),
    index('audit_status_idx').on(table.status),
    index('audit_change_ticket_idx').on(table.changeTicket),
    index('audit_correlation_id_idx').on(table.correlationId),
  ],
)
