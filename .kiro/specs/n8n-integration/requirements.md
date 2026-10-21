# Requirements Document — n8n Integration

## Introduction

This spec is the single authoritative document for how NetOps Policy Manager
delegates the **execution** of ACL and route operations to an external **n8n**
automation workflow, and how it turns each operation into an auditable, redacted,
correlation-tracked record. It is the contract between the application (operator
interface + audit system of record) and n8n (the executor that reaches network
devices through an SSH jump host).

Key architectural facts:

- The application never opens a device session. It sends **field payloads** (not
  rendered command strings) to n8n over an authenticated webhook; n8n composes
  and runs the actual device command.
- For add/delete, the application shows a **redacted command preview** built from
  a static template so the engineer can review intent. The preview is
  display-only and is never sent to n8n.
- The per-engineer **execution credentials** are forwarded to n8n so it can act
  as that engineer, but they are never persisted for add/delete and never
  returned to the client; they appear only as `***` in previews and audit.
- A single **correlation id** ties one operation together across the chain:
  Web request → n8n execution → device command → device response.
- There are **no ACL/route configuration-state tables**. Every show/add/delete
  produces one master `audit_logs` row; for ACL/ROUTE it may also write one
  `acl_logs` / `route_logs` audit-detail row. Those detail tables are documented
  authoritatively in the `log-trail/` spec; this spec summarizes them and
  cross-links.

System-wide concepts (architecture, layering, envelope, correlation id, config)
live in the `general/` spec. The ACL/ROUTE workflow lives in the
`netops-policy-manager/` spec. The iTop ticket integration — including the
server-side ticket-existence guard that runs before an execute reaches n8n — is
documented authoritatively in the `ticketing-itop/` spec and only summarized
here (Requirement 12).

## Glossary

- **N8N_Client**: The single server-side component that calls n8n (`server/network/n8n-client.ts`). Nothing else in the application talks to n8n.
- **N8N_Executor**: The external n8n workflow(s) that receive a field payload, connect to the target device via the SSH jump host, run the command, and return the result.
- **Webhook_Endpoint**: An n8n webhook URL that receives one operation, resolved per operation as `<N8N_BASE_URL>/<module>/<action>` in lowercase (e.g. `<base>/acl/show`, `<base>/route/add`).
- **Field_Payload**: The JSON body the application sends to n8n for one operation — the operator's field values plus the execution credentials. It contains no rendered command string and no correlation id (the correlation id travels in a header).
- **Execution_Credentials**: The per-engineer device `user` / `pass` used so n8n can act as that engineer. For add/delete they are supplied per operation and never persisted; for reads they are the Device_Session_Credentials (Requirement 11). Never returned to the client except via the owner's reveal, never logged, redacted to `***` in previews/audit.
- **Device_Session_Credentials**: The engineer's device username/password, entered once on the ACL/Route show page and held AES-256-GCM-encrypted on that engineer's session row for the lifetime of the login session (no separate TTL). Auto-filled by the server for read operations, revealed only to the owner, removed on clear/logout/expiry, never audited.
- **N8N_API_Key**: A shared secret held by the application (server-side, from `N8N_API_KEY`) and by n8n, sent on every call in the `X-NetOps-Internal-Key` header to authenticate the app to n8n.
- **Correlation_Id**: A UUID generated per operation, sent to n8n in the `x-correlation-id` header, and stored on the audit log.
- **N8nResult**: The normalized result the N8N_Client returns: `{ status: SUCCESS | FAILED, output?, error?, message?, total?, items?, device? }`.

## Requirements

### Requirement 1: Delegated execution over an authenticated webhook

**User Story:** As a network engineer, I want the app to hand my ACL/route operation to n8n securely, so that execution happens on the real device without the app itself touching it.

#### Acceptance Criteria

1. THE N8N_Client SHALL be the only component in the application that issues requests to n8n; services SHALL reach n8n exclusively through it.
2. WHEN the N8N_Client calls a Webhook_Endpoint, THE N8N_Client SHALL authenticate the application to n8n with the `X-NetOps-Internal-Key` header set to `N8N_API_KEY`.
3. THE N8N_Client SHALL send the request to the URL resolved from `N8N_BASE_URL` as `<base>/<module>/<action>` (lowercase, singular `acl`/`route`), handling a base with or without a trailing slash, and SHALL never place the Execution_Credentials in a URL or query string.
4. THE N8N_Client SHALL send a Field_Payload as the request body and SHALL NOT send a rendered command string; the N8N_Executor composes and runs the device command.
5. THE application SHALL keep the N8N_API_Key server-side only and SHALL never expose it to the client or place it in `runtimeConfig.public`.
6. THE application SHALL NOT open any SSH/NETCONF/API session to a device; all device access SHALL occur inside the N8N_Executor.

### Requirement 2: Operation set and endpoint mapping

**User Story:** As an integrator, I want a clear mapping between app operations and n8n endpoints, so that each ACL/route action routes to the correct workflow.

#### Acceptance Criteria

1. THE integration SHALL support six operations: ACL show, ACL add, ACL delete, route show, route add, and route delete.
2. THE N8N_Client SHALL route each operation to `<base>/<module>/<action>`, i.e. `POST <base>/acl/show`, `/acl/add`, `/acl/delete`, `/route/show`, `/route/add`, `/route/delete`.
3. THE show operations SHALL be treated as read-only and SHALL execute without a confirmation step in the app.
4. THE add and delete operations SHALL be treated as configuration-changing and SHALL require a preview + explicit confirmation in the app before the N8N_Client is called.

### Requirement 3: Correlation id propagation

**User Story:** As a compliance auditor, I want one id linking a request to its execution and device response, so that I can trace any operation end to end.

#### Acceptance Criteria

1. WHEN an operation begins, THE application SHALL generate a unique Correlation_Id (UUID) for it.
2. THE N8N_Client SHALL send the Correlation_Id to n8n in the `x-correlation-id` HTTP header on every call.
3. THE application SHALL record the Correlation_Id on the audit log for that operation.
4. THE Correlation_Id SHALL be queryable in the Log Trail so all records of one operation can be retrieved together (log-trail spec).

### Requirement 4: Field payloads per operation

**User Story:** As an integrator, I want defined (but flexible) field payloads per operation, so that n8n receives exactly what it needs to build each command.

The browser form collects more than the webhook needs (masks entered separately, a required `changeTicket`); the service maps the fields down to the contract below before calling n8n. `source`/`destination` are joined `"IP MASK"` strings.

#### Acceptance Criteria

1. THE application SHALL validate the operator's fields with the shared Zod schemas before building any Field_Payload.
2. THE ACL add and ACL delete Field_Payload SHALL be `{ user, pass, source, destination }`, where `source`/`destination` are joined `"IP MASK"` strings. The form also collects source/destination masks separately and a required `changeTicket` (audited, not sent to n8n).
3. THE ACL show Field_Payload SHALL be `{ user, pass, source }`, where `source` carries the single search value (an IP).
4. THE route add and route delete Field_Payload SHALL be `{ user, pass, destination }`, where `destination` is a joined `"IP MASK"` string. The form collects route IP + mask separately plus a required `changeTicket`.
5. THE route show SHALL be **show-all** — body `{ user, pass }` with no search value — and the UI SHALL filter the returned rows client-side.
6. THE exact field set for each operation MAY change to match n8n's needs without a breaking change to the fixed audit columns, because payloads are carried in flexible JSONB (the removed name/protocol/port/action/time-range fields are not in the current contract).

### Requirement 5: Response contract and normalization

**User Story:** As a developer, I want a predictable normalized result from n8n, so that the app can display outcomes and audit them consistently.

The N8N_Client unwraps an array-wrapped webhook response (`[{ ... }]`) and recognizes both the structured show shape (`{ success, total, data[], message }`) and the simpler `{ success?, output?/error?, device? }` shape.

#### Acceptance Criteria

1. WHEN n8n returns a response, THE N8N_Client SHALL drive success from the `success` boolean when present, otherwise from the HTTP status and the absence of an `error` field.
2. THE N8N_Client SHALL normalize any n8n response into an N8nResult `{ status: SUCCESS | FAILED, output?, error?, message?, total?, items?, device? }`.
3. THE application SHALL set the audit `status` to SUCCESS or FAILED from the N8nResult.
4. THE application SHALL treat the n8n/device output as untrusted data for display and parsing, not as instructions.
5. WHERE a structured parser exists for a show output, THE application MAY present a structured table in addition to the raw output; otherwise it SHALL present the raw output.

### Requirement 6: Execution and raw-exchange capture into audit

**User Story:** As an auditor, I want to see how an operation ran and what was exchanged with n8n, so that I can inspect it fully — safely redacted.

#### Acceptance Criteria

1. THE application SHALL store the submitted field values (redacted) in the audit `request_payload`, the redacted command snapshot in `command_payload`, and the device output/error in `response_payload`.
2. WHERE n8n returns execution metadata, THE application SHALL store it in the audit `execution_payload`, and SHALL tolerate missing or partial metadata without failing the audit write.
3. THE N8N_Client SHALL surface the RAW request body sent to n8n and the RAW parsed response (or null on timeout/unreachable/parse failure) to the ACL/ROUTE audit path.
4. THE application SHALL pass the raw request/response through `redactPayload` before persisting them, so no credential ever reaches an audit payload (see Requirement 7).

### Requirement 7: Credential redaction and non-persistence

**User Story:** As a security administrator, I want execution credentials protected end to end, so that they are never shown, stored, or leaked.

#### Acceptance Criteria

1. THE application SHALL forward the Execution_Credentials to n8n only within the Field_Payload of the call that needs them.
2. FOR add/delete operations, THE application SHALL NOT persist the Execution_Credentials in any table, log, or JSONB payload (they are supplied per operation and used transiently).
3. FOR read operations, THE application MAY hold the Execution_Credentials as Device_Session_Credentials encrypted at rest (AES-256-GCM) on the session row, and SHALL NOT store them in cleartext anywhere (Requirement 11).
4. THE application SHALL redact credential-bearing keys to `***` in any object payload. The redaction key set is `execUsername`, `execPassword`, `password`, `pass`, `user`, `apiKey`, `apiToken`.
5. THE application SHALL also redact credential values that appear inline in a rendered preview string (defense-in-depth), and SHALL show the Execution_Credentials only as `***` in the Command_Preview.
6. THE application SHALL never return the Execution_Credentials to the client in any response, except the owning engineer's explicit reveal of their own Device_Session_Credentials (Requirement 11).
7. THE application SHALL never log the Execution_Credentials, the N8N_API_Key, or any device SSH credential.

### Requirement 8: Timeouts, errors, and resilience

**User Story:** As an operator, I want failed or slow executions handled safely, so that I always get a clear outcome and a complete audit record.

#### Acceptance Criteria

1. THE N8N_Client SHALL bound every call to n8n with an `AbortController` timeout from `N8N_TIMEOUT_MS`.
2. IF the N8N_Client cannot reach n8n, the request times out, or n8n returns a non-success response, THEN THE N8N_Client SHALL resolve to a FAILED N8nResult with a safe message (`n8n request timed out` / `n8n is unreachable`) and SHALL NOT throw, so the application can record a FAILED audit log capturing the error.
3. WHEN an operation fails for any reason, THE application SHALL return a safe API error to the client that excludes the Execution_Credentials, the N8N_API_Key, internal URLs, and stack traces.
4. THE application SHALL still generate and record the Correlation_Id for a failed operation.
5. THE application SHALL NOT automatically retry a configuration-changing operation (add/delete) on timeout, to avoid duplicate device changes.

### Requirement 9: Static command preview templates

**User Story:** As a network engineer, I want the previewed command to reflect what will run, so that I can review intent before executing.

#### Acceptance Criteria

1. THE application SHALL maintain four static Command_Templates — ACL add, ACL delete, route add, route delete — in `server/network/command-templates.ts`.
2. WHEN building a Command_Preview, THE application SHALL substitute the submitted field values into the matching template; credentials are not interpolated into the command lines.
3. THE Command_Preview SHALL be produced on the server and returned to the client for display only.
4. THE Command_Preview SHALL NOT be sent to n8n and SHALL NOT be the basis of execution; n8n composes the executed command from the Field_Payload.
5. WHERE a Command_Template diverges from what n8n actually runs, THE application SHALL treat the preview as indicative; keeping the template aligned is a maintenance goal, not a correctness guarantee.

### Requirement 10: Configuration

**User Story:** As an operator, I want n8n connection settings validated at startup, so that misconfiguration fails fast and safely.

#### Acceptance Criteria

1. THE application SHALL read the n8n settings from environment: `N8N_BASE_URL`, `N8N_API_KEY`, and `N8N_TIMEOUT_MS`.
2. WHEN the application starts, THE Config_Service SHALL validate these variables with the Zod `EnvSchema` and SHALL halt startup if a required n8n variable is missing or invalid (general spec, Req 7).
3. THE `.env.example` SHALL contain placeholder entries (without real values) for the n8n variables.
4. THE application SHALL keep `N8N_API_KEY` out of `runtimeConfig.public` and out of every client response.

### Requirement 11: Device Session Credentials (read operations)

**User Story:** As a network engineer, I want to enter my device username/password once per login and have every read use it automatically until I log out, so that I don't re-type it for each lookup — while it stays protected.

Read operations call n8n frequently, so requiring credentials on every call is impractical. An engineer sets them once per login session; the backend validates them once, then auto-fills them for reads for the life of the session. Add/delete are not covered here (Requirement 7.2). The service is `server/services/device-credential.service.ts`.

#### Acceptance Criteria

1. WHEN an authenticated engineer submits their device `execUsername` and `execPassword` to `POST /api/session/device-credentials`, THE application SHALL first validate them against the n8n `POST <base>/user/validate` webhook (with the `X-NetOps-Internal-Key` header), and only on `success: true` SHALL store them encrypted with AES-256-GCM on that engineer's session row.
2. IF the `user/validate` call returns `success: false`, is unreachable, or times out, THEN THE application SHALL reject the set request with the returned message (or a safe generic error) and SHALL NOT store any credentials.
3. THE application SHALL scope the Device_Session_Credentials to the engineer's own session only; another user's session SHALL never see or use them.
4. THE Device_Session_Credentials SHALL remain valid for the lifetime of the login session with no separate TTL; they are present while the session is valid and absent once it ends. (A `device_cred_expires_at` column exists from the initial migration but is unused.)
5. WHEN an engineer performs a read operation and Device_Session_Credentials exist, THE application SHALL decrypt them server-side and use them as the Execution_Credentials for the n8n call, without the client resending them and without re-validating.
6. IF a read operation is attempted with no Device_Session_Credentials, THEN THE application SHALL reject it with `DEVICE_CREDENTIALS_REQUIRED` and prompt the engineer to enter them.
7. WHEN the owning engineer calls `GET /api/session/device-credentials/reveal`, THE application SHALL return the decrypted values to that engineer only, and SHALL NOT expose them to any other user.
8. WHEN the engineer calls `DELETE /api/session/device-credentials`, THE application SHALL clear the Device_Session_Credentials from the session row immediately.
9. WHEN the engineer logs out or the session ends/expires, THE application SHALL ensure the Device_Session_Credentials are gone (they live on the session row and are removed with it).
10. THE application SHALL never write the Device_Session_Credentials (cleartext or encrypted) to any audit log, and SHALL never log them.
11. THE `GET /api/session/device-credentials` endpoint SHALL return only a non-secret status `{ set, username? }`; the password is returned only via the explicit owner reveal in criterion 7.
12. THE add/delete operations SHALL NOT auto-fill from the Device_Session_Credentials; they SHALL require the credentials per operation (Requirement 7.2).

### Requirement 12: ACL/Route audit-detail tables (summary; authoritative in log-trail/)

**User Story:** As a compliance auditor, I want deeper execution-inspection detail for ACL and route operations, so that I can inspect what each call did without changing the device-config boundary.

The `acl_logs` / `route_logs` audit-detail tables are documented authoritatively
in the `log-trail/` spec. This spec records only the n8n-side facts that produce
them.

#### Acceptance Criteria

1. THE application SHALL continue to record every ACL/ROUTE show/add/delete as one master `audit_logs` row; the detail tables SHALL NOT replace that master trail.
2. FOR an ACL operation THE application MAY write one `acl_logs` row, and FOR a route operation one `route_logs` row, in the SAME database transaction as the master row, linked by `audit_id` (FK → `audit_logs.id`, `ON DELETE CASCADE`) and `correlation_id`.
3. THE application SHALL redact every JSONB value written to a detail row and SHALL NEVER store a credential in a detail row.
4. THE application SHALL expose read-only, authenticated endpoints that require no feature permission: `GET /api/acl-logs`, `GET /api/acl-logs/correlation/:id`, `GET /api/route-logs`, `GET /api/route-logs/correlation/:id` (full schema and UI in the log-trail spec).

### Requirement 13: Server-side iTop ticket-existence guard on execute (summary; authoritative in ticketing-itop/)

**User Story:** As a security administrator, I want the server to confirm the supplied change ticket exists before any ACL/Route add or delete runs, so that a direct API call cannot execute against a fake but well-formed ticket ref.

This is the n8n-side view of the guard documented authoritatively in the
`ticketing-itop/` spec. It runs in the ACL/ROUTE service layer before the
N8N_Client is called.

#### Acceptance Criteria

1. WHEN an engineer executes an ACL or ROUTE add/delete, THE service SHALL, as the FIRST step before building the preview, calling n8n, or writing any audit row, verify the supplied `changeTicket` exists in iTop (via `getTicketByRef`).
2. IF the ticket is not found, THEN THE service SHALL reject with `TICKET_NOT_FOUND` (HTTP 404) and SHALL NOT call n8n and SHALL NOT write any audit row.
3. IF iTop is unconfigured, unreachable, or times out, THEN THE service SHALL reject with `ITOP_UNREACHABLE` (HTTP 503) and SHALL NOT call n8n and SHALL NOT write any audit row (block-total posture).
4. THE guard SHALL apply to EXECUTE only (ACL/ROUTE add + delete); show and preview SHALL be unchanged.

### Requirement 14: Connectivity probe (Test n8n)

**User Story:** As an administrator, I want a Test n8n Connection diagnostic, so that I can confirm the integration is reachable without running a device operation.

#### Acceptance Criteria

1. WHEN an administrator triggers the n8n test, THE application SHALL run `pingN8n`, a `N8N_TIMEOUT_MS`-bounded GET of the n8n origin root (scheme + host), with NO API key on the wire and no webhook triggered.
2. THE probe SHALL report an HTTP status `>= 500` as degraded (`ok: false`); only a sub-500 response SHALL count as reachable.
3. THE `POST /api/n8n/test` endpoint SHALL require `assertSameOrigin` + `requirePermission(ADMINISTRATION_MANAGE)`, and its button SHALL be visible only when `canManage` is true (ticketing-itop and user-management specs).
4. THE probe SHALL return a `ConnectionTestResult` `{ ok, message }` and SHALL never leak the API key.

### Requirement 15: Existing time-range catalog (read-only `time/show`)

**User Story:** As a network engineer, I want to pick an ACL time range from the objects that already exist on the device, so that I can reuse a pre-approved window without re-entering a date and time.

The ACL Add page offers a "Select Existing" time-range mode (netops-policy-manager spec, Req 7a). To populate its dropdown, the application reads the device's existing time-range objects from a new read-only n8n webhook. This is a passive catalog fetch — it changes no device state and writes no audit row.

#### Acceptance Criteria

1. THE N8N_Client SHALL expose a bespoke helper (`fetchTimeRanges`) that issues `GET <N8N_BASE_URL>/time/show` with the `X-NetOps-Internal-Key: N8N_API_KEY` header, bounded by an `AbortController` timeout from `N8N_TIMEOUT_MS`, deriving the URL from `N8N_BASE_URL` (trailing slash tolerated) and never hardcoding it.
2. THE helper SHALL tolerate an array-wrapped response (`[{ ... }]`) by unwrapping the first element before validating, exactly as the POST path's `normalize` does.
3. THE helper SHALL validate the response with a Zod schema whose envelope is `{ success?, message?, total?, data[] }` and whose each `data` row is `{ name, type?, start_date?, start_time?, end_date?, end_time?, end_local?, raw_config? }` (every field except `name` nullable/optional; `data` defaulting to `[]`).
4. THE helper SHALL NEVER throw: on any network/timeout/parse/validation failure or a non-success response it SHALL resolve to an empty object list plus a safe flag/message (`Time range request timed out` / `n8n is unreachable` / `Could not load existing time ranges`), and SHALL never log the N8N_API_Key.
5. THE application SHALL map each raw row to the clean client shape `{ name, endDate, endTime, rawConfig }` (snake_case → camelCase; `undefined` coalesced to `null`) and SHALL NOT return raw n8n rows to the client.
6. THE application SHALL expose the catalog at `GET /api/acl/time-ranges`, a thin handler gated by `assertSameOrigin` + `requirePermission(ACL_POLICIES_ADD)` that returns `{ objects }` via the standard envelope; because the helper never throws, a failed fetch still returns HTTP 200 with an empty list and the Add page falls back to "Create New".

### Requirement 16: Time-range usage check on ACL delete (read-only `time/isUsed`)

**User Story:** As a network engineer, when I delete an ACL whose rule references a time-range object, I want to be warned if that object is still used by OTHER ACL rules, so that I notice before removing a shared window.

The ACL Delete "Generate" step, after confirming the rule exists, reads the matched rule's time-range object name from its rendered command and asks n8n whether that object is still used elsewhere. This is a passive usage probe — it changes no device state and writes no audit row. The resulting warning is advisory and never blocks the delete.

#### Acceptance Criteria

1. THE N8N_Client SHALL expose a bespoke helper (`checkTimeRangeUsage`) that issues `POST <N8N_BASE_URL>/time/isUsed` with body `{ user, pass, timeObject: [names] }` and the `X-NetOps-Internal-Key: N8N_API_KEY` header, bounded by an `AbortController` timeout from `N8N_TIMEOUT_MS`, deriving the URL from `N8N_BASE_URL` (trailing slash tolerated). The `user`/`pass` are the device credentials typed on the delete page; they are NEVER logged.
2. THE helper SHALL tolerate an array-wrapped response, and SHALL validate it with a Zod schema whose envelope is `{ success?, message?, total?, data[] }` and whose each `data` row is `{ name, is_used?, usage_count?, raw_commands[] }` (`raw_commands` defaulting to `[]`).
3. THE helper SHALL NEVER throw: on any network/timeout/parse/validation failure or a non-success response it SHALL resolve to an empty usage list plus a safe message, so the delete flow proceeds WITHOUT the warning.
4. THE application SHALL map each raw row to the clean client shape `{ name, isUsed, usageCount, rawCommands }` and SHALL NOT return raw n8n rows to the client.
5. THE application SHALL expose the check at `POST /api/acl/time-range-usage`, a thin handler gated by `assertSameOrigin` + `requirePermission(ACL_POLICIES_DELETE)` (POST, so credentials never appear in the URL/logs) that returns `{ usages }` via the standard envelope.
6. THE time-range object name SHALL be derived client-side from the matched rule's rendered command as the token following the final `time-range ` (the device renders a time-bound rule as `... time-range <name>` at the end of the line). WHERE the matched rule has no time range, the usage check SHALL be skipped.
7. THE warning SHALL list only the OTHER rules still using the object — the raw command(s) of the rule being deleted (either direction) SHALL be excluded before deciding whether to warn; the warning SHALL appear only when at least one other rule remains. The warning is advisory and SHALL NOT block generate or execute.

## Non-Functional Requirements

### Security

1. THE integration SHALL authenticate every call to n8n with the N8N_API_Key and SHALL prefer HTTPS for the webhook transport.
2. THE integration SHALL never store the Execution_Credentials in cleartext; add/delete credentials are transient, and read-path Device_Session_Credentials are AES-256-GCM-encrypted on the session row (using `MFA_ENCRYPTION_KEY`), never exposed except via the owner's reveal, and never written to audit or logs.
3. THE integration SHALL never persist or expose the N8N_API_Key or the device SSH credentials configured inside n8n.
4. THE integration SHALL treat all n8n/device output as untrusted data.

### Reliability

1. THE integration SHALL bound every n8n call with `N8N_TIMEOUT_MS`.
2. THE integration SHALL always produce an audit log for an attempted operation (except a pre-execution ticket-existence rejection, which writes none — Requirement 13), whether it succeeds or fails.

### Maintainability

1. THE integration SHALL isolate all n8n interaction behind the N8N_Client and keep the four Command_Templates in one place, so payload/endpoint/preview changes do not ripple into the request or audit layers.

## Out of Scope

1. Building, hosting, or versioning the n8n workflows themselves.
2. Storing the device SSH credentials configured inside n8n (those live in n8n; the read-path Device_Session_Credentials are a separate, encrypted, session-scoped convenience — Requirement 11).
3. Persisting ACL/route configuration state as a source of truth (the ACL/Route list is fetched live from n8n show). This is distinct from the `acl_logs`/`route_logs` audit-detail tables, which record what an operation did.
4. Rendering and sending an executable command string to n8n (only field payloads are sent).
5. Automatic retry/rollback of device changes beyond what Requirement 8.5 allows.
6. Auto-filling add/delete operations from the Device_Session_Credentials (those remain per-operation).
