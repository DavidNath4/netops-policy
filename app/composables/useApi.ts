// Envelope-aware API layer. Every method returns the UNWRAPPED payload (the
// resource, or Paginated<T>) — the { success, data } envelope is unwrapped here
// so callers never see it. All endpoints are real; ACL/route data comes live
// from n8n, and dashboard/logs come from audit_logs.

import type {
  AdminUserResponse,
  AuthMe,
  CreateUserInput,
  ListParams,
  LoginCredentials,
  Paginated,
  RoleOption,
  UpdateUserInput,
} from '~/utils/api-types'
import type { AclExecuteInput, AclPreviewInput } from '#shared/schemas/acl.schema'
import type { RouteExecuteInput, RoutePreviewInput } from '#shared/schemas/route.schema'
import type { DeviceCredentialsInput, OperationResult } from '#shared/schemas/n8n.schema'
import type { AuditResponse } from '#shared/schemas/audit.schema'
import type { AclLogResponse, RouteLogResponse } from '#shared/schemas/exec-log.schema'

/** Activity/execution dashboard summary (server: dashboard.service.ts). */
interface DashboardSummary {
  totalExecutions: number
  successCount: number
  failedCount: number
  perModule: { module: string, count: number }[]
  recentActivities: AuditResponse[]
  failedRecent: AuditResponse[]
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

export function useApi() {
  return {
    // Auth mirror (the authoritative flow lives in useAuth()).
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

    // ACL operations via n8n (search/preview/execute).
    aclOps: {
      show(search: string): Promise<OperationResult> {
        return apiSend<OperationResult>('/api/acl/show', 'POST', { search })
      },
      preview(input: AclPreviewInput): Promise<{ preview: string, command: string[] }> {
        return apiSend<{ preview: string, command: string[] }>('/api/acl/preview', 'POST', input)
      },
      execute(input: AclExecuteInput): Promise<OperationResult> {
        return apiSend<OperationResult>('/api/acl/execute', 'POST', input)
      },
    },

    // Route operations via n8n (search/preview/execute).
    routeOps: {
      show(search: string): Promise<OperationResult> {
        return apiSend<OperationResult>('/api/route/show', 'POST', { search })
      },
      preview(input: RoutePreviewInput): Promise<{ preview: string, command: string[] }> {
        return apiSend<{ preview: string, command: string[] }>('/api/route/preview', 'POST', input)
      },
      execute(input: RouteExecuteInput): Promise<OperationResult> {
        return apiSend<OperationResult>('/api/route/execute', 'POST', input)
      },
    },

    // Device Session Credentials (read-path convenience for ACL/Route search).
    deviceCredentials: {
      status(): Promise<{ set: boolean, username?: string }> {
        return apiGet<{ set: boolean, username?: string }>('/api/session/device-credentials')
      },
      set(input: DeviceCredentialsInput): Promise<{ set: boolean }> {
        return apiSend<{ set: boolean }>('/api/session/device-credentials', 'POST', input)
      },
      reveal(): Promise<{ username: string, password: string }> {
        return apiGet<{ username: string, password: string }>('/api/session/device-credentials/reveal')
      },
      clear(): Promise<{ set: boolean }> {
        return apiSend<{ set: boolean }>('/api/session/device-credentials', 'DELETE')
      },
    },

    // Dashboard summary from audit_logs.
    dashboard: {
      summary(): Promise<DashboardSummary> {
        return apiGet<DashboardSummary>('/api/dashboard/summary')
      },
    },

    // Log Trail from audit_logs.
    audit: {
      list(params?: Record<string, unknown>): Promise<Paginated<AuditResponse>> {
        return apiGet<Paginated<AuditResponse>>('/api/audit', params)
      },
      get(id: string): Promise<AuditResponse> {
        return apiGet<AuditResponse>(`/api/audit/${id}`)
      },
      export(params?: Record<string, unknown>): Promise<AuditResponse[]> {
        return apiGet<AuditResponse[]>('/api/audit/export', params)
      },
    },

    // ACL execution-inspection detail logs (complement to audit_logs).
    aclLogs: {
      list(params?: Record<string, unknown>): Promise<Paginated<AclLogResponse>> {
        return apiGet<Paginated<AclLogResponse>>('/api/acl-logs', params)
      },
      byCorrelation(correlationId: string): Promise<AclLogResponse[]> {
        return apiGet<AclLogResponse[]>(`/api/acl-logs/correlation/${correlationId}`)
      },
    },

    // ROUTE execution-inspection detail logs (complement to audit_logs).
    routeLogs: {
      list(params?: Record<string, unknown>): Promise<Paginated<RouteLogResponse>> {
        return apiGet<Paginated<RouteLogResponse>>('/api/route-logs', params)
      },
      byCorrelation(correlationId: string): Promise<RouteLogResponse[]> {
        return apiGet<RouteLogResponse[]>(`/api/route-logs/correlation/${correlationId}`)
      },
    },

    // Administration user management (RBAC-guarded on the server).
    users: {
      list(params?: ListParams): Promise<Paginated<AdminUserResponse>> {
        return apiGet<Paginated<AdminUserResponse>>('/api/users', {
          page: params?.page,
          limit: params?.limit,
          search: params?.search,
        })
      },
      create(input: CreateUserInput): Promise<AdminUserResponse> {
        return apiSend<AdminUserResponse>('/api/users', 'POST', input)
      },
      update(id: string, input: UpdateUserInput): Promise<AdminUserResponse> {
        return apiSend<AdminUserResponse>(`/api/users/${id}`, 'PATCH', input)
      },
      changeRole(id: string, roleCode: string): Promise<AdminUserResponse> {
        return apiSend<AdminUserResponse>(`/api/users/${id}/role`, 'PATCH', { roleCode })
      },
      setStatus(id: string, isActive: boolean): Promise<AdminUserResponse> {
        return apiSend<AdminUserResponse>(`/api/users/${id}/status`, 'PATCH', { isActive })
      },
      async resetPassword(id: string, password: string): Promise<void> {
        await apiSend<unknown>(`/api/users/${id}/reset-password`, 'POST', { password })
      },
    },

    // Active roles for the Administration role dropdown.
    roles: {
      list(): Promise<{ roles: RoleOption[] }> {
        return apiGet<{ roles: RoleOption[] }>('/api/roles')
      },
    },
  }
}
