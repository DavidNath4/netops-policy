// Frontend API/domain types for the NetOps Policy Manager.
//
// These mirror the API Response schemas defined in design.md (UserResponse,
// AclResponse, RouteResponse, AuditResponse, dashboard summary) so that pages
// built on the mock data layer (tasks 2.4-2.8) share the exact shapes they will
// receive from the real backend once useApi() is wired up in task 13.1.
//
// Defined as plain TypeScript interfaces for the frontend-first phase. In the
// backend phase these shapes are the source-truth of the Zod `z.infer` response
// types; the field names/enums here are kept in sync with those schemas.

// ---------------------------------------------------------------------------
// Shared enums / unions
// ---------------------------------------------------------------------------

export type UserStatus = 'ACTIVE' | 'DISABLED'
// Real data-driven role codes (from the `roles` table). New roles can be added
// as data; this union lists the seeded ones for convenience only.
export type RoleCode = 'ADMINISTRATOR' | 'L2_ENGINEER' | 'NOC'
export type PolicyStatus = 'DRAFT' | 'ACTIVE' | 'DISABLED'
export type Protocol = 'TCP' | 'UDP' | 'ICMP' | 'ANY'
export type AclAction = 'ALLOW' | 'DENY'
export type AuditResult = 'SUCCESS' | 'FAILURE'

// ---------------------------------------------------------------------------
// Resource response shapes (mirror design.md API Response schemas)
// ---------------------------------------------------------------------------

/**
 * UserResponse — Administration user shape (real backend). One role per user
 * (roleCode/roleName null when unassigned); email is the identifier; isActive
 * is the status. Never exposes password, password hash, or session token.
 */
export interface UserResponse {
  userId: string
  email: string
  displayName: string
  roleCode: string | null
  roleName: string | null
  isActive: boolean
  lastLoginAt: string | null
  createdAt: string
  updatedAt: string
}

/** A selectable role for the Administration role dropdown. */
export interface RoleOption {
  roleCode: string
  roleName: string
}

/** AclResponse — includes server-set generatedCommand and audit fields. */
export interface AclResponse {
  id: string
  name: string
  source: string
  destination: string
  protocol: Protocol
  /** Present for TCP/UDP; omitted for ICMP/ANY. */
  port?: number
  action: AclAction
  timeStart?: string
  timeEnd?: string
  changeTicket?: string
  description?: string
  status: PolicyStatus
  generatedCommand: string
  createdBy: string
  updatedBy: string
  createdAt: string
  updatedAt: string
}

/** RouteResponse — destination is CIDR, nextHop is an IP address. */
export interface RouteResponse {
  id: string
  name: string
  destination: string
  source?: string
  nextHop: string
  policy?: string
  timeStart?: string
  timeEnd?: string
  changeTicket?: string
  status: PolicyStatus
  generatedCommand: string
  createdBy: string
  updatedBy: string
  createdAt: string
  updatedAt: string
}

/** AuditResponse — before/after/metadata are arbitrary JSON payloads. */
export interface AuditResponse {
  id: string
  timestamp: string
  actorUsername: string | null
  actorRole: string | null
  activity: string
  entityType: string | null
  entityId: string | null
  result: AuditResult
  sourceIp: string | null
  changeTicket: string | null
  beforeState: unknown
  afterState: unknown
  metadata: unknown
}

/** Dashboard summary returned by GET /api/dashboard/summary. */
export interface DashboardSummary {
  aclTotal: number
  aclActive: number
  routeTotal: number
  routeActive: number
  recentActivities: AuditResponse[]
}

/** Authenticated identity returned by GET /api/auth/me. */
export interface AuthMe {
  user: UserResponse
  permissions: string[]
}

// ---------------------------------------------------------------------------
// List / pagination shapes
// ---------------------------------------------------------------------------

/** Paginated list envelope used by every list endpoint. */
export interface Paginated<T> {
  items: T[]
  total: number
  page: number
  limit: number
}

/** Query params accepted by list endpoints. */
export interface ListParams {
  page?: number
  limit?: number
  search?: string
  status?: string
}

/** Extra filters accepted by the audit list/export endpoints. */
export interface AuditListParams extends ListParams {
  activity?: string
  result?: AuditResult
  from?: string
  to?: string
}

// ---------------------------------------------------------------------------
// Request input shapes (exclude Server_Controlled_Fields)
// ---------------------------------------------------------------------------

export interface LoginCredentials {
  username: string
  password: string
}

export type CreateAclInput = Omit<
  AclResponse,
  'id' | 'generatedCommand' | 'createdBy' | 'updatedBy' | 'createdAt' | 'updatedAt'
>
export type UpdateAclInput = Partial<CreateAclInput>

export type CreateRouteInput = Omit<
  RouteResponse,
  'id' | 'generatedCommand' | 'createdBy' | 'updatedBy' | 'createdAt' | 'updatedAt'
>
export type UpdateRouteInput = Partial<CreateRouteInput>

export interface CreateUserInput {
  email: string
  displayName: string
  password: string
  roleCode: string
}
export interface UpdateUserInput {
  displayName: string
}
