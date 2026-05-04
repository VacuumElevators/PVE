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

Ordering optimizes for **rollout quality**, not construction order. The GTM listener is published before Deluge is wired so the KV starts accumulating attribution data while later steps are built. Workflow Rules go live last, against an already-warm KV. There is no separate backfill from legacy `KDI_*` fields: Leads created before the GTM publish stay with empty `pve_*` (acceptable; if needed, a one-shot `dailySweep` with a wider window can catch warmup-era Leads after Step 7).

1. **Cloudflare infra.** Worker, KV namespace, DNS CNAME `ss.vacuumelevators.com`, Turnstile site key + secret.
2. **Worker code + GitHub Actions deploy.** `POST /identify`, `GET /lookup`, `DELETE /identify`. Auto-deploy on push to `main` with lint + smoke test gates. Observability counters wired in this step so they are live from Step 3 onwards.
3. **GTM PVE Identify tag publish.** Universal email listener (no per-form configuration). Verify cookie banner consent category mapping matches the existing `pve_attribution_unified` tag. Validate in Preview, publish. KV warmup begins; observability live.
4. **Zoho custom fields.** Create 23 `pve_*` fields in Leads + Contacts modules. Verify Lead → Contact field type symmetry. Configure Lead Conversion Mapping (23 pairs). Runs in parallel with Step 3 (independent of KV).
5. **Enrichment Deluge function written.** `enrichLeadFromKV(leadId)` with kill switch (`ENRICH_ENABLED`) and idempotency fence. Function exists in Zoho but is **not** wired to any Workflow Rule yet.
6. **Manual smoke test.** Two pre-flight checks before automation:
   - **Email-hash handshake:** browser-side `crypto.subtle.digest('SHA-256', email.toLowerCase().trim())` MUST produce the identical hex output as Deluge `zoho.encryption.sha256(email, "hex")` for the same input. Validate explicitly with at least three test emails.
   - **End-to-end single-Lead enrichment:** create one test Lead, manually invoke `enrichLeadFromKV(test_lead_id)`, verify all 23 `pve_*` fields populate correctly. Re-run, verify fence returns `"already populated"`. Set `ENRICH_ENABLED=false`, re-run, verify returns `"disabled"`.
7. **Workflow Rules + scheduled sweep (big-bang).** Three rules ship together: Rule 1 on Lead Create, Rule 2 on Email field modified, Scheduled daily sweep at 03:00 UTC. Real-time enrichment goes live the moment this step lands.
8. **Cookie consent banner.** Scope to be defined with Luis. Open questions: build from scratch or integrate new "PVE attribution - Send to KV" tag into the existing banner category mapping; GDPR posture (geo gated vs global); banner UI source (CMP vendor vs custom). Cookie Consent Banner is an approved Upwork milestone ($310, funded 2026-04-07) so this step is contracted, not speculative.

---

## Components

### 1. GTM PVE Identify tag (universal capture)

Custom HTML tag, fires on All Pages. Captures email across **any** form on the site without per-form configuration (matches GA Connector's behavior).

**Consent gating (verify before publish):** the existing `pve_attribution_unified` tag (which sets cookies) is already mapped to a category in the cookie banner. The new Identify tag MUST map to the same category. If the existing tag is gated by "marketing" / "analytics" / equivalent, gate this one identically. Skipping this is a GDPR risk: capturing `email_hash` from EU visitors without consent.

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

Source-aware: when medium is paid (cpc/paid/ppc/paid_search/paidsearch), the source distinguishes Paid Search from Paid Social. Mirrors GA Connector behavior (Lead 131454 reference: source=facebook + medium=cpc → Paid Social, not Paid Search).

Rules evaluated top-to-bottom, first match wins:

| Medium | Source | → Channel |
|---|---|---|
| `cpc`, `paid`, `paid_search`, `paidsearch`, `ppc` | facebook, fb, instagram, ig, linkedin, twitter, x, tiktok, snapchat, pinterest, reddit | Paid Social |
| `cpc`, `paid`, `paid_search`, `paidsearch`, `ppc` | else | Paid Search |
| `paid_social`, `paidsocial`, `social_paid`, `social-paid` | (any) | Paid Social |
| `email` | (any) | Email |
| `organic` | (any) | Organic Search |
| `referral` | (any) | Referral |
| `display` | (any) | Display |
| `(none)` or empty | (any) | Direct |
| anything else | (any) | Other |

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

Created in Leads on 2026-05-04. Naming uses full "First Click" / "Last Click" instead of FC/LC abbreviations for Zoho UI legibility. API names are auto-generated by Zoho from the field label (e.g. `PVE_First_Click_Source`); confirm exact API names from Field Details before wiring Step 5 Deluge.

| # | Field Label | Source | Type |
|---|---|---|---|
| 1 | PVE First Click Source | Cookie `pve_fc_source` | Single Line |
| 2 | PVE First Click Medium | Cookie `pve_fc_medium` | Single Line |
| 3 | PVE First Click Campaign | Cookie `pve_fc_campaign` | Single Line |
| 4 | PVE First Click Content | Cookie `pve_fc_content` | Single Line |
| 5 | PVE First Click Term | Cookie `pve_fc_term` | Single Line |
| 6 | PVE First Click Referrer | Cookie `pve_fc_referrer` | Multi Line |
| 7 | PVE First Click Landing Page | Cookie `pve_fc_landing_page` | Multi Line |
| 8 | PVE Last Click Source | Cookie `pve_lc_source` | Single Line |
| 9 | PVE Last Click Medium | Cookie `pve_lc_medium` | Single Line |
| 10 | PVE Last Click Campaign | Cookie `pve_lc_campaign` | Single Line |
| 11 | PVE Last Click Content | Cookie `pve_lc_content` | Single Line |
| 12 | PVE Last Click Term | Cookie `pve_lc_term` | Single Line |
| 13 | PVE Last Click Referrer | Cookie `pve_lc_referrer` | Multi Line |
| 14 | PVE Last Click Landing Page | Cookie `pve_lc_landing_page` | Multi Line |
| 15 | PVE First Click Channel | Worker (derived from medium) | Single Line |
| 16 | PVE Last Click Channel | Worker (derived from medium) | Single Line |
| 17 | PVE GA Client ID | Cookie `_ga` (split by Worker) | Single Line |
| 18 | PVE GCLID | Cookie `pve_gclid` | Single Line |
| 19 | PVE IP | Cloudflare `CF-Connecting-IP` | Single Line |
| 20 | PVE Country | Cloudflare `request.cf.country` | Single Line |
| 21 | PVE City | Cloudflare `request.cf.city` | Single Line |
| 22 | PVE OS | Worker (parses User-Agent) | Single Line |
| 23 | PVE Browser | Worker (parses User-Agent) | Single Line |

Total: 19 Single Line + 4 Multi Line (Referrer FC/LC + Landing Page FC/LC).

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

**Wider-window catch-up:** for the one-time recovery of warmup-era Leads (created between GTM publish and Workflow Rule 1 going live), `dailySweep` can be invoked once with a wider COQL window (e.g. `Created_Time > <GTM publish date>`). Same function, just a parameter override on the manual invocation.

There is no separate backfill function. The previous design migrated `KDI_*` legacy fields into `pve_*`; that bridge has been dropped (decision 2026-04-30: `KDI_*` is not in use, legacy Leads stay with empty `pve_*`).

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

Smoke tests before automation (Step 6):

1. **Email-hash handshake.** Browser `crypto.subtle.digest('SHA-256', email.toLowerCase().trim())` and Deluge `zoho.encryption.sha256(email, "hex")` MUST produce identical 64-char hex output for the same input. Test at least three emails covering: lowercase, mixed case + leading/trailing whitespace, non-ASCII characters. Mismatch = silent 100% lookup failure in production.

2. **Signed request handshake.** Send signed Deluge → Worker request, verify HMAC validates on both ends. Most common failure: Zoho org timezone vs Worker UTC drift. Use `zoho.currenttime.toString("...","UTC")` explicitly and parse to epoch ms. Reject if drift > 5 min.

3. **End-to-end single-Lead enrichment.** Create test Lead, ensure `email_hash` for that Lead's email exists in KV (submit a test form first, or seed via signed POST), manually invoke `enrichLeadFromKV(test_lead_id)`, verify all 23 `pve_*` fields populate. Re-run on same Lead, verify fence returns `"already populated"`. Set `ENRICH_ENABLED=false`, re-run, verify returns `"disabled"`.

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
gtm/
  pve_attribution_unified.html       # live, sets cookies
  pve_attribution_send_to_kv_gtm_tag.html  # new, universal email listener (GTM tag: "PVE attribution - Send to KV")
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

### Observability (live from Step 3 publish)
- Counters wired into Worker code at Step 2 so they emit from the first POST. Logpush + Logs UI ready before Step 3 publishes the GTM tag (otherwise we miss the most informative window of the warmup).
- Cloudflare Logpush enabled, destination R2 (or Cloudflare Logs).
- Worker logs structured counters: `identify_200`, `identify_400`, `identify_403_turnstile`, `identify_429_ratelimit`, `kv_write_fail`, `lookup_404`, `lookup_5xx`.
- Weekly review (post go-live) of: Turnstile reject rate, 5xx rate, rate-limit drops.
- Deluge: log `invokeurl` failures with `email_hash` (not email) and `lead_id` for triage.

### KV backup
- Scheduled Worker daily exports `PVE_KV` namespace to R2 bucket.
- 30-day retention.
- Restore procedure documented in `docs/runbook.md`.

### Account hardening
- Cloudflare account: 2FA enabled, recovery contact configured, API token scoped (not Global API Key).
- HMAC secret rotated annually or on suspicion of compromise.
