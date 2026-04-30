# PVE Server Implementation Plan

**Goal:** replace GA Connector with a PVE-owned attribution server (Cloudflare Worker + KV + Zoho Deluge).

**Scope:** vacuumelevators.com only. Form-fill leads. Single domain. Implementation only (cutover and retirement of legacy paths are out of scope for this document).

---

## Architecture

```
Browser (vacuumelevators.com)
  │
  ├─ PVE Attribution tag (GTM, live)        sets pve_* cookies on every page
  │
  └─ PVE Identify tag (GTM, new)            on email capture: POST /identify
                                                 │
                                                 ▼
                          Cloudflare Worker (ss.vacuumelevators.com)
                                                 │
                                                 ▼
                              Cloudflare KV (key: sha256(email))
                                                 │
                          ◄─── GET /lookup ──────┘
                          │
                  Zoho Deluge (enrichLeadFromKV)
                          │
                          ▼
                  Zoho Lead (23 pve_* fields populated)
```

---

## Implementation steps (priority order)

1. **Cloudflare infra.** Worker, KV namespace, DNS CNAME `ss.vacuumelevators.com`, Turnstile site key + secret.
2. **Worker code + GitHub Actions deploy.** `POST /identify`, `GET /lookup`, `DELETE /identify`. Auto-deploy on push to `main` with lint + smoke test gates.
3. **Zoho custom fields.** Create 23 `pve_*` fields in Leads + Contacts modules. Verify Lead → Contact field type symmetry. Configure Lead Conversion Mapping (23 pairs).
4. **Backfill Deluge function.** Additive and idempotent: for each existing Lead with `KDI_*` populated, copy 1:1 into matching `pve_*` field only when the target is empty.
5. **Enrichment Deluge function.** `enrichLeadFromKV(leadId)` with kill switch and idempotency fence.
6. **Workflow Rules + scheduled function.** Rule 1 on Lead Create. Rule 2 on Email field modified. Scheduled daily sweep at 03:00 UTC.
7. **GTM PVE Identify tag.** Universal email listener (no per-form configuration). Validate in Preview, publish.

---

## Components

### 1. GTM PVE Identify tag (universal capture)

Custom HTML tag, fires on All Pages. Captures email across **any** form on the site without per-form configuration (matches GA Connector's behavior).

Document-level listeners:
- `change` on `input[type=email]`: catches email on field blur
- `fluentform_submission_success`: native FluentForms event, deduped via `Set` keyed on `form_id + insert_id`
- `submit` on any `<form>` containing an `input[type=email]`: catches submits in non-FluentForm or FF flows where the success event misses
- `beforeunload`: flushes any in-flight capture via `navigator.sendBeacon`

Transport:
- During interaction: `fetch(url, { keepalive: true })` (request continues even if page navigates away)
- On page unload: `navigator.sendBeacon`

Per-session dedup: `Set` keyed on `email_hash` prevents duplicate POSTs from cascading listeners (e.g. blur + submit firing for the same email).

Body sent to `POST /identify`:
```json
{
  "email_hash": "<sha256 hex of email.toLowerCase().trim()>",
  "first_touch": { "source": "...", "medium": "...", "campaign": "...", "content": "...", "term": "...", "referrer": "...", "landing_page": "...", "ts": 1234567890000 },
  "last_touch":  { "source": "...", "...": "...", "ts": 1234567890000 },
  "gclid": "...",
  "ga_raw": "<full _ga cookie value>"
}
```

### 2. Cloudflare Worker

URL: `https://ss.vacuumelevators.com`
Account: `pvedigitalmarketing@gmail.com` (ensure 2FA enabled, recovery contact configured, API token scoped to Worker + KV deploy only).
Bindings: `PVE_KV`, `TURNSTILE_SECRET`, `HMAC_SECRET`.

#### `POST /identify`
Auth: Turnstile invisible token, origin-locked CORS allowlist (`https://vacuumelevators.com` AND `https://www.vacuumelevators.com`), 60 req/min/IP rate limit.

Behavior:
1. Verify Turnstile token via `https://challenges.cloudflare.com/turnstile/v0/siteverify`. On invalid: 403, log `turnstile_reject` counter.
2. Validate `email_hash` is 64-char hex. On invalid: 400.
3. Read existing KV entry by `email_hash`.
4. Merge (best-effort, KV is not strictly atomic):
   - `first_touch`: write-once
   - `last_touch`: overwrite
   - `touches[]`: append, cap 50, FIFO drop oldest
5. Add Cloudflare-derived fields from `request.cf` (country, city) and `CF-Connecting-IP` (ip_address).
6. Parse `User-Agent` header → `ua_os`, `ua_browser`.
7. Split `ga_raw` to extract `ga_client_id` (strip `GA1.1.` prefix).
8. Derive `fc_channel` and `lc_channel` from medium (channel map below).
9. Set `created_at` if new, update `updated_at` (epoch ms).
10. Truncate any string field over 32,000 chars before write.
11. Write to KV with 365-day TTL.
12. Return 200.

Note: KV concurrent writes to the same key (rare at ~60 writes/day) can clobber. Accepted trade-off given volume and cost of Durable Objects. Documented limitation.

Note: KV is eventually consistent with no documented SLA. In practice, US-East PoP propagation is seconds. Combined with the daily sweep, Lead Create races are absorbed.

#### `GET /lookup?email_hash=<hex>`
Auth: HMAC SHA-256 in `X-Signature` header.

Signed payload (newline-delimited):
```
GET
/lookup
email_hash=<hex>
<sha256_hex_of_body>
<utc_epoch_ms>
```

For empty body: `sha256("")` = `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.

Both Worker and Deluge MUST use UTC epoch ms. Reject if drift > 5 min.

Returns full KV value as JSON, or 404.

#### `DELETE /identify`
Auth: HMAC SHA-256 in `X-Signature` header.

Body: `{ "email_hash": "<hex>" }` (caller hashes; Worker never receives or logs plain email).

Signed payload includes `sha256_hex_of_body` exactly as above (protects against body tampering).

Calls `env.PVE_KV.delete(email_hash)`. Returns 200 (idempotent).

This is the DSAR mechanism. TTL is retention hygiene only, not a deletion right.

#### Channel derivation

| Medium | Channel |
|---|---|
| `cpc`, `paid`, `paid_search`, `ppc` | Paid Search |
| `paid_social`, `paidsocial`, `social_paid` | Paid Social |
| `email` | Email |
| `organic` | Organic Search |
| `referral` | Referral |
| `display` | Display |
| `(none)`, empty | Direct |
| else | Other |

### 3. Cloudflare KV

Namespace: `PVE_KV`.

Key: `email_hash` (SHA-256 hex of `email.toLowerCase().trim()`).

Value (JSON, all timestamps epoch ms):
```json
{
  "first_touch": { "source": "...", "medium": "...", "campaign": "...", "content": "...", "term": "...", "referrer": "...", "landing_page": "...", "channel": "...", "ts": 1234567890000 },
  "last_touch":  { "source": "...", "...": "...", "channel": "...", "ts": 1234567890000 },
  "touches": [
    { "source": "...", "medium": "...", "campaign": "...", "ts": 1234567890000 }
  ],
  "device": { "ua_os": "iOS 16.6", "ua_browser": "Safari 16" },
  "geo": { "country": "US", "city": "Tampa", "ip_address": "73.139.0.18" },
  "ga_client_id": "1380815224.1775231481",
  "gclid": "Cj0KCQ...",
  "created_at": 1234567890000,
  "updated_at": 1234567890000
}
```

TTL: 365 days from last write (auto-extends on each write). Retention hygiene only.

### 4. Zoho fields (23)

Section "Lead Source Data | PVE" in **Leads** and **Contacts** modules.

| # | API name | Source | Type |
|---|---|---|---|
| 1 | pve_fc_source | Cookie `pve_fc_source` | Single Line |
| 2 | pve_fc_medium | Cookie `pve_fc_medium` | Single Line |
| 3 | pve_fc_campaign | Cookie `pve_fc_campaign` | Single Line |
| 4 | pve_fc_content | Cookie `pve_fc_content` | Single Line |
| 5 | pve_fc_term | Cookie `pve_fc_term` | Single Line |
| 6 | pve_fc_referrer | Cookie `pve_fc_referrer` | Multi Line |
| 7 | pve_fc_landing_page | Cookie `pve_fc_landing_page` | Multi Line |
| 8 | pve_lc_source | Cookie `pve_lc_source` | Single Line |
| 9 | pve_lc_medium | Cookie `pve_lc_medium` | Single Line |
| 10 | pve_lc_campaign | Cookie `pve_lc_campaign` | Single Line |
| 11 | pve_lc_content | Cookie `pve_lc_content` | Single Line |
| 12 | pve_lc_term | Cookie `pve_lc_term` | Single Line |
| 13 | pve_lc_referrer | Cookie `pve_lc_referrer` | Multi Line |
| 14 | pve_lc_landing_page | Cookie `pve_lc_landing_page` | Multi Line |
| 15 | pve_fc_channel | Worker (derived from medium) | Single Line |
| 16 | pve_lc_channel | Worker (derived from medium) | Single Line |
| 17 | pve_ga_client_id | Cookie `_ga` (split by Worker) | Single Line |
| 18 | pve_gclid | Cookie `pve_gclid` | Single Line |
| 19 | pve_ip_address | Cloudflare `CF-Connecting-IP` | Single Line |
| 20 | pve_country | Cloudflare `request.cf.country` | Single Line |
| 21 | pve_city | Cloudflare `request.cf.city` | Single Line |
| 22 | pve_ua_os | Worker (parses User-Agent) | Single Line |
| 23 | pve_ua_browser | Worker (parses User-Agent) | Single Line |

Verification before Conversion Mapping: confirm each Lead field and its Contact counterpart share the same type (Single Line vs Multi Line). Mismatch causes silent truncation on conversion.

### 5. Zoho Deluge

#### `enrichLeadFromKV(leadId)`
1. **Kill switch:** read Org Variable `ENRICH_ENABLED`. If `"false"`, return `"disabled"`.
2. **Idempotency fence:** read Lead `pve_fc_source`. If non-empty, return `"already populated"`. Prevents quota detonation if a bulk import (or anything else) re-fires the workflow.
3. Read Lead `Email`. Normalize (lowercase, trim). If empty, return `"no email"`.
4. Compute `email_hash = zoho.encryption.sha256(email, "hex")`.
5. Build HMAC payload: `"GET\n/lookup\nemail_hash=" + email_hash + "\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\n" + utc_epoch_ms`.
6. `signature = zoho.encryption.hmacsha256(secret, payload, "hex")`.
7. `invokeurl GET https://ss.vacuumelevators.com/lookup?email_hash=<hex>` with `X-Signature` and `X-Timestamp` headers.
8. On 200: build update Map from response. **Allowlist guardrail:** every key in the Map MUST match `^pve_`. If any key fails, abort and log (no Lead update). Then update Lead with the Map.
9. On 404, 5xx, or timeout: log and return. **No retry inside the workflow.** Workflow-triggered Deluge is capped at 30 seconds total execution; the daily sweep absorbs failures.

#### `dailySweep()` (scheduled 03:00 UTC, Schedule trigger budget = 15 min)
1. COQL: `SELECT id FROM Leads WHERE Created_Time > <now - 24h> AND pve_fc_source IS NULL LIMIT 500`.
2. For each Lead, call `enrichLeadFromKV(id)` sequentially.
3. Cap at 500 Leads per run.
4. After run: if backlog (Leads still empty after sweep) > 100, log alert.

#### `backfill()` (one-time, manual run)
1. Iterate all Leads with any `KDI_*` field populated.
2. For each `pve_*` target field, write only if currently empty (additive; protects against overwrite during parallel run).
3. 1:1 mapping for the 14 cookie-derived fields. The 9 Worker/Cloudflare-derived fields stay empty for historical Leads (cannot be reconstructed).
4. **Allowlist guardrail:** every key in the update Map MUST match `^pve_`. If any key fails, abort the Lead update and log.
5. Idempotent: re-running on partial completion only fills missing fields.

### 6. Workflow Rules

| # | Module | Trigger | Action |
|---|---|---|---|
| 1 | Leads | On Create | call `enrichLeadFromKV(record.id)` |
| 2 | Leads | On Email field modified | call `enrichLeadFromKV(record.id)` (fence prevents detonation on bulk operations) |
| 3 | Leads (scheduled) | Daily 03:00 UTC | call `dailySweep()` |

### 7. Auth model

| Caller | Endpoint | Mechanism |
|---|---|---|
| Browser (GTM Identify tag) | `POST /identify` | Turnstile invisible token + origin-locked CORS (apex + www) + 60 req/min/IP |
| Zoho Deluge | `GET /lookup`, `DELETE /identify` | HMAC SHA-256, signed payload includes `method`, `path`, `query`, `sha256(body)`, `utc_epoch_ms` |

Secrets:
- Cloudflare Worker: `TURNSTILE_SECRET`, `HMAC_SECRET` (set via `wrangler secret put`)
- Zoho Org Variables: `WORKER_HMAC_SECRET` (mirror of `HMAC_SECRET`), `ENRICH_ENABLED` (boolean kill switch)

Smoke test before go-live: send signed Deluge → Worker request, verify HMAC validates on both ends. Most common failure: Zoho org timezone vs Worker UTC drift. Use `zoho.currenttime.toString("...","UTC")` explicitly and parse to epoch ms.

---

## Repo layout

```
worker/
  src/
    index.js
    handlers/{identify.js, lookup.js, delete.js}
    lib/{hash.js, hmac.js, channel.js, ua.js, turnstile.js}
  wrangler.toml
  package.json
deluge/
  enrich_lead_from_kv.dg
  daily_sweep.dg
  backfill.dg
gtm/
  pve_attribution_unified.html       # live, sets cookies
  pve_identify.html                  # new, universal email listener
docs/
  implementation_plan.md
  runbook.md                         # deploy, rollback, restore procedures
.github/
  workflows/
    deploy_worker.yml
```

---

## Deploy

GitHub Actions, auto-deploy on push to `main`:
- Trigger: paths `worker/**`, `wrangler.toml`
- Steps: ESLint → unit tests → `cloudflare/wrangler-action@v3` deploy → post-deploy smoke test (signed `GET /lookup` against a known test key)
- Repo secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `TEST_HMAC_SECRET`
- Rollback: re-run a previous green Action, or `wrangler rollback` from CLI. Procedure documented in `docs/runbook.md`.

Deluge functions and GTM tag: source of truth in repo. Manual copy/paste into Zoho Functions UI / GTM UI on each change.

---

## Operational baseline

### Observability
- Cloudflare Logpush enabled, destination R2 (or Cloudflare Logs).
- Worker logs structured counters: `identify_200`, `identify_400`, `identify_403_turnstile`, `identify_429_ratelimit`, `kv_write_fail`, `lookup_404`, `lookup_5xx`.
- Weekly review of: Turnstile reject rate, 5xx rate, rate-limit drops.
- Deluge: log `invokeurl` failures with `email_hash` (not email) and `lead_id` for triage.

### KV backup
- Scheduled Worker daily exports `PVE_KV` namespace to R2 bucket.
- 30-day retention.
- Restore procedure documented in `docs/runbook.md`.

### Account hardening
- Cloudflare account: 2FA enabled, recovery contact configured, API token scoped (not Global API Key).
- HMAC secret rotated annually or on suspicion of compromise.
