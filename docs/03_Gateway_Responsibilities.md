# Section 3: POS Gateway Responsibilities & Edge Logic

**Document:** TriLiska POS Gateway — Master System Architecture & PRD
**Section:** 03 — POS Gateway Responsibilities & Edge Logic (Caching, Rate Limiting, Validation)
**Prepared by:** Trident Aliska Digital Tech Ghana LTD
**Programme:** GRA MSME Tax & Business Management Programme
**Sprint Focus:** POS Backend Gateway (Node.js 24 / Postgres 16)
**Date:** March 2026
**Classification:** Enterprise — Restricted Distribution

---

## 3.1 Overview

The Node.js POS Gateway exists for one reason: **to protect ERPNext from the operational reality of hundreds of offline-first POS devices syncing simultaneously at the end of a trading day at Makola Market.**

ERPNext is the system of record — authoritative, transactional, and not designed to absorb uncontrolled burst traffic from field-deployed hardware. The Gateway sits between the Flutter POS fleet and ERPNext as a disciplined intermediary: authenticating POS sessions at the edge, enforcing device exclusivity, absorbing sync bursts into a managed queue, caching tax configuration for fast POS distribution, and transforming action payloads into ERPNext-compatible API calls.

This section defines every responsibility the Gateway holds and, equally importantly, the responsibilities it explicitly does not.

---

## 3.2 Gateway Responsibility Map

| # | Responsibility | Category | Section |
|---|----------------|----------|---------|
| 1 | Single Active Device Enforcement | Device Management | 3.3 |
| 2 | Edge Authentication & Offline Login Provisioning | Authentication | 3.4 |
| 3 | Rate Limiting & Sync Burst Absorption | Traffic Management | 3.5 |
| 4 | Tax Rate Caching & Distribution | Data Caching | 3.6 |
| 5 | Offline Sync Queue Management | Core Feature | Section 4 |
| 6 | Payload Validation & Transformation | Data Integrity | Section 5 |
| 7 | Error Handling & Dead Letter Queues | Resilience | Section 7 |

### What the Gateway Does NOT Do

This table is normative. Any feature request or implementation that shifts these responsibilities into the Gateway must be rejected or escalated for architectural review.

| Excluded Responsibility | Authoritative Owner | Rationale |
|------------------------|---------------------|-----------|
| Tax calculation or recalculation | ERPNext (tax engine) | Tax computation is policy-locked by GRA mandate. The Gateway validates; it does not compute. |
| MSME profile creation or modification | ERPNext | Profile lifecycle is a master data operation. The Gateway reads MSME data at login; it never writes it. |
| Susu scheme or loan origination | ERPNext (custom modules) | Financial product management requires full transactional integrity available only in the master platform. |
| User lifecycle management | ERPNext (SSO) | User creation, deactivation, role changes, and credential resets are ERPNext-only operations. |
| GRA Console / Staff Portal serving | React/Vue → ERPNext direct | Web Portal traffic bypasses the Gateway entirely. |
| VAT 3 report generation | ERPNext | Tax report generation is a master platform responsibility triggered after data is reconciled in ERPNext. |
| Payment processing | ERPNext (Phase 2: MoMo) | The Gateway does not handle money movement. |
| Product catalogue management | ERPNext | Product creation, pricing, and categorisation are master data operations. Product creation is strictly online-only and never appears in the offline sync batch. |

---

## 3.3 Single Active Device Enforcement

### 3.3.1 Purpose

The Single Active Device Rule prevents **split-brain offline conflicts** — the scenario where two Sunmi POS devices independently record business operations for the same MSME while offline, producing irreconcilable action histories upon sync. This is not a convenience feature; it is a data integrity guarantee that eliminates an entire class of conflict by architectural fiat.

### 3.3.2 The `active_devices` Table

The enforcement mechanism is the `active_devices` table in the Gateway's Postgres 16 database. The table uses `msme_id` as its **primary key**, meaning the database physically cannot store two active device registrations for the same MSME. This is a schema-level constraint — not application logic that can be bypassed.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `msme_id` | UUID | **PK** | One row per MSME; structural single-device enforcement |
| `device_id` | VARCHAR(128) | NOT NULL | Sunmi device serial number currently authorised for POS operations |
| `user_id` | UUID | NOT NULL | The user who activated this device binding |
| `activated_at` | TIMESTAMPTZ | NOT NULL, DEFAULT now() | Timestamp of device registration |
| `last_seen_at` | TIMESTAMPTZ | NOT NULL | Updated on every successful Gateway interaction (login, sync, token refresh) |

### 3.3.3 Enforcement Logic

Every `POST /auth/login` request from a POS device includes a `device_id` (Sunmi device serial). After successful credential validation via ERPNext SSO, the Gateway executes the following decision:

```
FUNCTION check_device_exclusivity(msme_id, incoming_device_id):

  row = SELECT * FROM active_devices WHERE msme_id = :msme_id

  IF row IS NULL:
    -- No active device for this MSME. Register incoming device.
    INSERT INTO active_devices (msme_id, device_id, user_id, activated_at, last_seen_at)
    VALUES (:msme_id, :incoming_device_id, :user_id, now(), now())
    RETURN ALLOW

  IF row.device_id == incoming_device_id:
    -- Same device re-authenticating. Update last_seen and proceed.
    UPDATE active_devices SET last_seen_at = now() WHERE msme_id = :msme_id
    RETURN ALLOW

  -- A DIFFERENT device is attempting to log in while another is active.
  RETURN REJECT 409 DEVICE_CONFLICT
```

### 3.3.4 Conflict Response

When the Gateway rejects a login due to device conflict, the response is:

```json
{
  "error": "DEVICE_CONFLICT",
  "status": 409,
  "active_device_id": "SN-XXXX-****",
  "activated_at": "2026-03-15T08:30:00Z",
  "last_seen_at": "2026-03-28T14:22:00Z",
  "message": "Another device is currently active for this MSME. Contact your Programme Staff to transfer devices."
}
```

The `active_device_id` is **partially masked** in the response to prevent information leakage while still allowing Programme Staff to identify the device during a transfer procedure.

### 3.3.5 Device Deregistration

| Trigger | Actor | Mechanism | Effect |
|---------|-------|-----------|--------|
| Normal logout | `msme_owner` | `POST /auth/logout` → Gateway deletes `active_devices` row | Slot freed immediately |
| Staff-initiated transfer | `programme_staff` | Web Portal → ERPNext → `POST /admin/devices/transfer { msme_id, new_device_id }` | Atomic row replacement + old device refresh tokens revoked |
| Admin emergency revocation | `admin` | `DELETE /admin/devices/{msme_id}` | Row deleted + all refresh tokens for old `device_id` revoked |
| Stale device cleanup | System (background job) | `DELETE FROM active_devices WHERE last_seen_at < now() - INTERVAL :threshold` | Devices not seen for 30 days (configurable) are automatically deregistered |

### 3.3.6 Edge Cases

| Scenario | Behaviour |
|----------|-----------|
| Device is factory-reset but same serial number | Same `device_id` → login proceeds (same device re-authenticating). Cached local data is lost; user must complete fresh online login. |
| MSME owner is assigned a replacement Sunmi device | New `device_id` → `409 DEVICE_CONFLICT`. Programme Staff must perform a device transfer before the new device can authenticate. |
| Device is offline for 30+ days, then comes back online | Background job has deregistered it. Device must re-authenticate online; Gateway will register it as a new active device if no other device has claimed the slot. |
| Programme Staff logs into a trader's device on behalf of the trader | Staff uses their own credentials with `programme_staff` role. The `active_devices` constraint is keyed on `msme_id`, not `user_id`. If the device is already the active device for the MSME's scope, login proceeds. |

---

## 3.4 Edge Authentication & Offline Login Provisioning

### 3.4.1 Authentication Delegation Model

The Gateway does not store passwords, PINs, or any credential material. All credential verification is delegated to ERPNext SSO. The Gateway's role in authentication is limited to:

1. **Proxying** credential validation requests to ERPNext SSO
2. **Issuing** short-lived Edge JWTs and refresh tokens upon successful validation
3. **Enforcing** the Single Active Device Rule before issuing tokens
4. **Provisioning** the POS device with the data it needs to operate offline

### 3.4.2 Offline Login Provisioning

When a POS device successfully authenticates online, the Gateway returns a response payload that the Flutter app caches locally for offline operation. This cached data is the **entire basis for offline functionality** — without it, the device cannot operate.

| Provisioned Data | Source | Cached In | Purpose |
|-----------------|--------|-----------|---------|
| Edge JWT (access token) | Gateway-generated | Drift (secure storage) | Authorise sync requests when connectivity returns |
| Refresh token | Gateway-generated | Drift (secure storage) | Obtain new access tokens without full re-authentication |
| User profile | ERPNext (via SSO response) | Drift | Populate local authorization context (`user_id`, `role`, `msme_id`, `zone`, `district`) |
| PIN hash (bcrypt) | ERPNext (via SSO response) | Drift (secure storage) | Validate offline PIN unlock without network access |
| Tax rates | Gateway `cached_tax_rates` table | Drift | Enable offline tax computation on sales |
| Product catalogue snapshot | ERPNext (via Gateway proxy) | Drift | Enable offline product lookup and sale entry |

### 3.4.3 What "Offline Login" Is — And Is Not

**"Offline login" is strictly the unlocking of a previously authenticated local session using a PIN.** It is not a login in any authentication sense. No tokens are issued. No Gateway or ERPNext communication occurs.

| Operation | Online Required | Rationale |
|-----------|----------------|-----------|
| First-time login on a device | **Yes** | Gateway must validate credentials via ERPNext, check `active_devices`, register device, issue tokens, and provision offline data |
| Offline session unlock (PIN) | **No** | PIN validated against locally cached bcrypt hash; existing session resumes |
| PIN or password reset | **Yes** | Credential changes are mastered in ERPNext SSO |
| User account creation | **Yes** | User lifecycle is ERPNext-only |
| Device transfer | **Yes** | Requires Gateway `active_devices` table mutation |
| Token refresh | **Yes** | Requires Gateway Postgres lookup |
| Sync (transmit outbox) | **Yes** | Requires Gateway endpoint and valid access token |
| Record sales/expenses locally | **No** | Fully offline; data stored in SQLite/Drift outbox |

### 3.4.4 Offline PIN Unlock — Security Controls

| Control | Specification |
|---------|--------------|
| PIN storage | Bcrypt hash only; plaintext PIN is never persisted on device |
| Failed attempt limit | 5 consecutive failures → device locks |
| Lockout recovery | Online re-authentication required; the Gateway re-provisions the session |
| PIN change | Online-only; new PIN hash provisioned on next successful online login |
| Session validity | Offline operations continue indefinitely. Sync requires a non-expired access token. If the refresh token has expired (>7 days offline), full online re-authentication is required. |

---

## 3.5 Rate Limiting & Sync Burst Absorption

### 3.5.1 The Problem

At the close of a trading day at Makola Market, hundreds of Sunmi POS devices come online simultaneously — either through Wi-Fi at collection points or through mobile data connectivity restored after market hours. Each device may carry a full day's outbox: dozens to hundreds of typed actions accumulated over 8–12 hours of offline operation.

If all devices hit ERPNext directly, the resulting burst would overwhelm ERPNext's API capacity, causing timeouts, partial writes, and potential data corruption. The Gateway exists specifically to absorb this burst and regulate the flow into ERPNext at a sustainable rate.

### 3.5.2 Rate Limiting Strategy

The Gateway implements rate limiting at three tiers:

| Tier | Scope | Mechanism | Limit (Phase 1 Defaults) |
|------|-------|-----------|--------------------------|
| **Per-Device** | Individual POS device (`device_id`) | Token bucket | 10 requests/minute to `/sync/batch`; burst allowance of 3 |
| **Per-MSME** | Business entity (`msme_id`) | Sliding window | 30 sync requests/hour (accommodates retry scenarios) |
| **Global Gateway** | All inbound POS traffic | Fixed window | 500 concurrent sync processing slots; excess requests queued with backpressure |

### 3.5.3 Backpressure Mechanism

When the global sync processing capacity is saturated, the Gateway does **not** reject requests. Instead, it applies backpressure:

```
1. POS sends POST /sync/batch
2. Gateway validates auth + payload structure
3. Gateway checks global processing capacity
4. IF capacity available:
   → Accept batch, write to sync_queue_logs, return 202 Accepted
5. IF capacity saturated:
   → Accept batch, write to sync_queue_logs with status = 'queued'
   → Return 202 Accepted with header X-Queue-Position: {n}
   → Process when capacity frees
6. IF device rate limit exceeded:
   → Return 429 Too Many Requests with Retry-After header
```

**Critical design decision:** The Gateway always accepts and persists valid batches, even under load. A `202 Accepted` means the data is safely stored in `sync_queue_logs` and will be processed. The POS can mark the batch as transmitted. Data loss due to Gateway capacity constraints is architecturally eliminated.

### 3.5.4 ERPNext Forwarding Rate

The Gateway feeds actions into ERPNext at a controlled, configurable rate:

| Parameter | Default | Description |
|-----------|---------|-------------|
| `ERPNEXT_MAX_CONCURRENT_REQUESTS` | 20 | Maximum simultaneous API calls to ERPNext |
| `ERPNEXT_REQUEST_INTERVAL_MS` | 100 | Minimum interval between sequential requests to the same ERPNext endpoint |
| `ERPNEXT_CIRCUIT_BREAKER_THRESHOLD` | 5 consecutive failures | Trips the circuit breaker, pausing all ERPNext forwarding for `ERPNEXT_CIRCUIT_BREAKER_COOLDOWN_MS` |
| `ERPNEXT_CIRCUIT_BREAKER_COOLDOWN_MS` | 30000 | Cooldown period before retrying after circuit breaker trips |

### 3.5.5 Circuit Breaker

If ERPNext becomes unresponsive or returns repeated 5xx errors, the Gateway activates a circuit breaker:

| State | Behaviour |
|-------|-----------|
| **Closed** (normal) | Actions are forwarded to ERPNext at the configured rate |
| **Open** (tripped) | All ERPNext forwarding is paused. Incoming sync batches are still accepted and queued in `sync_queue_logs`. No data is lost. |
| **Half-Open** (probing) | After the cooldown period, the Gateway sends a single probe request. If it succeeds, the circuit closes. If it fails, the circuit remains open for another cooldown cycle. |

---

## 3.6 Tax Rate Caching & Distribution

### 3.6.1 Purpose

The Flutter POS calculates taxes locally on every sale using cached tax rates. These rates must be current, versioned, and traceable — a sale computed with an outdated rate is a compliance risk under the VAT Act 2013 (Act 870). The Gateway maintains a local Postgres cache of tax rates sourced from ERPNext, serving them to POS devices on request without requiring a direct ERPNext query.

### 3.6.2 The `cached_tax_rates` Table

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | UUID | PK, DEFAULT gen_random_uuid() | Cache record identifier |
| `tax_type` | VARCHAR(64) | NOT NULL | Tax category: `vat_standard`, `vat_flat_rate`, `nhil`, `getfund`, `covid_levy` |
| `rate_percent` | DECIMAL(5,2) | NOT NULL | The percentage rate (e.g., `15.00` for VAT standard, `3.00` for VFRS, `2.50` for NHIL) |
| `vat_status_scope` | VARCHAR(32) | NOT NULL | Which MSME `vat_status` this rate applies to: `not_registered`, `flat_rate`, `standard` |
| `effective_date` | DATE | NOT NULL | The date from which this rate is active. Allows the cache to hold both current and upcoming rates. |
| `version_id` | INTEGER | NOT NULL, UNIQUE per (`tax_type`, `vat_status_scope`) | Monotonically increasing version counter. Enables the POS to record which version it used for each sale, and the Gateway to validate against it during sync. |
| `source_updated_at` | TIMESTAMPTZ | NOT NULL | When this rate was last confirmed against ERPNext |
| `created_at` | TIMESTAMPTZ | NOT NULL, DEFAULT now() | When this cache record was created |

**Indexes:**
- `idx_cached_tax_rates_scope` on (`vat_status_scope`, `effective_date`) — fast lookup for POS distribution by MSME tax regime
- `idx_cached_tax_rates_version` on (`tax_type`, `vat_status_scope`, `version_id`) — fast version validation during sync

### 3.6.3 Tax Rate Refresh Cycle

The Gateway synchronises tax rates from ERPNext on a configurable schedule:

```
1. Background job runs every CACHE_REFRESH_INTERVAL (default: 15 minutes)
2. Gateway calls ERPNext tax configuration API
3. For each tax rate returned:
   a. Compare with existing cached_tax_rates row
   b. If rate is unchanged: update source_updated_at only
   c. If rate has changed or new rate exists:
      - Insert new row with incremented version_id and new effective_date
      - Do NOT delete or overwrite the previous version (historical versions
        are retained for sync validation of offline sales)
4. Log refresh result (rates unchanged / rates updated / ERPNext unreachable)
```

**Historical versions are never deleted** during normal operation. When a POS syncs a sale that was computed offline three days ago, the Gateway must be able to look up the exact `version_id` the POS used and validate the tax computation against that historical rate. Pruning of very old versions (>90 days) is handled by a separate maintenance job.

### 3.6.4 POS Tax Rate Distribution

When a POS device requests current tax rates (typically during login provisioning or periodic background refresh), the Gateway responds with the full rate set applicable to the MSME's `vat_status`:

**Endpoint:** `GET /tax-rates?vat_status={status}`

**Response:**

```json
{
  "vat_status": "standard",
  "rates": [
    {
      "tax_type": "vat_standard",
      "rate_percent": 15.00,
      "effective_date": "2025-01-01",
      "version_id": 42
    },
    {
      "tax_type": "nhil",
      "rate_percent": 2.50,
      "effective_date": "2025-01-01",
      "version_id": 42
    },
    {
      "tax_type": "getfund",
      "rate_percent": 2.50,
      "effective_date": "2025-01-01",
      "version_id": 42
    },
    {
      "tax_type": "covid_levy",
      "rate_percent": 1.00,
      "effective_date": "2025-01-01",
      "version_id": 42
    }
  ],
  "cache_generated_at": "2026-03-28T16:00:00Z"
}
```

For MSMEs under `flat_rate` (VFRS):

```json
{
  "vat_status": "flat_rate",
  "rates": [
    {
      "tax_type": "vat_flat_rate",
      "rate_percent": 3.00,
      "effective_date": "2025-01-01",
      "version_id": 42
    }
  ],
  "cache_generated_at": "2026-03-28T16:00:00Z"
}
```

For MSMEs under `not_registered`:

```json
{
  "vat_status": "not_registered",
  "rates": [],
  "cache_generated_at": "2026-03-28T16:00:00Z"
}
```

### 3.6.5 Version Tracking Contract

The POS **must** record the `version_id` of the tax rates it used when computing each sale. This `version_id` is included in the sync payload (`tax_rate_version` field) and is validated by the Gateway during sync processing (see Section 4). This creates an unbroken chain of traceability:

```
Sale recorded on POS → tax_rate_version: 42
  ↓
Gateway receives sync → looks up version_id 42 in cached_tax_rates
  ↓
Gateway validates: tax math in payload matches rates at version 42
  ↓
Gateway forwards validated action to ERPNext
  ↓
ERPNext stores the sale with the original tax computation intact
```

If a tax rate changes between the time a sale is recorded offline and the time it syncs, the Gateway does **not** recalculate. The sale's tax computation is frozen at the version that was active when the trader recorded it. This is a GRA compliance requirement — historical sales are never retroactively adjusted for subsequent rate changes.

---

## 3.7 Request Routing Summary

| Endpoint | Method | Purpose | Auth Required | Rate Limit Tier |
|----------|--------|---------|---------------|-----------------|
| `/auth/login` | POST | Online login; credential validation, device check, token issuance | None (pre-auth) | 5 attempts/min per phone number |
| `/auth/refresh` | POST | Token rotation | Refresh token | Per-device |
| `/auth/logout` | POST | Session termination; device deregistration | Access token | Per-device |
| `/sync/batch` | POST | Submit offline action outbox | Access token | Per-device + Per-MSME + Global |
| `/sync/status/{batch_id}` | GET | Check batch processing status | Access token | Per-device |
| `/tax-rates` | GET | Fetch current tax rates for MSME's `vat_status` | Access token | Per-device |
| `/admin/devices/transfer` | POST | Staff/admin device transfer | Admin/Staff token (ERPNext SSO) | Per-admin |
| `/admin/devices/{msme_id}` | DELETE | Emergency device revocation | Admin token (ERPNext SSO) | Per-admin |
| `/health` | GET | Gateway health check | None | Unlimited |

---

*End of Section 3 — POS Gateway Responsibilities & Edge Logic*
*Next: Section 4 — Offline Sync Strategy & Queue Management*
