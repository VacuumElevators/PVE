# Research notes — PVE Attribution API

**Date:** 2026-04-28
**Purpose:** Verify infrastructure assumptions before Phase B build, in response to Senka's 2026-04-27 plan review.

All sources fetched 2026-04-28.

---

## R1 — Cloudflare KV write quota (Workers Free)

**Finding:** Workers Free plan KV allows **1,000 writes/day**, **1,000 deletes/day**, **1,000 list requests/day**, **100,000 reads/day**, and **1 GB of stored data**. All limits reset at 00:00 UTC. Exceeding any one causes that operation type to fail until reset.

A secondary throttle applies on **both Free and Paid**: **1 write per second to the same key**. Per-Worker-invocation cap is 1,000 KV operations.

**Source:**
- https://developers.cloudflare.com/kv/platform/pricing/
- https://developers.cloudflare.com/kv/platform/limits/

**Application to v1:**
- v1 expected writes: ~60/day (Form 22 form submits). Headroom: 16x.
- 1-write/sec-per-key throttle does not apply: each Lead has a unique `email_hash` key.
- Failed reads still count as billable ops, but our /lookup pattern reads exactly once per Lead Create.

---

## R2 — Cloudflare KV value size limit

**Finding:** Maximum value size per KV key is **25 MiB** (Free and Paid, identical). Key size cap is 512 bytes; key metadata cap is 1024 bytes.

**Source:** https://developers.cloudflare.com/kv/platform/limits/

**Application to v1:**
- Our merged JSON payload is ~3 to 5 KB per visitor (well under 25 MiB).
- `touches[]` array capped at 50 entries: even if each touch is 1 KB, max ~50 KB. Effectively unbounded vs the 25 MiB ceiling.

---

## R3 — Cloudflare KV DELETE operation

**Finding:** API is `env.NAMESPACE.delete(key)` where `key` is a string. Returns `Promise<void>` (resolves on success, no value). Per the docs: **"Calling `delete()` on a non-existing key is returned as a successful delete."** Idempotent. Eventually consistent across the global network.

Bulk deletes are not available via the Worker binding (only via Wrangler CLI or REST API, which accepts up to 10,000 keys per call).

**Source:** https://developers.cloudflare.com/kv/api/delete-key-value-pairs/

**Application to v1:**
- DSAR `DELETE /identify` endpoint: read email from request body, normalize + hash, call `env.PVE_KV.delete(hash)`. Returns 200 either way (idempotent semantics simplify error handling).
- Eventual consistency means a simultaneous read on the deleted key from a different Cloudflare PoP may briefly return the old value. For DSAR this is acceptable because the next read after propagation returns null.

---

## R4 — Cloudflare Turnstile invisible mode

**Finding:** Turnstile supports three widget modes: **Managed** (recommended, adaptive), **Non-Interactive** (visible spinner, no user click), and **Invisible** (no visible widget). Invisible mode runs entirely in the background, suitable for protecting a server endpoint called from a GTM Custom HTML tag.

Server-side verification endpoint: **`POST https://challenges.cloudflare.com/turnstile/v0/siteverify`**.

Tokens are 2,048 chars max, valid 300 seconds, single-use.

**Source:**
- https://developers.cloudflare.com/turnstile/concepts/widget/
- https://developers.cloudflare.com/turnstile/get-started/server-side-validation/

**Free-tier pricing:** Cloudflare lists "Turnstile Free" at $0/month on the marketing page. Free is positioned for "non-business-critical" use, but no documented per-call cap or daily cap is published. Enterprise plan exists for higher SLA and advanced features. PVE volume is ~1,700 verifications/month, well below any soft limit.

**Source:** https://www.cloudflare.com/application-services/products/turnstile/

**⚠ Privacy Addendum requirement:** Cloudflare requires Turnstile users to reference the Cloudflare Turnstile Privacy Addendum in their own privacy policy. **Action item for Manuel: add Turnstile reference to PVE privacy policy before production cutover.**

---

## R5a — Zoho Deluge HMAC-SHA256

**Finding:** Function name is **all lowercase**: `zoho.encryption.hmacsha256(<key>, <data>, <output_type>)`.

- All three parameters are TEXT.
- Parameter order: **key first, data second** (opposite of some other vendors).
- Optional `output_type` accepts `base64` (default), `hex`, `binary`.
- Returns TEXT.

**Source:** https://www.zoho.com/deluge/help/encryption/hmac-sha256.html

**Application to v1:**
- Worker-side HMAC verification uses Web Crypto API in JS: `crypto.subtle.sign('HMAC', key, data)`. Output as hex.
- Deluge call signature: `zoho.encryption.hmacsha256(hmacSecret, signaturePayload, "hex")`.
- Both sides MUST agree on canonicalized signature payload (e.g., `${method}\n${path}\n${timestamp}`) byte-for-byte. Documented in Worker README.

**Note:** earlier plan drafts referenced `hmacSha256` (camelCase). Corrected to `hmacsha256` (lowercase) in plan v2.

---

## R5b — Zoho CRM v8 REST API limits

**Finding:** Zoho CRM v8 uses a **credit system per organization**, not per-minute call counts.

Daily credit limits (24-hour rolling window) per edition:

| Edition | Base | Per-user | Daily cap |
|---|---|---|---|
| Free | 5,000 | — | 5,000 |
| Standard / Starter | 50,000 | +250/user | 100,000 |
| Professional | 50,000 | +500/user | 3,000,000 |
| Enterprise / Zoho One | 50,000 | +1,000/user | 5,000,000 |
| Ultimate / CRM Plus | 50,000 | +2,000/user | unlimited |

**Concurrency** (per org/app): Free 5, Standard 10, Professional 15, Enterprise 20, Ultimate/CRM Plus 25.

**Source:** https://www.zoho.com/crm/developer/docs/api/v8/api-limits.html

**Cost per operation** (highlights):
- Most operations: 1 credit
- Insert/Update/Upsert: **1 credit per 10 records** (max 100/call = 10 credits)
- Convert Lead: 5 credits
- Send Mail: 20 credits
- Search from Function: 1 credit
- Bulk Write Init: 500 credits

A sub-concurrency cap of 10 applies to expensive APIs (Convert Lead, Search from Function, COQL Query, Composite, Send Mail, bulk Insert/Update/Upsert >10 records).

**Application to v1:**
- Runtime enrich: each Lead Create triggers Workflow Rule → Deluge → 1 record update = 0.1 credits per Lead. ~57 Form 22 submits/day = ~6 credits/day. Trivial vs any edition's daily budget.
- One-time backfill (KDI_* → pve_*): ~487 Leads × 1 update each, batched as 49 calls of 10 records = ~49 credits. Done in seconds.
- No per-minute throttling required. Senka's "Zoho rate limit" minor reframes from "calls/min" to "credit budget", well within all editions.

---

## Net plan adjustments

1. Plan v2 capacity table cites confirmed KV limits (1,000 writes/day Free).
2. DELETE endpoint added to API spec; idempotent semantics simplify implementation.
3. Touch array cap stays at 50, with FIFO drop-oldest policy. Size headroom is 25 MiB, no risk.
4. HMAC syntax corrected to `zoho.encryption.hmacsha256(key, data, "hex")`.
5. Zoho rate-limit framing: "credit budget", not "calls/min". v1 ~6 credits/day.
6. Turnstile Privacy Addendum surfaced as Open Question for Manuel + privacy policy update.
