# Codebase Knowledge Graph — Prioritas Pencarian

Project ini sudah diindeks penuh oleh **codebase-memory-mcp** (knowledge graph
seluruh source code). Untuk setiap task, chat, prompt, atau workflow, **cari
lewat MCP Knowledge Graph dulu sebelum membaca file mentah**. Ini menghemat token
dan context — graph mengembalikan symbol, relasi, dan potongan source yang presisi
tanpa perlu membuka banyak file.

## Aturan operasional (wajib)

- **Selalu prioritaskan Codebase Memory MCP** untuk memahami struktur, fungsi,
  dan dependensi source code — sebelum membaca file secara langsung, demi hemat
  token & context window.
- **Jangan re-index di tiap prompt.** Pakai index yang sudah ada; cek statusnya
  (`index_status` / `list_projects`) hanya bila perlu.
- **Index manual hanya jika** repository belum terindeks, atau index sudah tidak
  sesuai dengan source code terbaru (ada perubahan material sejak `indexed_at`).
- **Tetap baca source code aktual** bila diperlukan untuk memastikan implementasi
  dan perubahan akurat (lihat "Kapan jatuh balik ke grep/glob/read_file").

## Identitas project graph (dipakai sebagai argumen `project`)

- **project name:** `E-Work-CLOUD-PROJECTS-Netops-policy`
- **root_path:** `E:/Work/CLOUD PROJECTS/Netops-policy`
- Jika sesi baru / setelah compaction: konfirmasi dulu dengan `list_projects`
  atau `index_status` (generasi index bisa berubah). Index ini bukan project
  sesi aktif, jadi auto-sync tidak mengawasinya — **re-run `index_repository`
  untuk menyegarkan** setelah ada perubahan source code.

## Urutan prioritas tool (pakai ini sebelum grep/glob/read_file)

1. `search_graph` — temukan function, class, route, interface, variabel by pattern.
2. `trace_path` — telusuri siapa pemanggil (inbound) / apa yang dipanggil (outbound).
3. `get_code_snippet` — baca source persis sebuah symbol via qualified name.
4. `check_index_coverage` — validasi path/scope kandidat sebelum klaim (wajib untuk
   klaim negatif / exhaustive). Hasil "clean" ≠ bukti kelengkapan.
5. `query_graph` — Cypher untuk pola multi-hop yang kompleks.
6. `get_architecture` — ringkasan arsitektur tingkat tinggi.

## Kapan jatuh balik ke grep/glob/read_file

- String literal, pesan error, nilai config.
- File non-code (Dockerfile, shell script, `.sql`, `.env.example`).
- Range yang ditandai `parse_partial` / `parse_unusable` oleh `index_status`
  (mis. beberapa file di `database/migrations/*.sql`).
- Saat tool graph mengembalikan hasil yang tidak memadai.

## Tier bukti

- **Scout:** lookup positif cepat, tandai provisional; jangan klaim negatif/exhaustive.
- **Verify (default):** bukti graph terarah + snippet persis untuk klaim material.
- **Auditor:** verifikasi penuh bounded-scope, kedua arah panggilan, paginasi lengkap,
  semua keterbatasan diungkap. Setelah path kandidat diketahui, panggil
  `check_index_coverage` sekali dengan semua path bukti.

## Peta arsitektur (snapshot index terakhir)

NetOps Policy Manager — Nuxt 4 (Vue 3 `<script setup>` + Nitro) · Drizzle ORM ·
PostgreSQL · Zod · Tailwind v4 + Nuxt UI. Graph: ~2960 node / ~5331 edge.
Bahasa: TypeScript (119), Vue (45), SQL (13), CSS (1).

### Layering (API → service → repository → PostgreSQL)

- **api** (`server/api/*`) — entry, hanya outbound; handler tipis, HTTP routes.
- **services** (`server/services/*`) — logika + transaksi; fan-out tinggi ke
  repositories (61), network (23), utils (12).
- **repositories** (`server/repositories/*`) — core, satu-satunya layer Drizzle
  (fan-in 62, fan-out 0).
- **network** (`server/network/*`) — core, integrasi n8n / device preview (HTTP_CALLS).
- **schemas** (`shared/schemas/*`) — leaf, Zod sumber kebenaran bentuk data.
- **auth** (`server/utils/auth` dkk) — leaf, gating sesi & `requirePermission`.
- **utils** (`server/utils/*`) — core; hotspot: `envelope.ok`, `envelope.apiError`,
  `db.useDatabase`, `auth.assertSameOrigin`, `auth.requireAuthenticatedUser`,
  `config.loadEnv`.
- **app** (`app/pages`, `app/components`, `app/composables`) — frontend; composable
  `useApi` / `useAuth` adalah entry point utama klien.

### Modul utama (paket berdasar jumlah node)

services (111) · composables (84) · pages (69) · repositories (65) ·
components (62) · schemas (61) · network (39) · utils (34) · auth (15) ·
migrations (9) · api (5) · seeds (4) · database (3) · constants (3).

### Rute HTTP (Nitro)

Auth: `/api/auth/login`, `/api/auth/logout`, `/api/auth/me`.
ACL: `/api/acl/{show,preview,execute}`. Route: `/api/route/{show,preview,execute}`.
Session: `/api/session/device-credentials(/reveal)`.
Dashboard: `/api/dashboard/{kpi,activity-series,config-by-operation,top-users,recent-config-changes}`.
Audit: `/api/audit`, `/api/audit/{id}`, `/api/audit/export`.

### Contoh pemakaian

- Cari handler: `search_graph(name_pattern=".*aclExecute.*")`.
- Siapa pemanggil: `trace_path(function_name="requirePermission", direction="inbound")`.
- Baca source: `get_code_snippet(qualified_name="E-Work-CLOUD-PROJECTS-Netops-policy.server.utils.envelope.ok")`.
