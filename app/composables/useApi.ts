// MOCK STUB — replaced by real envelope-aware fetch in task 13.1. Callers must
// not change when swapped.
//
// Every method returns the UNWRAPPED payload (the resource data itself, or a
// Paginated<T> for list endpoints) — exactly what the real useApi() will return
// after it unwraps the { success, data } API envelope. This keeps every caller
// (pages built in tasks 2.4-2.8) stable across the swap: only the internals of
// this file change in task 13.1, never the call sites.
//
// This stub reads from the static fixtures in ~/utils/mock-data and does simple
// in-memory search/filter/paging so the pagination and search UI work now. No
// $fetch, no backend, no database.

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
  RouteResponse,
  RoleCode,
  UpdateAclInput,
  UpdateRouteInput,
  UpdateUserInput,
  UserResponse,
  UserStatus,
} from '~/utils/api-types'
import {
  mockAcls,
  mockAuditLogs,
  mockDashboardSummary,
  mockRoutes,
  mockUsers,
} from '~/utils/mock-data'

// Small artificial latency so loading states are visible during the mock phase.
const MOCK_DELAY_MS = 150

function resolve<T>(value: T): Promise<T> {
  return new Promise((res) => setTimeout(() => res(value), MOCK_DELAY_MS))
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
    auth: {
      me(): Promise<AuthMe> {
        const admin = mockUsers[0]!
        return resolve({
          user: admin,
          permissions: [
            'USER_READ',
            'USER_MANAGE',
            'ACL_READ',
            'ACL_CREATE',
            'ACL_UPDATE',
            'ACL_DELETE',
            'ROUTE_READ',
            'ROUTE_CREATE',
            'ROUTE_UPDATE',
            'ROUTE_DELETE',
            'AUDIT_READ',
            'AUDIT_EXPORT',
          ],
        })
      },
      login(_credentials: LoginCredentials): Promise<AuthMe> {
        const admin = mockUsers[0]!
        return resolve({ user: admin, permissions: ['ADMIN'] })
      },
      logout(): Promise<void> {
        return resolve(undefined)
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

    users: {
      list(params?: ListParams): Promise<Paginated<UserResponse>> {
        let rows = filterByStatus(mockUsers, params?.status)
        rows = rows.filter((u) =>
          matchesSearch([u.username, u.displayName], params?.search),
        )
        return resolve(paginate(rows, params))
      },
      get(id: string): Promise<UserResponse | undefined> {
        return resolve(mockUsers.find((u) => u.id === id))
      },
      create(_input: CreateUserInput): Promise<UserResponse> {
        return resolve(mockUsers[0]!)
      },
      update(id: string, _input: UpdateUserInput): Promise<UserResponse> {
        return resolve(mockUsers.find((u) => u.id === id) ?? mockUsers[0]!)
      },
      changeRole(id: string, _roleCode: RoleCode): Promise<UserResponse> {
        return resolve(mockUsers.find((u) => u.id === id) ?? mockUsers[0]!)
      },
      setStatus(id: string, _status: UserStatus): Promise<UserResponse> {
        return resolve(mockUsers.find((u) => u.id === id) ?? mockUsers[0]!)
      },
      resetPassword(_id: string, _password: string): Promise<void> {
        return resolve(undefined)
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
