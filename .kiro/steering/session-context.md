---
inclusion: always
---

# Project Context & Session Handoff

This is a **short, reusable memory** for Kiro chat sessions, not a full project specification or chat transcript. Information here may become outdated; verify against current code when needed.

## 1. Project overview

- **Project:** NetOps Policy Manager.
- **Purpose:** Authenticated, role-based interface + audit **system of record** for network ACL/ROUTE operations. It PREVIEWS device commands and delegates execution to n8n; stores NO device config. PostgreSQL is identity/RBAC/session/audit only.
- **Stack:** Nuxt 4 (Vue 3 `<script setup lang="ts">` + Nitro), Drizzle ORM + PostgreSQL, Zod source-of-truth in `shared/schemas`, Tailwind v4 + Nuxt UI, Vitest. Node 24, TypeScript strict.
- **Source of truth for behavior:** `.kiro/specs/` has **ten per-module folders, one authoritative `requirements.md` each** (EARS voice): `general/`, `database/`, `authentication/`, `rbac-permissions/`, `netops-policy-manager/`, `n8n-integration/`, `ticketing-itop/`, `log-trail/`, `user-management/`, `dashboard/`. `general/` holds the shared glossary/layering/envelope/correlation-id/config; `database/` the full Drizzle schema; each other folder one module, cross-linked.
- **Important paths:** `server/{api,services,repositories,network}/*`, `database/schema/*`, `shared/schemas/*`, `app/pages/*`, `app/components/dashboard/*`. Repositories are the only Drizzle layer.
- **Reference docs:** `AGENTS.md` (root), `.kiro/steering/{ui-conventions,project-rules,tone,git-boundaries}.md`.

## 2. Latest session handoff

- **Last update:** Documented the ACL-add feature batch + device-mirrored previews + folder-style menu in the specs.
- **Completed and verified (against source):** `netops-policy-manager/requirements.md` — reconciled ACL-ADD time range (Req 7a); NEW Req 9 ACL-ADD IP auto-correct (`autoCorrectAclIp`, static map `10.197.200.N→10.71.35.N` dev / `10.197.100.N→10.71.37.N` prod, first 3 octets, form on-blur + server `withCorrectedAclIps`, ADD only); NEW Req 10 bidirectional ADD (optional `bidirectional`, two independent directions via `runAclDirection`/`reverseAclDirection`, own correlation id + audit row each, same ticket + time range, `OperationResult.reverse`, checkbox stays ON, auto-skip existing); Req 3 previews mirror n8n device lines in one `configure terminal … exit` block (fixed list `KSEI-JMP`, route next-hop add `192.197.120.1 1` / delete `10.100.100.5 1`, no ssh/creds); Req 8 feedback via shared `ResultDialog` pop-up. `log-trail/` Req 4.3a = two audit rows per bidirectional add. `rbac-permissions/` Req 6 = folder-style sidebar (ACL Policies/Routes empty parent groups, Show/Add/Delete children; RBAC UNCHANGED).
- **Key confirmed facts:** `audit_action` = LOGIN, SHOW, ADD, DELETE, UPDATE, LOGOUT, MFA_VERIFY; `audit_module` = AUTH, USER, ACL, ROUTE, N8N. AUTH = two rows. USER/UPDATE `kind` = ROLE_CHANGE/STATUS_CHANGE. User CREATE + PASSWORD RESET DISABLED (403; AD accounts). Device creds live for the login session. Dashboard colors: Activity `#2563eb`, Config by Operation `#1a57ab`. Singular `/api/acl/*` + `/api/route/*`; no ACL/route config tables. `ResultDialog.vue` reusable (UModal success/error/warning; amber warning icon = no-token exception).
- **Untouched (user-owned):** `tasks.md`, `tasks.meta.json`, `.config.kiro` under the spec folders.
- **Next step:** Treat the ten specs as the source of truth; keep them in sync when auth, RBAC, schema, ACL/ROUTE behavior, or config changes.

## 3. Context usage rules

1. **Start here**, but prioritize the user's latest request and the actual repository over this summary.
2. For a **new task**, use the overview; ignore unrelated details from the previous task. To **resume**, read the handoff, then verify only relevant code.
3. **Avoid full-repository scanning**; start from named files and known paths.
4. **Do not guess** implementation status; distinguish confirmed, planned, and unknown. Keep changes scoped and follow existing conventions.
5. Never store passwords, tokens, keys, or other secrets in this file.

## 4. Update procedure

On **"save context" / "update context" / "simpan konteks"**: refresh Section 2 from verified outcomes; update Section 1 only when stable facts changed; replace obsolete notes instead of appending; do not rescan the whole project; confirm only after the write succeeds. On **"initialize context" / "inisialisasi konteks"**: examine only essential entry points (README, dependency manifest, root structure, relevant specs). **Keep this file under ~500 words** — it loads in every interaction.
