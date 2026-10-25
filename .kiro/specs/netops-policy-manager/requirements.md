# Requirements Document — NetOps Policy Manager (ACL & ROUTE module)

## Introduction

This spec defines the **ACL and ROUTE operations module** — the operator-facing
show / add / delete workflow for network Access Control Lists and routes. It is
the application's core feature: an engineer validates and previews an operation,
and the application delegates its execution to the external n8n automation
workflow and records the outcome as an immutable audit log. The application never
opens a device session itself and never stores device configuration state.

System-wide concepts — the architecture, request layering, API envelope,
correlation id, model layering, configuration/startup, packaging, and the shared
glossary — live in the `general/` spec and are **not** repeated here. This
document scopes down to ACL/ROUTE behavior, the network-input validation
primitives, and the ACL/ROUTE UX states.

Related specs:

- **general/** — system overview, layering, envelope, correlation id, config.
- **n8n-integration/** — the authenticated n8n webhook contract, field payloads,
  the Device Session Credentials auto-fill for reads, and the execute guard.
- **ticketing-itop/** — the read-only iTop ticket search/preview that supplies
  the required `changeTicket`, and the server-side ticket-existence guard.
- **log-trail/** — the `audit_logs` master trail and the `acl_logs` / `route_logs`
  audit-detail tables for ACL/ROUTE execution inspection.
- **rbac-permissions/** — the `ACL_POLICIES_*` and `ROUTES_*` permission catalog
  that gates these operations.

### Scope

In scope: the ACL and ROUTE show/add/delete workflow, the current simplified
field sets, the server command preview + redaction, the client-side existence
pre-check, the locked IP/mask inputs, the network-input validation schemas, and
the ACL/ROUTE UX states. Out of scope here (owned elsewhere): the n8n webhook
contract, the iTop ticket integration, authentication/RBAC, the audit schema, and
the dashboard.

## Glossary

Module-specific terms. Shared terms (`NetOps_Policy_Manager`, `Correlation_Id`,
`Redaction`, `API_Envelope`, `Data_Layer`, `API_Layer`, `Frontend`,
`Config_Service`, etc.) are defined once in the `general/` spec.

- **ACL_Service**: The server component that validates ACL requests (show/add/delete), builds the redacted command preview, delegates execution to n8n, and records the audit log. It persists no ACL configuration rows.
- **Route_Service**: The server component that does the same for route requests (show/add/delete).
- **Command_Preview**: A human-readable, client-facing string showing the command the operator's input would produce, rendered in a terminal-style box for add/delete. It is built from a static Command_Template plus the field values, is redacted, and is display/audit-only — it is NOT the payload sent to n8n and carries no ssh/sshpass transport and no credential.
- **Command_Template**: One of four static command shapes maintained in `server/network/command-templates.ts` — ACL add, ACL delete, route add, route delete — with placeholders for field values. Preview only. The lines mirror the exact device command lines n8n runs (the `echo "…"` steps inside its `configure terminal … exit` block) WITHOUT the ssh/sshpass transport or any credential, which are n8n's concern. The access-list / route list name is the fixed `KSEI-JMP`, and the route next-hop + metric are n8n's fixed values (add `192.197.120.1 1`, delete `192.197.120.1 1`); these are hardcoded in the template. The concrete per-operation shapes are enumerated in Requirement 3.
- **Acl_Ip_AutoCorrect**: The pure, idempotent prefix-rewrite applied to ACL ADD Source/Destination IPs — defined once in `shared/schemas/network.schema.ts` (`autoCorrectAclIp`) and applied on the form (on blur) and re-applied server-side. See Requirement 9.
- **Execution_Credentials**: The per-engineer device username/password forwarded to n8n so it can act as that engineer. For add/delete they are supplied per operation and never persisted; for reads they are auto-filled from the Device_Session_Credentials (n8n-integration spec, Req 11). Never returned to the client (except the owner's reveal) and never written to audit; always `***` in previews/audit.
- **Device_Session_Credentials**: The engineer's device username/password entered once per login session and held AES-256-GCM-encrypted on the session row for the life of that session, auto-filled by the server for read operations. Specified fully in the n8n-integration spec (Req 11).
- **changeTicket**: A required change-ticket reference on every ACL/ROUTE add and delete, carrying the selected iTop ticket `ref` (e.g. `C-035919`). It is audited but not sent to n8n. The ticket picker and the server-side existence guard are specified in the ticketing-itop spec.
- **Validation_Layer**: The reusable Zod schemas in `shared/schemas/network.schema.ts` used to validate network input on the form and re-validate it on the server.

## Current field contract (source of truth)

The forms collect a **simplified** field set; the earlier draft's
name/protocol/port/action/time-range/next-hop/policy fields are **not** part of
the current contract. The Zod schemas (`shared/schemas/acl.schema.ts`,
`shared/schemas/route.schema.ts`) are the source of truth:

- **ACL add/delete** collect `source`, `sourceMask` (optional), `destination`,
  `destinationMask` (optional), and a **required** `changeTicket`. ADD and DELETE
  share the same shape. The service joins IP + mask into `"IP MASK"` strings for
  the n8n body (n8n-integration spec).
- **ACL add — optional time range** (ADD only): the user may additionally attach
  a `timeRange` unit, which is a discriminated union on `mode` with TWO modes.
  - **new** — define a brand-new object: `{ mode: 'new', date: yyyy-mm-dd, time:
    HH:mm }` (time defaulting to `23:59`), from which the server derives three
    extra n8n keys — `objectName` (`dd-MMM-yyyy`, lowercase 3-letter month, e.g.
    `30-oct-2026`), `date` (`dd MonthFullEnglish yyyy`, e.g. `30 October 2026`),
    and `time` (`HH:mm`). They are sent as one unit (all three or none).
  - **existing** — reference an object that already lives on the device:
    `{ mode: 'existing', objectName }` (a non-empty, trimmed opaque name chosen
    from the device's time-range catalog, see the n8n-integration spec). The
    server sends ONLY `objectName` to n8n — never a `date` or `time` key.

  The catalog of existing objects is fetched read-only when the ACL Add page
  loads (`GET /api/acl/time-ranges`, gated by `ACL_POLICIES_ADD`; see the
  n8n-integration spec). The time range's absence means an ordinary ADD. DELETE
  never carries a time range.
- **ACL add — optional bidirectional** (ADD only): the ADD member may carry an
  optional `bidirectional` boolean. When true the server also adds the reverse
  direction (Source/Destination and their masks swapped) as a second, independent
  ACL ADD. Absent/false means an ordinary one-way ADD. DELETE and ROUTE never
  carry it. See Requirement 10.
- **ACL add — IP auto-correction** (ADD only): Source/Destination IPs are passed
  through `autoCorrectAclIp` (first-three-octet prefix remap, 4th octet kept) on
  the form and re-applied server-side before preview/audit/n8n. DELETE and ROUTE
  are never corrected. See Requirement 9.
- **ACL show** carries a single required search value (an IP). Credentials are
  not in the body — the server auto-fills them from the Device_Session_Credentials.
- **ROUTE add/delete** collect `routeIp`, `routeMask` (optional), and a
  **required** `changeTicket`. ADD and DELETE share the same shape; the service
  joins IP + mask into the single `destination` string.
- **ROUTE show** is **show-all**: no search value in the n8n contract (the schema
  accepts an optional `search` that is ignored server-side); the returned table
  is filtered client-side.

## Requirements

### Requirement 1: ACL operations (via n8n)

**User Story:** As a network engineer, I want to show, add, and delete ACLs through a guided form that previews the command and then executes it via n8n, so that I can perform ACL changes with a clear preview and a full audit trail, without this application ever touching a device directly.

The three ACL operations map to `ACL_POLICIES_SHOW`, `ACL_POLICIES_ADD`, and `ACL_POLICIES_DELETE`. SHOW is read-only and runs immediately; ADD and DELETE change device configuration and require a preview + explicit confirmation before execution. The n8n webhook contract and payload shapes are in the n8n-integration spec.

#### Acceptance Criteria

1. WHEN a user holding `ACL_POLICIES_SHOW` submits an ACL search with a required search value (an IP), THE ACL_Service SHALL auto-fill the Execution_Credentials from the user's Device_Session_Credentials, forward the search to the N8N_Client for read-only execution, and SHALL NOT require a confirmation step. ACL SHOW SHALL always carry a search value (it is per-IP search, not show-all).
2. IF an `ACL_POLICIES_SHOW` request is made with no valid Device_Session_Credentials (never set, cleared, or session ended), THEN THE ACL_Service SHALL reject it with a `DEVICE_CREDENTIALS_REQUIRED` error prompting the user to enter their device credentials, and SHALL NOT call n8n.
3. WHEN the N8N_Executor returns an ACL show result, THE ACL_Service SHALL return the device output to the Frontend (raw terminal output, and a searchable table where the result is structured) and SHALL record a SHOW audit log.
4. THE ACL_Service SHALL validate ACL add/delete input (`source`, `sourceMask?`, `destination`, `destinationMask?`, `changeTicket`) with the Validation_Layer before any preview or execution, and SHALL require a non-empty `changeTicket`.
5. WHEN a user requests a command preview for an ACL add or delete, THE ACL_Service SHALL build a Command_Preview from the matching static Command_Template and the submitted field values, and SHALL apply Redaction so the Execution_Credentials appear only as `***`.
6. WHEN a user holding `ACL_POLICIES_ADD` confirms execution of a previewed ACL add, THE ACL_Service SHALL send the field payload (with the Correlation_Id and Execution_Credentials) to the N8N_Client and SHALL record the resulting ADD audit log with status SUCCESS or FAILED based on the n8n response.
7. WHEN a user holding `ACL_POLICIES_DELETE` confirms execution of a previewed ACL delete, THE ACL_Service SHALL send the field payload (with the Correlation_Id and Execution_Credentials) to the N8N_Client and SHALL record the resulting DELETE audit log with status SUCCESS or FAILED.
7a. WHEN an ACL ADD carries the optional `timeRange` unit, THE ACL_Service SHALL branch on its `mode`: for `mode: 'new'` it SHALL derive and append exactly the three keys `objectName`, `date`, and `time` (exact formats above) to the n8n ADD body; for `mode: 'existing'` it SHALL append ONLY the chosen `objectName` (never a `date` or `time` key), so n8n reuses the already-defined on-device object. THE ACL_Service SHALL apply this ONLY to ADD (never DELETE or SHOW), and SHALL capture the raw `timeRange` (its `mode` and value) in the ADD audit request payload so either kind of time-range add is auditable. WHEN an ACL ADD carries no `timeRange`, THE ACL_Service SHALL send the body unchanged (`{ user, pass, source, destination }`) and the Validation_Layer SHALL validate it exactly as a non-time-range ADD.
8. BEFORE executing an ACL add or delete, THE ACL_Service SHALL first verify the supplied `changeTicket` exists in iTop and SHALL reject the operation (writing no audit row) if the ticket is missing or iTop cannot be reached (specified in the ticketing-itop spec).
9. THE ACL_Service SHALL send only the field payload required by n8n and SHALL NOT send the Command_Preview string to n8n.
10. THE ACL_Service SHALL NOT persist any ACL configuration row; the only ACL persistence it performs is writing audit records.
11. IF the N8N_Client cannot reach n8n, the request times out, or n8n returns an error, THEN THE ACL_Service SHALL record an audit log with status FAILED capturing the error and SHALL return a safe error to the client that excludes the Execution_Credentials.
12. THE ACL_Service SHALL exclude the raw Execution_Credentials from every audit log, storing them only as `***` within the command snapshot, and SHALL attach the same Correlation_Id to the request payload, the n8n call, and the audit log.

### Requirement 2: Route operations (via n8n)

**User Story:** As a network engineer, I want to show, add, and delete routes through a guided form that previews the command and then executes it via n8n, so that I can perform routing changes with a clear preview and a full audit trail, without this application ever touching a device directly.

The three route operations map to `ROUTES_SHOW`, `ROUTES_ADD`, and `ROUTES_DELETE`. SHOW is read-only and runs immediately; ADD and DELETE require a preview + explicit confirmation.

#### Acceptance Criteria

1. WHEN a user holding `ROUTES_SHOW` requests the route table, THE Route_Service SHALL auto-fill the Execution_Credentials from the user's Device_Session_Credentials and forward a **show-all** read (body `{ user, pass }`, no search value) to the N8N_Client, and SHALL NOT require a confirmation step. THE Frontend SHALL filter the returned rows client-side.
2. IF a `ROUTES_SHOW` request is made with no valid Device_Session_Credentials, THEN THE Route_Service SHALL reject it with a `DEVICE_CREDENTIALS_REQUIRED` error and SHALL NOT call n8n.
3. WHEN the N8N_Executor returns a route show result, THE Route_Service SHALL return the device output to the Frontend for display (Destination / Mask / Gateway columns, with the selected row's raw command available) and SHALL record a SHOW audit log.
4. THE Route_Service SHALL validate route add/delete input (`routeIp`, `routeMask?`, `changeTicket`) with the Validation_Layer before any preview or execution, and SHALL require a non-empty `changeTicket`.
5. WHEN a user requests a command preview for a route add or delete, THE Route_Service SHALL build a Command_Preview from the matching static Command_Template and the submitted field values, and SHALL apply Redaction so the Execution_Credentials appear only as `***`.
6. WHEN a user holding `ROUTES_ADD` confirms execution of a previewed route add, THE Route_Service SHALL send the field payload (with the Correlation_Id and Execution_Credentials) to the N8N_Client and SHALL record the resulting ADD audit log with status SUCCESS or FAILED.
7. WHEN a user holding `ROUTES_DELETE` confirms execution of a previewed route delete, THE Route_Service SHALL send the field payload (with the Correlation_Id and Execution_Credentials) to the N8N_Client and SHALL record the resulting DELETE audit log with status SUCCESS or FAILED.
8. BEFORE executing a route add or delete, THE Route_Service SHALL first verify the supplied `changeTicket` exists in iTop and SHALL reject the operation (writing no audit row) if the ticket is missing or iTop cannot be reached (ticketing-itop spec).
9. THE Route_Service SHALL send only the field payload required by n8n, SHALL NOT send the Command_Preview string to n8n, and SHALL NOT persist any route configuration row; the only route persistence it performs is writing audit records.
10. IF the N8N_Client cannot reach n8n, the request times out, or n8n returns an error, THEN THE Route_Service SHALL record an audit log with status FAILED capturing the error, return a safe error excluding the Execution_Credentials, and attach the same Correlation_Id to the request payload, the n8n call, and the audit log.

### Requirement 3: Command preview and delegated execution

**User Story:** As a network engineer, I want to see a redacted preview of the command before it runs and have the execution performed by n8n, so that I can review exactly what will happen while credentials stay protected and this application never touches a device.

#### Acceptance Criteria

1. THE NetOps_Policy_Manager SHALL maintain four static Command_Templates — ACL add, ACL delete, route add, route delete — with placeholders for the dynamic field values, in `server/network/command-templates.ts`.
2. WHEN building a Command_Preview, THE NetOps_Policy_Manager SHALL substitute the submitted field values into the matching Command_Template; the templates do not interpolate credentials, and Redaction masks any credential value defensively.
2a. THE Command_Templates SHALL mirror the device command lines n8n runs — the `echo "…"` steps inside a single `configure terminal … exit` block — WITHOUT the ssh/sshpass transport or any credential, using the fixed list name `KSEI-JMP` and n8n's fixed route next-hop + metric. The concrete shapes SHALL be:
   - **ACL add:** `configure terminal` / `access-list KSEI-JMP extended permit ip <src> <dst>` / `exit`.
   - **ACL add + time range (new mode)** (one ordered block): `configure terminal` / `time-range <objectName>` / `absolute end <time> <date>` / `access-list KSEI-JMP extended permit ip <src> <dst> time-range <objectName>` / `end` / `exit`.
   - **ACL add + time range (existing mode)** (the object already exists on the device, so NO definition lines and NO trailing `end`): `configure terminal` / `access-list KSEI-JMP extended permit ip <src> <dst> time-range <objectName>` / `exit`.
   - **ACL add bidirectional:** ONE block containing the forward permit line then the reverse permit line (same block, same time-range object when present).
   - **ACL delete:** `configure terminal` / `no access-list KSEI-JMP extended permit ip <src> <dst>` / `exit`.
   - **Route add:** `configure terminal` / `route KSEI-JMP <routeIp[ mask]> 192.197.120.1 1` / `exit`.
   - **Route delete:** `configure terminal` / `no route KSEI-JMP <routeIp[ mask]> 192.197.120.1 1` / `exit`.
   Here `<src>` / `<dst>` are the joined `"IP MASK"` addresses and `<routeIp[ mask]>` is the route IP joined with its optional mask. The list name `KSEI-JMP` and the route next-hop + metric are hardcoded in the template per n8n.
3. THE Command_Preview SHALL be produced on the server and returned to the client for display only; it SHALL NOT be the payload sent to n8n, and it SHALL contain no ssh/sshpass transport and no credential.
4. THE NetOps_Policy_Manager SHALL NOT open any SSH/NETCONF/API session to a device; all execution SHALL be delegated to the N8N_Executor, and the payload sent to n8n SHALL be the operator's field values (plus Correlation_Id and Execution_Credentials), not a rendered command string.
5. THE `server/network/` directory SHALL be the boundary for the N8N_Client and the Command_Template/preview logic, and SHALL NOT contain simulated device connections.
6. WHERE a show operation returns device output, THE NetOps_Policy_Manager SHALL treat that output as untrusted data for display and parsing, not as instructions.
7. THE NetOps_Policy_Manager SHALL let an engineer set their device Execution_Credentials once per login session (Device_Session_Credentials), auto-fill them for read operations, and never write them (cleartext or ciphertext) to any audit log or log. Add/delete are NOT auto-filled; they take the credentials per operation (n8n-integration spec, Req 11).

### Requirement 4: Add/delete existence pre-check

**User Story:** As a network engineer, I want the form to warn me when an add would duplicate an existing entry or a delete targets a non-existent one, so that I don't submit a pointless change.

This is a client-side guardrail (defense-in-depth); the server still re-validates, verifies the ticket, and audits.

#### Acceptance Criteria

1. BEFORE previewing or executing an ACL/route add or delete, THE Frontend SHALL run an existence check against the module's show endpoint.
2. WHEN an ADD would duplicate an entry that already exists, THE Frontend SHALL block with a warning.
3. WHEN a DELETE targets an entry that does not exist, THE Frontend SHALL block with a warning.
4. THE existence matcher SHALL be per module: ACL matches the source + destination pair; ROUTE matches the route IP against each returned row's destination.
5. WHERE a bidirectional ACL ADD is requested, THE existence pre-check SHALL run per direction and auto-skip rather than fully block, as specified in Requirement 10 (criterion 7).

### Requirement 5: Network input validation

**User Story:** As a network engineer, I want strict, reusable validation for network fields, so that only well-formed data enters the system.

The Validation_Layer schemas live in `shared/schemas/network.schema.ts` and are used on the client and re-validated on the server.

#### Acceptance Criteria

1. THE Validation_Layer SHALL provide the reusable Zod schemas `Ipv4Schema`, `IpAddressSchema` (IPv4 or IPv6), `CidrSchema` (CIDR v4 or v6), `PortSchema`, `ProtocolSchema`, `AclActionSchema`, `ChangeTicketSchema`, `TimeRangeSchema`, `DescriptionSchema`, and `MaskSchema`.
2. WHEN input is validated by `Ipv4Schema`, THE Validation_Layer SHALL accept a syntactically valid IPv4 address and reject any other value.
3. WHEN input is validated by `CidrSchema`, THE Validation_Layer SHALL accept valid CIDR (v4 or v6) and reject any other value.
4. WHEN input is validated by `IpAddressSchema`, THE Validation_Layer SHALL accept a valid IPv4 or IPv6 address.
5. WHEN input is validated by `PortSchema`, THE Validation_Layer SHALL accept an integer within 1..65535 inclusive and reject any value outside that range.
6. WHEN input is validated by `ProtocolSchema`, THE Validation_Layer SHALL accept only `TCP`, `UDP`, `ICMP`, and `ANY`.
7. WHEN input is validated by `AclActionSchema`, THE Validation_Layer SHALL accept only `ALLOW` and `DENY`.
8. WHEN input is validated by `ChangeTicketSchema`, THE Validation_Layer SHALL require a trimmed, non-empty reference of at most 64 characters.
9. WHEN input is validated by `MaskSchema`, THE Validation_Layer SHALL require a trimmed, non-empty value of at most 64 characters.
10. THE Validation_Layer SHALL cap `DescriptionSchema` at 1000 characters and `TimeRangeSchema` at 64 characters.

> Note: `ProtocolSchema`, `AclActionSchema`, `PortSchema`, `TimeRangeSchema`, and
> `DescriptionSchema` remain in the Validation_Layer as reusable primitives even
> though protocol/port/action/time-range are not in the current ACL/ROUTE form
> contract; the ACL/ROUTE request schemas do not reference them today.

### Requirement 6: No ACL/route configuration state

**User Story:** As a developer, I want it to be impossible to treat this application as the source of truth for device configuration, so that the audit-only boundary is preserved.

#### Acceptance Criteria

1. THE Data_Layer SHALL NOT define any `acl_policies` or `routes` configuration-state table; the application stores no network device configuration.
2. THE only ACL/ROUTE persistence THE application performs SHALL be the master `audit_logs` row and, for ACL/ROUTE execution detail, the `acl_logs` / `route_logs` audit-detail rows (log-trail spec).
3. THE live state of ACLs and routes SHALL be reached only through n8n read (`show`) operations.

### Requirement 7: ACL/ROUTE API endpoints

**User Story:** As a client developer, I want a stable, singular endpoint shape per operation, so that the ACL/route pages have a predictable contract.

#### Acceptance Criteria

1. THE API_Layer SHALL expose the singular ACL endpoints `POST /api/acl/show`, `POST /api/acl/preview`, and `POST /api/acl/execute`.
2. THE API_Layer SHALL expose the singular route endpoints `POST /api/route/show`, `POST /api/route/preview`, and `POST /api/route/execute`.
3. THE show endpoints SHALL be gated by `*_SHOW`; preview and execute SHALL be gated by `*_ADD` or `*_DELETE` according to the submitted `operation`.
4. THE preview and execute endpoints SHALL accept only the ADD/DELETE discriminated-union request shapes; SHOW SHALL have no preview.
5. Every ACL/ROUTE mutation endpoint SHALL apply the same-origin check (`assertSameOrigin`) in addition to the permission check.

### Requirement 8: ACL/ROUTE UX states and inputs

**User Story:** As an operator, I want clear interface states and locked network inputs, so that I can perform operations reliably and cannot submit malformed addresses.

#### Acceptance Criteria

1. THE Frontend SHALL provide loading, empty, and error states for the ACL and route data pages (via the shared `LoadingState` / `EmptyState` / `ErrorState` components).
2. IF an API request for a data page fails, THEN THE Frontend SHALL display an error state rather than a blank screen.
3. THE IP and mask inputs SHALL accept digits and dots only, clamp each octet to ≤255 and to at most four octets, show a live validity / CIDR badge, and block submit while the IP is invalid.
4. WHEN a user completes an add or delete form and requests a preview, THE Frontend SHALL display the redacted Command_Preview in a terminal-style box and change the primary action from "Generate" to "Execute Command".
5. WHILE no `changeTicket` is selected, THE Frontend SHALL keep the Generate (and therefore Execute) action disabled on all four add/delete forms.
6. WHEN a user clicks "Execute Command", THE Frontend SHALL present a confirmation interface before sending the execution request.
7. WHEN a show/execute result returns from n8n, THE Frontend SHALL display the raw device output (and a structured table where a parser exists) and surface a SUCCESS or FAILED outcome.
7a. WHEN an operation on any of the four ACL/ROUTE add/delete pages (`acl/add`, `acl/delete`, `routes/add`, `routes/delete`) produces a success, failure, or warning outcome, THE Frontend SHALL present that feedback (including the device output) in a shared result pop-up dialog (`ResultDialog`, a reusable UModal-based component with a `success | error | warning` variant and an optional `#body` slot) rather than stacking additional UAlert / result blocks on the page. Field-level inline validation hints (e.g. the time-range hint, the invalid-IP badge, the no-ticket hint) SHALL remain inline. The data pages `acl/index`, `routes/index`, and `logs/index` SHALL continue to use their own `LoadingState` / `EmptyState` / `ErrorState`.
8. THE Frontend SHALL never display the raw Execution_Credentials; they SHALL appear only as `***`.
9. THE Frontend SHALL validate form input using the shared Zod schemas, and THE API_Layer SHALL re-validate on the server.

### Requirement 9: ACL ADD IP auto-correction

**User Story:** As a network engineer, I want ticket IP addresses on the internal `10.197.x` scheme to be rewritten to the real device `10.71.x` scheme automatically on an ACL add, so that I don't have to translate addresses by hand and the device never receives a mappable-but-unmapped address.

Engineers receive change tickets addressed on the `10.197.x` scheme, but the device ACLs are written against the real `10.71.x` scheme. A single static prefix map in `shared/schemas/network.schema.ts` (`autoCorrectAclIp`) is the source of truth, applied both on the form and again on the server. This applies to ACL **ADD only** — DELETE and all ROUTE operations are untouched.

#### Acceptance Criteria

1. THE Validation_Layer SHALL provide `autoCorrectAclIp(value)` backed by a static prefix map that rewrites the FIRST THREE octets of a valid IPv4 whose first three octets exactly match a mapped prefix, preserving the 4th octet. The seeded map SHALL be: `10.197.200.N` → `10.71.35.N` (development) and `10.197.100.N` → `10.71.37.N` (production).
2. WHEN `autoCorrectAclIp` receives a value that is not a valid IPv4 OR whose first three octets match no mapped prefix, THE Validation_Layer SHALL return the value unchanged.
3. THE `autoCorrectAclIp` function SHALL be pure and idempotent — a value already on the `10.71.x` scheme matches no source prefix, so re-applying it is a no-op; the map is extensible by adding entries without changing callers.
4. WHEN the Source or Destination field on the ACL add form loses focus (blur), THE Frontend SHALL apply `autoCorrectAclIp` to that field so the displayed value is the corrected IP before Generate/Execute. (`IpInput` emits a `blur` event the page handles.)
5. WHEN the ACL_Service handles an ACL ADD preview or execute, THE ACL_Service SHALL re-apply the SAME mapping to Source and Destination (`withCorrectedAclIps`) BEFORE building the preview, writing audit, and calling n8n — defense-in-depth so a direct API call bypassing the form is also corrected and nothing records a mappable-but-unmapped IP.
6. THE ACL_Service SHALL apply the auto-correction to ACL ADD ONLY; it SHALL NOT alter ACL DELETE inputs nor any ROUTE operation.

### Requirement 10: Bidirectional ACL add (both directions)

**User Story:** As a network engineer, I want to optionally add an ACL in both directions in one submission — the forward Source→Destination and the reverse Destination→Source with their masks swapped — so that I don't have to run the add twice by hand.

The reverse direction uses the same `changeTicket` and the same time range as the forward direction; only Source/Destination and their masks are swapped. Each direction is an independent n8n call with its own Correlation_Id and its own audit row; there is no rollback between them.

#### Acceptance Criteria

1. THE ACL ADD request schema SHALL carry an OPTIONAL `bidirectional` boolean on the ADD union member only; DELETE and ROUTE SHALL NOT accept it. Absent/false SHALL mean an ordinary one-way ADD.
2. THE client-facing `OperationResult` SHALL gain an OPTIONAL nested `reverse` result (same shape) so a one-way result stays backward-compatible (no `reverse`) and a bidirectional result returns the forward direction at the top level plus the reverse under `reverse`.
3. WHEN an ACL ADD has `bidirectional = true`, THE ACL_Service SHALL run the iTop change-ticket existence guard ONCE up front (both directions share the one ticket) and SHALL apply the ACL ADD IP auto-correction (Requirement 9) before splitting into directions.
4. WHEN executing a bidirectional ACL ADD, THE ACL_Service SHALL run TWO independent directions — forward (Source→Destination) then reverse (Destination→Source with Source/Destination AND their masks swapped) — each with its OWN Correlation_Id and its OWN master audit row plus `acl_logs` detail row, SHALL apply the SAME `changeTicket` and the SAME `timeRange` to both, and SHALL run both regardless of the other's outcome (no rollback). It SHALL return `{ ...forward, reverse }`.
5. A one-way ACL ADD (bidirectional off), ACL DELETE, and every ROUTE operation SHALL be byte-for-byte unchanged by this feature.
6. THE bidirectional Command_Preview SHALL render ONE `configure terminal … exit` block containing the forward permit line then the reverse permit line (Requirement 3, criterion 2a).
7. WHEN the user enables Bidirectional, THE Frontend existence pre-check SHALL check BOTH directions and auto-skip any that already exists: both absent → run both; exactly one exists → warn and run only the missing direction; both exist → warn and run neither. The bidirectional checkbox SHALL stay ON in all cases (it reflects the user's intent, not execution state); the run plan narrows what actually executes.
8. THE bidirectional toggle SHALL be a label-row checkbox on the ACL add page, placed below the Ticket Change field and above the Generate button.

## Non-Functional Requirements

### Security

1. THE ACL_Service and Route_Service SHALL never store the Execution_Credentials in cleartext and SHALL redact them to `***` before any preview, response, or audit write.
2. THE ACL_Service and Route_Service SHALL isolate all n8n interaction behind the N8N_Client and keep the four Command_Templates in one place, so payload/preview changes do not ripple into the request or audit layers.
3. THE ACL/ROUTE endpoints SHALL enforce every permission and ticket-existence check on the server, independent of Frontend behavior.

### Maintainability

1. THE module SHALL derive its request/response types from the shared Zod schemas via `z.infer` and SHALL NOT maintain parallel hand-written interfaces.

## Out of Scope

1. Direct execution against devices by this application (delegated to n8n; see the general/ and n8n-integration specs).
2. Any in-app SSH/NETCONF/Ansible/NAPALM/Netmiko client or jump-host connection (these live in n8n).
3. Storing device SSH credentials or persisting ACL/route configuration state (the app stores audit logs only).
4. The protocol/port/action/time-range/next-hop/policy fields of the earlier draft — not part of the current contract.
5. Approval / multi-stage sign-off beyond the single execute confirmation step.
