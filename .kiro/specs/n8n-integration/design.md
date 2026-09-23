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
Vue form ──POST /api/{acl|routes}/{show|preview|execute}──▶ Nitro handler
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

The app sends the operator's validated fields plus `correlationId` and the execution credentials. Field sets are the app↔n8n contract and may be tuned; the audit columns do not change when they do (Req 4.7). Example bodies (illustrative — the credential fields are sent to n8n but redacted before any preview/audit):

**ACL ADD**
```json
{
  "module": "ACL",
  "action": "ADD",
  "correlationId": "3f1c…",
  "name": "KSEI-JMP",
  "source": "10.100.100.100",
  "source_mask": "255.255.255.255",
  "destination": "10.200.200.200",
  "destination_mask": "255.255.255.255",
  "protocol": "TCP",
  "port": 443,
  "action_type": "ALLOW",
  "time_range": "31-May-26",
  "change_ticket": "CHG-123456",
  "execUsername": "engineer1",
  "execPassword": "…"
}
```

**ACL SHOW**
```json
{ "module": "ACL", "action": "SHOW", "correlationId": "3f1c…", "filter": "10.131.10.111", "execUsername": "engineer1", "execPassword": "…" }
```

**ROUTE ADD**
```json
{
  "module": "ROUTE",
  "action": "ADD",
  "correlationId": "9a2e…",
  "name": "to-dc2",
  "destination": "10.200.0.0/16",
  "next_hop": "10.71.34.1",
  "policy": "default",
  "time_range": "31-May-26",
  "change_ticket": "CHG-123457",
  "execUsername": "engineer1",
  "execPassword": "…"
}
```

Delete payloads carry the identifying fields (ACL: name/source/destination; route: destination/next_hop) plus the ticket, correlation id, and credentials (Req 4.3, 4.5).

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

The client maps these to `N8nResult`. The service then writes the audit log (below). Device output is treated as untrusted for display/parsing (Req 5.5); a structured parser is optional and additive (Req 5.6).

## Audit mapping (Req 6, and main spec Req 8)

For one show/execute, the service records one `audit_logs` row:

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
export const ACL_ADD_TEMPLATE = (f) => [
  `terminal pager 0`,
  `access-list ${f.name} permit ${f.protocol.toLowerCase()} ${f.source} ${f.source_mask ?? ''} ${f.destination} ${f.destination_mask ?? ''}${f.port ? ' eq ' + f.port : ''}`.trim(),
  `exit`,
]
export const ACL_DELETE_TEMPLATE = (f) => [
  `terminal pager 0`,
  `no access-list ${f.name} permit ip ${f.source} ${f.destination}`,
  `exit`,
]
export const ROUTE_ADD_TEMPLATE = (f) => [
  `ip route ${f.destination} ${f.next_hop}`,
]
export const ROUTE_DELETE_TEMPLATE = (f) => [
  `no ip route ${f.destination}${f.next_hop ? ' ' + f.next_hop : ''}`,
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
| `N8N_BASE_URL` | Base URL for the n8n webhook(s). Per-operation paths derive from it, or a single webhook + `{module,action}` discriminator is used. |
| `N8N_API_KEY` | Shared secret sent on every call; server-side only, never in `runtimeConfig.public` or any response. |
| `N8N_TIMEOUT_MS` | Per-call timeout (default 15000). |

`.env.example` carries placeholders for all three (Req 10.3). Startup halts if a required n8n var is missing/invalid (Req 10.2).

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

*For any* n8n call, the request carries the N8N_API_Key header; and for any client response or audit payload, the N8N_API_Key does not appear.

**Validates: Requirements 1.2, 1.5, 7.6, 10.4**

## Testing Strategy

Unit and integration tests use Vitest with the N8N_Client (or global `fetch`) mocked — no real n8n and no device is contacted.

### Unit tests

- `redactPayload` / `redactText` mask `execUsername`/`execPassword` (Property 2).
- `preview.ts` renders each of the four templates and the preview contains `***` in place of credentials, with no n8n side effect (Property 1, main Property 11).
- N8N_Client response normalization: success shape → SUCCESS, failure shape → FAILED, non-2xx → FAILED, timeout → FAILED, correlation-id mismatch → FAILED (Properties 3, 4).

### Integration tests (handlers + mocked N8N_Client)

- `show`/`execute` write one audit log carrying the correlation id, with redacted payloads (Properties 2, 3, 4).
- Mocked n8n success → `OperationResult` SUCCESS with raw output; mocked n8n error/timeout → FAILED with a safe error and no credentials (Properties 4, 5).
- The n8n request includes the API-key header and never the API key in the response/audit (Property 5).
- Permission gating: `show` requires `*_SHOW`, `execute`/`preview` require `*_ADD` or `*_DELETE` per `operation`.

## Boundaries (what this design does NOT do)

- It does not define or host the n8n workflows; it only calls their webhooks per this contract.
- It does not store device credentials or ACL/route configuration state.
- It does not send or execute rendered command strings; n8n composes the command from the field payload.
- It does not auto-retry configuration-changing operations beyond the guardrail in Requirement 8.5.
