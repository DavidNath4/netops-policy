# Design Document — n8n Integration

## Overview

This document details how NetOps Policy Manager delegates ACL/route execution to n8n and records each operation as an audit log. It refines the ACL/route/command/audit sections of the main design (`.kiro/specs/netops-policy-manager/design.md`) with the concrete n8n contract: the `N8N_Client`, the per-operation field payloads, the API-key auth, the correlation id, the response normalization, the credential redaction, and the four static preview templates.

Design principles carried from the main spec:

- The app is the operator interface + audit system of record; n8n is the executor. The app never touches a device.
- The app sends **field payloads**, not command strings. n8n composes and runs the device command.
- Execution credentials are forwarded to n8n but never persisted, never returned, always `***` in preview/audit.
- One correlation id links request → n8n → device command → response, stored on the audit log.
- Webhook payload/response shapes are flexible (carried in JSONB) and can evolve with n8n without altering the fixed audit columns.

## Architecture

### Where it sits

```
Vue form ──POST /api/{acl|route}/{show|preview|execute}──▶ Nitro handler
                                                              │ requirePermission
                                                              ▼
                                                        AclService / RouteService
                                          preview? ──▶ command-templates + redact ──▶ { preview } (display only)
                                          show/execute? ──▶ N8N_Client
                                                              │ HTTPS + API key header + correlationId
                                                              ▼
                                                        n8n Webhook_Endpoint
                                                              │
                                                              ▼
                                                     SSH jump host → device
                                                              │
                                          N8N_Result ◀── normalize ◀── n8n response
                                                              │
                                          AuditService.record(redacted payloads, status, correlationId) ──▶ PostgreSQL
```

`preview` never calls n8n and writes no audit. `show` and `execute` call n8n and write exactly one audit log (SUCCESS/FAILED).

### Component boundary — `server/network/`

```
server/network/
├── n8n-client.ts          # the ONLY caller of n8n
├── command-templates.ts   # 4 static preview templates (ACL/route × add/delete)
├── preview.ts             # render template + fields → preview string
└── redact.ts              # replace exec credentials with ***
```

## N8N_Client

```typescript
// server/network/n8n-client.ts
import { z } from 'zod'

// Normalized result the rest of the app consumes (no secrets).
export interface N8nResult {
  status: 'SUCCESS' | 'FAILED'
  output?: string                 // raw device output on success
  error?: string                  // safe error message on failure
  execution?: {                   // Execution_Metadata, best-effort (Req 6)
    executor?: string
    workflowId?: string
    executionId?: string
    startedAt?: string
    finishedAt?: string
    durationMs?: number
  }
  device?: string                 // device identifier reported by n8n
  correlationId?: string          // echoed back by n8n, if provided
}

export interface N8nOperation {
  module: 'ACL' | 'ROUTE'
  action: 'SHOW' | 'ADD' | 'DELETE'
}

export interface N8nClient {
  run(op: N8nOperation, fieldPayload: Record<string, unknown>, correlationId: string): Promise<N8nResult>
}
```

Behavior of `run`:

1. Resolve the Webhook_Endpoint for `op` from config (per-operation URL, or a single URL + `{module, action}` discriminator — Req 2.2, 2.3).
2. POST the body `{ ...fieldPayload, module, action, correlationId }` with headers:
   - `Authorization` (or `x-api-key`, matching the n8n workflow) = `N8N_API_KEY` (Req 1.2, 1.5).
   - `x-correlation-id` = `correlationId` (also inside the body) (Req 3.2).
   - `Content-Type: application/json`.
3. Abort at `N8N_TIMEOUT_MS` (Req 8.1).
4. Map the response into `N8nResult`:
   - 2xx with a success shape → `{ status: 'SUCCESS', output, execution, device, correlationId }` (Req 5.1, 5.3).
   - 2xx with a failure shape, or non-2xx, or a body error → `{ status: 'FAILED', error, execution?, device? }` (Req 5.2, 5.3, 8.2).
   - network error / timeout → `{ status: 'FAILED', error: 'n8n unreachable' | 'n8n timeout' }` (Req 8.2).
5. If n8n echoes a `correlationId` that differs from the one sent → force `status: 'FAILED'` (Req 3.4).

The client never throws credential-bearing errors upward; the `error` string is a safe, generic message (Req 8.3).

## Field payloads per operation (Req 4)

> **Current contract (source of truth = code).** The n8n webhooks take a small,
> fixed body per operation. The URL is per-operation (`<base>/<module>/<action>`,
> lowercase, singular `acl`/`route`); the correlation id travels in the
> `x-correlation-id` header, not the body. The browser form collects more fields
> than the webhook needs (masks are entered separately, a change ticket, etc.),
> but the service maps them down to the contract below before calling n8n.
> `source`/`destination` are **joined `"IP MASK"` strings** (a missing mask
> defaults to `255.255.255.255`). Credential fields are sent to n8n but redacted
> to `***` in every preview/audit copy.

**ACL ADD / DELETE** — `POST <base>/acl/add` · `<base>/acl/delete`. Body:
```json
{
  "user": "Busisa.Bhp",
  "pass": "…",
  "source": "10.100.100.100 255.255.255.255",
  "destination": "10.200.200.200 255.255.255.255"
}
```
The form fields are `source`, `sourceMask`, `destination`, `destinationMask`,
and an optional `changeTicket` (audited, not sent to n8n). The service joins
IP + mask into the `source`/`destination` strings above.

**ACL SHOW** — `POST <base>/acl/show`. Body is exactly:
```json
{ "user": "Busisa.Bhp", "pass": "…", "source": "10.71.34.107" }
```
Response maps `success`→status, `data[]`→`items` (table: ACL Name / Action /
Protocol / Source / Destination / Service), `total`, `message`.

**ROUTE ADD / DELETE** — `POST <base>/route/add` · `<base>/route/delete`. Body:
```json
{
  "user": "Busisa.Bhp",
  "pass": "…",
  "destination": "10.100.100.100 255.255.255.255"
}
```
The form fields are `routeIp`, `routeMask`, and an optional `changeTicket`; the
service joins them into the single `destination` string.

**ROUTE SHOW** — `POST <base>/route/show`. **Show-all**: body is only
`{ "user": "…", "pass": "…" }` (no search value in the contract). The webhook
returns the full route table; the UI filters it client-side. Response:
```json
{ "success": true, "found": true, "total": 1, "data": [
  { "raw": "route LAB-AWS 10.100.100.100 255.255.255.255 10.100.100.5 1",
    "interface": "LAB-AWS", "destination": "10.100.100.100",
    "mask": "255.255.255.255", "gateway": "10.100.100.5", "metric": 1 } ],
  "message": "Route found" }
```
The route table shows **Destination / Mask / Gateway** columns; the selected
row's `raw` command is shown in a RawCommandBox. The device credentials for all
show calls come from the Device Session Credentials (`user`/`pass`), not the
browser body.

Field sets are the app↔n8n contract and may be tuned without changing the fixed
audit columns (Req 4.7). Fields removed from the earlier draft (ACL
name/protocol/port/action/time_range; route name/next_hop/policy/time_range) are
not part of the current dev-phase contract and are added back only if the
webhooks require them.

### Add/Delete existence pre-check

Before an add/delete is previewed/executed, the UI runs a client-side existence
check via the module's show endpoint (`useOpsPrecheck`):

- **ADD** blocks with a warning if the entry **already exists** (nothing to add).
- **DELETE** blocks with a warning if the entry **does not exist** (nothing to delete).

Matchers are per module: ACL matches the **source + destination pair**; Route
matches the **route IP** against each row's `destination`. This is a UI
guardrail (defense-in-depth); the server still re-validates and audits.

## Response contract & normalization (Req 5)

n8n responses are flexible; the client tolerates variation and normalizes. Recognized shapes:

**Success**
```json
{ "device": "10.71.34.1", "output": "Access-list added successfully", "execution": { "executor": "n8n", "workflowId": "workflow-001", "executionId": "123456", "startedAt": "2026-09-23T08:00:00", "finishedAt": "2026-09-23T08:00:03", "durationMs": 3000 } }
```

**Failure**
```json
{ "device": "10.71.34.1", "error": "SSH connection timeout" }
```

**Route add/delete (confirmed shape).** The route webhooks return a flag-driven
result the client normalizes by `success`:
```json
{ "success": true,  "operation": "add",    "sshCode": 255, "reachedDevice": true, "message": "Route add command accepted",     "error": null }
{ "success": false, "operation": "delete", "sshCode": 255, "reachedDevice": true, "message": "ASA rejected route delete command", "error": "ERROR: %No matching route to delete" }
```
`success: false` → FAILED, surfacing `error` (fallback `message`). The extra
fields (`operation`, `sshCode`, `reachedDevice`) are carried in the response
payload but do not change the normalized status.

The client maps these to `N8nResult`. The service then writes the audit log (below). Device output is treated as untrusted for display/parsing (Req 5.5); a structured parser is optional and additive (Req 5.6).

## Audit mapping (Req 6, Req 12, and main spec Req 8)

For one show/execute, the service records one master `audit_logs` row (and, for ACL/ROUTE, optionally one detail row — see "ACL/Route audit-detail tables" below):

| Audit field | Source |
|---|---|
| `module` / `action` | the operation (`ACL`/`ROUTE`, `SHOW`/`ADD`/`DELETE`) |
| `status` | `N8nResult.status` (SUCCESS/FAILED) |
| `correlation_id` | the generated Correlation_Id |
| `user_id` / `username` / `user_role` | actor snapshot |
| `source_ip` / `user_agent` | request context |
| `request_payload` | submitted fields, **redacted** (no creds) |
| `command_payload` | redacted command snapshot, e.g. `{ device, command: ["access-list KSEI-JMP permit ip …"] }` |
| `execution_payload` | `N8nResult.execution` (executor, workflow_id, execution_id, timings) |
| `response_payload` | `{ device, output }` or `{ device, error }` |

Missing/partial execution metadata does not fail the write (Req 6.4). Redaction runs before the write, so no payload ever contains cleartext credentials (Req 7.2, 7.4).

## ACL/Route audit-detail tables (Req 12)

`audit_logs` remains the system-of-record and records **all** modules, including every ACL and ROUTE operation. On top of it, two **audit-detail** tables — `acl_logs` and `route_logs` — hold deeper execution-inspection detail for the sensitive ACL/ROUTE operations. They **complement** `audit_logs`; they do not replace it, and they are **not** ACL/route configuration-state tables (the app still stores no device config and still delegates execution to n8n).

Each detail row is written in the **same DB transaction** as its master `audit_logs` row (so a detail row never exists without its master) and links back to it two ways: by `audit_id` (FK → `audit_logs.id`, `ON DELETE CASCADE`) and by the operation's `correlation_id`.

```
server/services/acl.service.ts / route.service.ts
   └─ one tx ─▶ insert audit_logs (master, redacted)         ──▶ audit.id
               └─▶ insert acl_logs / route_logs (detail, redacted, audit_id, correlation_id)
```

### Schema

```
database/schema/acl-logs.ts     → acl_logs
database/schema/route-logs.ts   → route_logs
database/schema/index.ts        → re-export + shared enums exec_log_action / exec_log_status
shared/schemas/exec-log.schema.ts → client Zod shapes
```

Shared enums: `exec_log_action` (`SHOW` | `ADD` | `DELETE`), `exec_log_status` (`SUCCESS` | `FAILED`).

**`acl_logs`** columns: `id` (uuid pk), `audit_id` (fk → `audit_logs.id`, cascade), `correlation_id`, `action` (exec_log_action), `status` (exec_log_status), `device`, `source`, `destination`, `command_preview` (jsonb), `execution_meta` (jsonb), `response_summary` (jsonb), `created_at`. Indexes: `audit_id`, `correlation_id`, `created_at`.

**`route_logs`** columns: identical to `acl_logs` except `change_ticket` replaces `source` (and is indexed) while `destination` is kept. Indexes: `audit_id`, `correlation_id`, `created_at`, `change_ticket`.

All three JSONB columns pass through `redactPayload` before the write, so a detail row — like the master row — never contains a credential or password (Req 12.7).

### Read path

Repositories `server/repositories/acl-log.repository.ts` + `route-log.repository.ts` (insert + paginated query + by-correlation lookup; no delete/mutate) feed read services `server/services/acl-log.service.ts` + `route-log.service.ts`. The read-only, authenticated endpoints (no feature permission, mirroring `/api/audit`) are:

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/api/acl-logs` | valid session | Paginated ACL execution-detail list. |
| GET | `/api/acl-logs/correlation/:id` | valid session | ACL detail rows for one correlation id. |
| GET | `/api/route-logs` | valid session | Paginated route execution-detail list. |
| GET | `/api/route-logs/correlation/:id` | valid session | Route detail rows for one correlation id. |

The Log Trail detail modal uses the by-correlation endpoints to show an "Execution Inspection" section for ACL/ROUTE audit rows. There is no endpoint that deletes or mutates detail rows (Req 12.9). This added one generate+migrate step (`db:generate` → `db:migrate`), applied and verified in the dev DB.

## Redaction (Req 7)

```typescript
// server/network/redact.ts
const CRED_KEYS = ['execUsername', 'execPassword', 'password'] as const

// Redact by key in an object payload (request/command payload).
export function redactPayload<T extends Record<string, unknown>>(p: T): T { /* replace CRED_KEYS values with '***' */ }

// Redact by value in a rendered preview string (defense in depth: if a credential
// value would appear inline in the previewed command, mask it).
export function redactText(text: string, creds: { execUsername?: string; execPassword?: string }): string
```

- The credentials are placed into the Field_Payload sent to n8n **before** any redaction step and are stripped for preview/audit copies (Req 7.1, 7.3, 7.4).
- The credentials are never returned to the client and never logged (Req 7.5, 7.6).

## Static preview templates (Req 9)

```typescript
// server/network/command-templates.ts — illustrative shapes, kept aligned with n8n's intent.
// src/dst are joined "IP MASK" strings (mask optional).
export const renderAclAdd = (f) => [
  `terminal pager 0`,
  `access-list extended permit ip ${f.source} ${f.sourceMask ?? ''} ${f.destination} ${f.destinationMask ?? ''}`.replace(/\s+/g, ' ').trim(),
  `exit`,
]
export const renderAclDelete = (f) => [
  `terminal pager 0`,
  `no access-list extended permit ip ${f.source} ${f.sourceMask ?? ''} ${f.destination} ${f.destinationMask ?? ''}`.replace(/\s+/g, ' ').trim(),
  `exit`,
]
export const renderRouteAdd = (f) => [
  `ip route ${f.routeIp}${f.routeMask ? ' ' + f.routeMask : ''}`,
]
export const renderRouteDelete = (f) => [
  `no ip route ${f.routeIp}${f.routeMask ? ' ' + f.routeMask : ''}`,
]
```

`preview.ts` picks the template by `{module, action}`, renders it with the operator's fields, and passes the result through `redactText`. The output is returned as `{ preview }` for the terminal box and is **never** sent to n8n (Req 9.3, 9.4). These templates are indicative for review; keeping them aligned with the actual n8n command is a maintenance goal (Req 9.5).

## Timeouts & error handling (Req 8)

- Every `run` aborts at `N8N_TIMEOUT_MS`.
- Unreachable / timeout / non-2xx / body-error → `FAILED` `N8nResult`; the service still writes a FAILED audit log with the correlation id (Req 8.2, 8.4).
- The handler returns an `OperationResult` `{ correlationId, status: 'FAILED', output: null, error }` where `error` is safe (no creds, no API key, no internal URL, no stack) (Req 8.3).
- Add/delete are not auto-retried on timeout, to avoid duplicate device changes (Req 8.5).

## Configuration (Req 10)

Env consumed by this integration (validated by the main spec's `EnvSchema`):

| Var | Purpose |
|---|---|
| `N8N_BASE_URL` | Base of the n8n webhooks. The client appends `/<module>/<action>` (lowercase), e.g. `<base>/acl/show`, `<base>/route/add`. A trailing slash on the base is handled. |
| `N8N_API_KEY` | Shared secret sent on every call in the `X-NetOps-Internal-Key` header; server-side only, never in `runtimeConfig.public` or any response. |
| `N8N_TIMEOUT_MS` | Per-call timeout (default 15000; deployment may raise it, e.g. 35000, for slower device operations). |

The six per-operation endpoints are: `POST <base>/acl/show`, `/acl/add`, `/acl/delete`, `/route/show`, `/route/add`, `/route/delete`. `.env.example` carries placeholders (Req 10.3). Startup halts if a required n8n var is missing/invalid (Req 10.2).

## Device Session Credentials (read operations) (Req 11)

Read operations (ACL/Route show/list/search/detail) call n8n often, so the engineer sets their device credentials once per session and the backend auto-fills them. They are stored **encrypted on the session row**, short-lived, owner-scoped, and never audited.

### Storage

One column is added to `sessions` (see main spec):

- `device_cred_encrypted` (text, nullable) — the AES-256-GCM ciphertext of `{ username, password }`, using the existing `MFA_ENCRYPTION_KEY` and the same crypto helper as TOTP secrets. No cleartext is ever stored.

The credentials live for the lifetime of the login session — there is **no separate TTL**. Living on the `sessions` row means logout / session deletion / session expiry remove them automatically (Req 11.9). (A `device_cred_expires_at` column exists from the initial migration but is unused; it is left in place to avoid a needless migration and may be dropped later.)

### Validation on set

Setting credentials first validates them against n8n so only working credentials are stored:

- `POST <N8N_BASE_URL>/user/validate` with header `X-NetOps-Internal-Key`, body `{ user, pass }`.
- Response `{ success: boolean, message: string }`. Only `success: true` proceeds to encrypt + store; otherwise the set is rejected with the message and nothing is stored (Req 11.1, 11.2, 11.13).
- Validation happens **once, at set time** — reads do not re-validate (Req 11.5).

### Service (`server/services/device-credential.service.ts`)

```typescript
setDeviceCredentials(db, event, { username, password })   // (validated by the handler first) encrypt + store
getDeviceCredentials(db, event): { username, password } | null  // decrypt if present, else null (valid for the session's life)
clearDeviceCredentials(db, event)                          // null out the column
deviceCredentialStatus(db, event): { set: boolean, username? } // non-secret status for the UI
```

- No TTL gate — credentials are valid as long as the session is (Req 11.4).
- Encryption reuses the AES-256-GCM helper (`server/utils/crypto.ts`, `MFA_ENCRYPTION_KEY`).
- The `user/validate` call goes through the N8N_Client (`validateDeviceCredentials`), same API-key header and timeout as other n8n calls.

### Endpoints

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | `/api/session/device-credentials` | valid session | Validate via `user/validate`, then (on success) encrypt + store for the session. Rejects on invalid credentials. |
| GET | `/api/session/device-credentials` | valid session | Return `{ set: boolean, username?: string, expiresAt?: string }` — status only, never the password. |
| GET | `/api/session/device-credentials/reveal` | valid session (owner) | Return `{ username, password }` for the eye-toggle — owner's own session only (Req 11.6). |
| DELETE | `/api/session/device-credentials` | valid session | Clear the credentials immediately (Req 11.7). |

### Auto-fill flow

The ACL/Route **show** endpoints no longer require credentials in the body. Instead:

1. Handler resolves the session and calls `getDeviceCredentials`.
2. If none (unset/cleared/expired) → 400 `DEVICE_CREDENTIALS_REQUIRED`; the UI prompts the engineer to enter them (Req 11.5).
3. Otherwise the service injects `{ execUsername, execPassword }` into the n8n field payload for the read call (Req 11.4).

Add/delete are unchanged: they take the credentials in the request body per operation and never touch this store (Req 11.11, 7.2).

### Reveal boundary

`reveal` is the ONLY path that returns the device password to a client, and only to the engineer who owns that session. It is not logged and never appears in audit (Req 11.6, 11.9). Everything else exposes at most a boolean + username.

## Correctness Properties

### Property 1: Only field payloads reach n8n

*For any* ACL/route operation, the body sent by the N8N_Client contains the operator's field values (plus module/action/correlationId/credentials) and never a rendered command string; the Command_Preview is not included.

**Validates: Requirements 1.4, 9.4**

### Property 2: Credentials never persist or surface

*For any* operation, the recorded `audit_logs` row (all columns and all four JSONB payloads) and the `OperationResult` returned to the client contain the execution credentials only as `***`, never in cleartext.

**Validates: Requirements 7.2, 7.3, 7.4, 7.5**

### Property 3: Correlation id links the chain

*For any* operation, the same Correlation_Id is generated once, sent to n8n, and stored on the audit log; a mismatch echoed by n8n forces a FAILED status.

**Validates: Requirements 3.1, 3.2, 3.3, 3.4**

### Property 4: Every attempt is audited with a normalized status

*For any* show/execute call — success, failure, timeout, or unreachable n8n — exactly one audit log is written with `status` SUCCESS or FAILED derived from the N8N_Result.

**Validates: Requirements 5.3, 5.4, 8.2, 8.4, NFR Reliability 2**

### Property 5: API key is sent to n8n and never leaked

*For any* n8n call, the request carries the N8N_API_Key header (`X-NetOps-Internal-Key`); and for any client response or audit payload, the N8N_API_Key does not appear.

**Validates: Requirements 1.2, 1.5, 7.7, 10.4**

### Property 6: Device Session Credentials are validated, encrypted, owner-scoped, session-lived

*For any* set request, the credentials are stored only after `user/validate` returns `success: true`; the `sessions` row then holds only AES-256-GCM ciphertext (never cleartext); `getDeviceCredentials` returns a value only for the owning session and for the life of that session, and returns null after clear or logout/expiry.

**Validates: Requirements 11.1, 11.2, 11.3, 11.4, 11.8, 11.9**

### Property 7: Device credentials never enter audit or logs; revealed only to the owner

*For any* read operation using Device_Session_Credentials, no audit log or log line contains the credentials (cleartext or ciphertext); the only client path that returns the password is the owner's explicit reveal endpoint.

**Validates: Requirements 11.6, 11.9, 11.10**

## Testing Strategy

Unit and integration tests use Vitest with the N8N_Client (or global `fetch`) mocked — no real n8n and no device is contacted.

### Unit tests

- `redactPayload` / `redactText` mask `execUsername`/`execPassword` (Property 2).
- `preview.ts` renders each of the four templates and the preview contains `***` in place of credentials, with no n8n side effect (Property 1, main Property 11).
- N8N_Client response normalization: success shape → SUCCESS, failure shape → FAILED, non-2xx → FAILED, timeout → FAILED, correlation-id mismatch → FAILED (Properties 3, 4).

- `device-credential.service`: set → encrypts (no cleartext column), get → returns null when expired/absent, clear → nulls both columns (Property 6).

### Integration tests (handlers + mocked N8N_Client)

- `show`/`execute` write one audit log carrying the correlation id, with redacted payloads (Properties 2, 3, 4).
- Mocked n8n success → `OperationResult` SUCCESS with raw output; mocked n8n error/timeout → FAILED with a safe error and no credentials (Properties 4, 5).
- The n8n request includes the API-key header and never the API key in the response/audit (Property 5).
- Permission gating: `show` requires `*_SHOW`, `execute`/`preview` require `*_ADD` or `*_DELETE` per `operation`.
- A read (show/list) with no/expired Device_Session_Credentials → 400 `DEVICE_CREDENTIALS_REQUIRED`; with valid ones → n8n called with injected credentials, and the audit still shows `***` (Properties 6, 7).
- Reveal endpoint returns the password only for the owning session; device credentials appear in no audit row (Property 7).

## Boundaries (what this design does NOT do)

- It does not define or host the n8n workflows; it only calls their webhooks per this contract.
- It does not store the device SSH credentials configured inside n8n, nor ACL/route configuration state. (The `acl_logs`/`route_logs` tables above are audit detail — what an operation did — not configuration state.) The read-path Device_Session_Credentials are a separate, encrypted, session-scoped, expiring convenience.
- It does not send or execute rendered command strings; n8n composes the command from the field payload.
- It does not auto-retry configuration-changing operations beyond the guardrail in Requirement 8.5.
- It does not auto-fill add/delete from the Device_Session_Credentials.
