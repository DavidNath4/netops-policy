// HYBRID API layer.
//
// - auth, users, roles → REAL envelope-aware $fetch against /api/*.
// - acl, routes, audit, dashboard → still MOCK fixtures (those backends are a
//   later phase; the call sites stay identical for when they're wired up).
//
// Every method returns the UNWRAPPED payload (the resource, or Paginated<T>) —
// the real methods unwrap the { success, data } envelope; the mock ones read
// fixtures. Callers never see the envelope.

import type {
  AclResponse,
  AuditListParams,
  AuditResponse,
  AuthMe,
  CreateAclInput,
  CreateRouteInput,
  CreateUserInput,
  DashboardSummary,
  ListParams,
  LoginCredentials,
  Paginated,
  RoleOption,
  RouteResponse,
  UpdateAclInput,
  UpdateRouteInput,
  UpdateUserInput,
  UserResponse,
} from '~/utils/api-types'
import {
  mockAcls,
  mockAuditLogs,
  mockDashboardSummary,
  mockRoutes,
} from '~/utils/mock-data'
import type { AclExecuteInput, AclPreviewInput, AclShowInput } from '#shared/schemas/acl.schema'
import type { RouteExecuteInput, RoutePreviewInput, RouteShowInput } from '#shared/schemas/route.schema'
import type { OperationResult } from '#shared/schemas/n8n.schema'
import type { AuditResponse as RealAuditResponse } from '#shared/schemas/audit.schema'

/** Audit-based dashboard summary shape (server: dashboard.service.ts). */
interface AuditDashboardSummary {
  totalExecutions: number
  successCount: number
  failedCount: number
  perModule: { module: string, count: number }[]
  recentActivities: RealAuditResponse[]
  failedRecent: RealAuditResponse[]
}

// Small artificial latency so loading states are visible for the still-mock
// resources (acl/routes/audit/dashboard).
const MOCK_DELAY_MS = 150

function resolve<T>(value: T): Promise<T> {
  return new Promise((res) => setTimeout(() => res(value), MOCK_DELAY_MS))
}

interface Envelope<T> { success: boolean, data: T }

/** Unwrap the API envelope; SSR-safe (forwards cookies during server render). */
async function apiGet<T>(url: string, query?: Record<string, unknown>): Promise<T> {
  const requestFetch = useRequestFetch()
  const res = await requestFetch<Envelope<T>>(url, { query })
  return res.data
}

async function apiSend<T>(
  url: string,
  method: 'POST' | 'PATCH' | 'DELETE',
  body?: Record<string, unknown> | object,
): Promise<T> {
  const res = await $fetch<Envelope<T>>(url, { method, body: body as Record<string, unknown> })
  return res.data
}

/** Case-insensitive substring match across the given string fields. */
function matchesSearch(fields: Array<string | undefined | null>, search?: string): boolean {
  if (!search) return true
  const needle = search.trim().toLowerCase()
  if (!needle) return true
  return fields.some((f) => (f ?? '').toLowerCase().includes(needle))
}

/** Apply status filter, then in-memory paging, returning a Paginated envelope. */
function paginate<T>(all: T[], params?: ListParams): Paginated<T> {
  const page = params?.page && params.page > 0 ? params.page : 1
  const limit = params?.limit && params.limit > 0 ? params.limit : 20
  const start = (page - 1) * limit
  const items = all.slice(start, start + limit)
  return { items, total: all.length, page, limit }
}

/** Filter by an optional status value (list fixtures expose a `status` field). */
function filterByStatus<T extends { status: string }>(rows: T[], status?: string): T[] {
  if (!status) return rows
  return rows.filter((r) => r.status === status)
}

export function useApi() {
  return {
    // REAL — the authoritative auth flow lives in useAuth(); this mirror is
    // kept for any caller that reads identity/permissions via useApi.
    auth: {
      me(): Promise<AuthMe> {
        return apiGet<AuthMe>('/api/auth/me')
      },
      login(credentials: LoginCredentials): Promise<AuthMe> {
        return apiSend<AuthMe>('/api/auth/login', 'POST', credentials)
      },
      async logout(): Promise<void> {
        await apiSend<unknown>('/api/auth/logout', 'POST')
      },
    },

    dashboard: {
      summary(): Promise<DashboardSummary> {
        return resolve(mockDashboardSummary)
      },
    },

    acl: {
      list(params?: ListParams): Promise<Paginated<AclResponse>> {
        let rows = filterByStatus(mockAcls, params?.status)
        rows = rows.filter((a) =>
          matchesSearch([a.name, a.source, a.destination, a.changeTicket], params?.search),
        )
        return resolve(paginate(rows, params))
      },
      get(id: string): Promise<AclResponse | undefined> {
        return resolve(mockAcls.find((a) => a.id === id))
      },
      create(_input: CreateAclInput): Promise<AclResponse> {
        return resolve(mockAcls[0]!)
      },
      update(id: string, _input: UpdateAclInput): Promise<AclResponse> {
        return resolve(mockAcls.find((a) => a.id === id) ?? mockAcls[0]!)
      },
      remove(_id: string): Promise<void> {
        return resolve(undefined)
      },
    },

    routes: {
      list(params?: ListParams): Promise<Paginated<RouteResponse>> {
        let rows = filterByStatus(mockRoutes, params?.status)
        rows = rows.filter((r) =>
          matchesSearch([r.name, r.destination, r.source, r.nextHop, r.changeTicket], params?.search),
        )
        return resolve(paginate(rows, params))
      },
      get(id: string): Promise<RouteResponse | undefined> {
        return resolve(mockRoutes.find((r) => r.id === id))
      },
      create(_input: CreateRouteInput): Promise<RouteResponse> {
        return resolve(mockRoutes[0]!)
      },
      update(id: string, _input: UpdateRouteInput): Promise<RouteResponse> {
        return resolve(mockRoutes.find((r) => r.id === id) ?? mockRoutes[0]!)
      },
      remove(_id: string): Promise<void> {
        return resolve(undefined)
      },
    },

    // REAL — dashboard + Log Trail from audit_logs. Kept separate from the mock
    // `dashboard`/`audit` blocks above (whose shapes the current pages render)
    // until those pages are reworked to the audit-based shapes.
    dashboardReal: {
      summary(): Promise<AuditDashboardSummary> {
        return apiGet<AuditDashboardSummary>('/api/dashboard/summary')
      },
    },

    auditReal: {
      list(params?: Record<string, unknown>): Promise<Paginated<RealAuditResponse>> {
        return apiGet<Paginated<RealAuditResponse>>('/api/audit', params)
      },
      get(id: string): Promise<RealAuditResponse> {
        return apiGet<RealAuditResponse>(`/api/audit/${id}`)
      },
      export(params?: Record<string, unknown>): Promise<RealAuditResponse[]> {
        return apiGet<RealAuditResponse[]>('/api/audit/export', params)
      },
    },

    // REAL — ACL operations via n8n (show/preview/execute). The `acl` block
    // above stays mock for the list/detail view until that page is reworked;
    // these methods hit the live n8n-backed endpoints.
    aclOps: {
      show(input: AclShowInput): Promise<OperationResult> {
        return apiSend<OperationResult>('/api/acl/show', 'POST', input)
      },
      preview(input: AclPreviewInput): Promise<{ preview: string, command: string[] }> {
        return apiSend<{ preview: string, command: string[] }>('/api/acl/preview', 'POST', input)
      },
      execute(input: AclExecuteInput): Promise<OperationResult> {
        return apiSend<OperationResult>('/api/acl/execute', 'POST', input)
      },
    },

    // REAL — Route operations via n8n (show/preview/execute).
    routeOps: {
      show(input: RouteShowInput): Promise<OperationResult> {
        return apiSend<OperationResult>('/api/routes/show', 'POST', input)
      },
      preview(input: RoutePreviewInput): Promise<{ preview: string, command: string[] }> {
        return apiSend<{ preview: string, command: string[] }>('/api/routes/preview', 'POST', input)
      },
      execute(input: RouteExecuteInput): Promise<OperationResult> {
        return apiSend<OperationResult>('/api/routes/execute', 'POST', input)
      },
    },

    // REAL — Administration user management (RBAC-guarded on the server).
    users: {
      list(params?: ListParams): Promise<Paginated<UserResponse>> {
        return apiGet<Paginated<UserResponse>>('/api/users', {
          page: params?.page,
          limit: params?.limit,
          search: params?.search,
        })
      },
      create(input: CreateUserInput): Promise<UserResponse> {
        return apiSend<UserResponse>('/api/users', 'POST', input)
      },
      update(id: string, input: UpdateUserInput): Promise<UserResponse> {
        return apiSend<UserResponse>(`/api/users/${id}`, 'PATCH', input)
      },
      changeRole(id: string, roleCode: string): Promise<UserResponse> {
        return apiSend<UserResponse>(`/api/users/${id}/role`, 'PATCH', { roleCode })
      },
      setStatus(id: string, isActive: boolean): Promise<UserResponse> {
        return apiSend<UserResponse>(`/api/users/${id}/status`, 'PATCH', { isActive })
      },
      async resetPassword(id: string, password: string): Promise<void> {
        await apiSend<unknown>(`/api/users/${id}/reset-password`, 'POST', { password })
      },
    },

    // REAL — active roles for the Administration role dropdown.
    roles: {
      list(): Promise<{ roles: RoleOption[] }> {
        return apiGet<{ roles: RoleOption[] }>('/api/roles')
      },
    },

    audit: {
      list(params?: AuditListParams): Promise<Paginated<AuditResponse>> {
        let rows = mockAuditLogs.slice()
        if (params?.activity) rows = rows.filter((a) => a.activity === params.activity)
        if (params?.result) rows = rows.filter((a) => a.result === params.result)
        if (params?.from) rows = rows.filter((a) => a.timestamp >= params.from!)
        if (params?.to) rows = rows.filter((a) => a.timestamp <= params.to!)
        rows = rows.filter((a) =>
          matchesSearch(
            [a.actorUsername, a.activity, a.entityType, a.entityId, a.sourceIp, a.changeTicket],
            params?.search,
          ),
        )
        return resolve(paginate(rows, params))
      },
      get(id: string): Promise<AuditResponse | undefined> {
        return resolve(mockAuditLogs.find((a) => a.id === id))
      },
      export(params?: AuditListParams): Promise<AuditResponse[]> {
        let rows = mockAuditLogs.slice()
        if (params?.activity) rows = rows.filter((a) => a.activity === params.activity)
        if (params?.result) rows = rows.filter((a) => a.result === params.result)
        if (params?.from) rows = rows.filter((a) => a.timestamp >= params.from!)
        if (params?.to) rows = rows.filter((a) => a.timestamp <= params.to!)
        return resolve(rows)
      },
    },
  }
}
