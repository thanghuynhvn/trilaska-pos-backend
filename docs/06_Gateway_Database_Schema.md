# Section 6: Gateway Database Schema

**Document:** TriLiska POS Gateway — Master System Architecture & PRD
**Section:** 06 — Gateway Database Schema (Postgres 16)
**Prepared by:** Trident Aliska Digital Tech Ghana LTD
**Programme:** GRA MSME Tax & Business Management Programme
**Sprint Focus:** POS Backend Gateway (Node.js 24 / Postgres 16)
**Date:** March 2026
**Classification:** Enterprise — Restricted Distribution

---

## 6.1 Overview

The POS Gateway's Postgres 16 database serves exactly four operational concerns:

1. **Edge session management** — tracking refresh tokens for POS device JWT lifecycles
2. **Device exclusivity** — enforcing the Single Active Device Rule per MSME
3. **Sync queue processing** — persisting the Action Queue / Outbox Pattern with idempotency, state machine tracking, and dead letter handling
4. **Tax rate caching** — maintaining a versioned, read-only replica of GRA Modified Tax System rates for fast POS distribution

These four concerns map to exactly four tables. There are no others.

---

## 6.2 Scope Constraint

> **ARCHITECTURAL CONSTRAINT — REITERATED:**
>
> The Gateway database does **NOT** contain tables for products, MSME profiles, customers, sales, expenses, Susu schemes, loans, stock, payments, or any other business entity. This data is mastered in ERPNext. The Gateway accesses it via the ERP Adapter layer (Section 5) — either proxied from ERPNext in live mode or served from static JSON fixtures in mock mode.
>
> The four tables defined in this section are the **exhaustive, complete set** of Gateway-owned Postgres tables. Creating additional tables requires explicit architectural review and approval.

### Permitted Tables

| # | Table | Concern | Permanent or Transient |
|---|-------|---------|----------------------|
| 1 | `refresh_tokens` | Edge JWT session management | Permanent — core Gateway responsibility |
| 2 | `active_devices` | Single Active Device enforcement | Permanent — core Gateway responsibility |
| 3 | `sync_queue_logs` | Action Queue processing and idempotency | Permanent — core Gateway responsibility |
| 4 | `cached_tax_rates` | GRA tax rate distribution to POS devices | Permanent — core Gateway responsibility |

---

## 6.3 Database Configuration

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| Engine | PostgreSQL 16 | LTS target; native UUID, JSONB, TIMESTAMPTZ support |
| Character set | `UTF-8` | Required for Ghanaian diacritics in free-text fields (e.g., collector notes in Susu contributions) |
| Timezone | `UTC` | All timestamps stored as `TIMESTAMPTZ` in UTC. Conversion to WAT (West Africa Time, UTC+0) is a presentation concern handled by clients. |
| Schema | `public` | Single schema; no multi-tenancy at the database level |
| Connection pooling | Application-level (e.g., `pg` pool or `pgBouncer`) | Required for burst absorption during end-of-day sync from Makola Market |

---

## 6.4 Table 1: `refresh_tokens`

### 6.4.1 Purpose

Stores hashed refresh tokens issued by the Gateway during POS device authentication. Supports token rotation, family-based revocation (detecting stolen token reuse), per-device session tracking, and background cleanup of expired tokens.

### 6.4.2 Schema

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | `UUID` | `PRIMARY KEY DEFAULT gen_random_uuid()` | Unique record identifier. Postgres 16 native UUID generation — no extension required. |
| `user_id` | `UUID` | `NOT NULL` | Maps to the ERPNext user record. Used for user-scoped revocation (e.g., user deactivated in ERPNext). |
| `device_id` | `VARCHAR(128)` | `NOT NULL` | Sunmi device serial number. Used for device-scoped revocation (e.g., device lost or stolen). |
| `token_hash` | `VARCHAR(256)` | `NOT NULL UNIQUE` | SHA-256 hash of the opaque refresh token. **Plaintext token is never stored.** The UNIQUE constraint prevents hash collisions from creating ambiguous lookups. |
| `token_family` | `UUID` | `NOT NULL` | Groups all tokens in a single rotation chain. When a rotated-out token is reused (indicating theft), the entire family is revoked. Generated once at initial login; inherited across rotations. |
| `rotation_count` | `INTEGER` | `NOT NULL DEFAULT 0` | Number of times this family has been rotated. Used to enforce a maximum rotation count before requiring full re-authentication via ERPNext SSO. |
| `expires_at` | `TIMESTAMPTZ` | `NOT NULL` | Absolute expiry timestamp (UTC). Tokens past this time are invalid regardless of other state. Default lifetime: 7 days from issuance. |
| `revoked_at` | `TIMESTAMPTZ` | `NULLABLE` | Set when the token is explicitly revoked (logout, rotation, family revocation, admin action). A non-null value means the token is invalid. |
| `created_at` | `TIMESTAMPTZ` | `NOT NULL DEFAULT now()` | Record creation timestamp (UTC). |

### 6.4.3 Indexes

| Index Name | Columns | Type | Rationale |
|------------|---------|------|-----------|
| `pk_refresh_tokens` | `id` | Primary Key (B-tree) | Record lookup by ID. |
| `uq_refresh_tokens_token_hash` | `token_hash` | Unique (B-tree) | **Token validation hot path.** Every `POST /auth/refresh` request hashes the incoming token and looks up this index. Must be unique to prevent ambiguous matches. |
| `idx_refresh_tokens_user_id` | `user_id` | B-tree | **User-scoped revocation.** When a user is deactivated in ERPNext, the Gateway revokes all their refresh tokens: `UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = :user_id AND revoked_at IS NULL`. |
| `idx_refresh_tokens_device_id` | `device_id` | B-tree | **Device-scoped revocation.** When a device is reported lost/stolen, all tokens for that device are revoked: `UPDATE refresh_tokens SET revoked_at = now() WHERE device_id = :device_id AND revoked_at IS NULL`. |
| `idx_refresh_tokens_token_family` | `token_family` | B-tree | **Family revocation on reuse detection.** If a previously rotated token is presented, the entire family is revoked: `UPDATE refresh_tokens SET revoked_at = now() WHERE token_family = :family AND revoked_at IS NULL`. This is the stolen-token detection mechanism. |
| `idx_refresh_tokens_expires_at` | `expires_at` | B-tree | **Expired token cleanup.** Background job periodically purges expired tokens: `DELETE FROM refresh_tokens WHERE expires_at < now()`. Index enables efficient range scan. |

### 6.4.4 DDL

```sql
CREATE TABLE refresh_tokens (
    id              UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID            NOT NULL,
    device_id       VARCHAR(128)    NOT NULL,
    token_hash      VARCHAR(256)    NOT NULL UNIQUE,
    token_family    UUID            NOT NULL,
    rotation_count  INTEGER         NOT NULL DEFAULT 0,
    expires_at      TIMESTAMPTZ     NOT NULL,
    revoked_at      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ     NOT NULL DEFAULT now()
);

CREATE INDEX idx_refresh_tokens_user_id
    ON refresh_tokens (user_id);

CREATE INDEX idx_refresh_tokens_device_id
    ON refresh_tokens (device_id);

CREATE INDEX idx_refresh_tokens_token_family
    ON refresh_tokens (token_family);

CREATE INDEX idx_refresh_tokens_expires_at
    ON refresh_tokens (expires_at);
```

### 6.4.5 Maintenance Operations

| Operation | Schedule | Query |
|-----------|----------|-------|
| Purge expired tokens | Every 1 hour | `DELETE FROM refresh_tokens WHERE expires_at < now();` |
| Purge revoked tokens older than 30 days | Daily | `DELETE FROM refresh_tokens WHERE revoked_at IS NOT NULL AND revoked_at < now() - INTERVAL '30 days';` |

---

## 6.5 Table 2: `active_devices`

### 6.5.1 Purpose

Enforces the **Single Active Device Rule**: at any point in time, exactly one Sunmi POS device may be the active terminal for a given MSME. The table uses `msme_id` as its primary key, meaning the database **physically cannot store two active device registrations for the same MSME**. This is a schema-level constraint — not application logic.

### 6.5.2 Schema

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `msme_id` | `UUID` | `PRIMARY KEY` | One row per MSME. The primary key constraint structurally enforces single-device exclusivity — an `INSERT` for an `msme_id` that already exists will fail with a unique violation. There is no auto-generated surrogate key; the business identifier is the key. |
| `device_id` | `VARCHAR(128)` | `NOT NULL` | Sunmi device serial number currently authorised for POS operations for this MSME. |
| `user_id` | `UUID` | `NOT NULL` | The user who activated this device binding. For `msme_owner`, this is the owner. For `programme_staff` performing a device transfer, this is the staff member. |
| `activated_at` | `TIMESTAMPTZ` | `NOT NULL DEFAULT now()` | Timestamp of when this device was registered as the active POS terminal. |
| `last_seen_at` | `TIMESTAMPTZ` | `NOT NULL` | Updated on every successful Gateway interaction (login, sync batch submission, token refresh). Used by the stale device cleanup job to identify abandoned devices. |

### 6.5.3 Indexes

| Index Name | Columns | Type | Rationale |
|------------|---------|------|-----------|
| `pk_active_devices` | `msme_id` | Primary Key (B-tree) | **Single-device enforcement.** Every login checks `SELECT device_id FROM active_devices WHERE msme_id = :msme_id`. The primary key index makes this a single-row index scan. Also structurally prevents duplicate MSME rows. |
| `idx_active_devices_device_id` | `device_id` | B-tree | **Device-scoped queries.** Used when an admin needs to find which MSME a specific Sunmi device is registered to (e.g., during device recovery or audit). Also supports the admin endpoint `DELETE /admin/devices/{msme_id}` when looking up by device serial. |
| `idx_active_devices_last_seen_at` | `last_seen_at` | B-tree | **Stale device cleanup.** Background job identifies devices not seen for 30+ days: `DELETE FROM active_devices WHERE last_seen_at < now() - INTERVAL :threshold`. Index enables efficient range scan across the table. |

### 6.5.4 DDL

```sql
CREATE TABLE active_devices (
    msme_id         UUID            PRIMARY KEY,
    device_id       VARCHAR(128)    NOT NULL,
    user_id         UUID            NOT NULL,
    activated_at    TIMESTAMPTZ     NOT NULL DEFAULT now(),
    last_seen_at    TIMESTAMPTZ     NOT NULL
);

CREATE INDEX idx_active_devices_device_id
    ON active_devices (device_id);

CREATE INDEX idx_active_devices_last_seen_at
    ON active_devices (last_seen_at);
```

### 6.5.5 Key Operations

| Operation | Query Pattern | Concurrency Note |
|-----------|--------------|-----------------|
| **Check + register on login** | `INSERT INTO active_devices (msme_id, device_id, user_id, last_seen_at) VALUES (:msme_id, :device_id, :user_id, now()) ON CONFLICT (msme_id) DO UPDATE SET device_id = EXCLUDED.device_id, user_id = EXCLUDED.user_id, activated_at = now(), last_seen_at = now() WHERE active_devices.device_id = EXCLUDED.device_id;` Returns 0 rows updated if a *different* device holds the slot → application returns `409 DEVICE_CONFLICT`. | The `ON CONFLICT ... WHERE` clause makes this a single atomic statement. No TOCTOU race between check and insert. |
| **Update last_seen** | `UPDATE active_devices SET last_seen_at = now() WHERE msme_id = :msme_id AND device_id = :device_id;` | Executed on every sync and token refresh. Lightweight single-row update by PK. |
| **Normal logout** | `DELETE FROM active_devices WHERE msme_id = :msme_id AND device_id = :device_id;` | Only deletes if the requesting device is the active one. A stolen device attempting to log out cannot deregister a replacement device. |
| **Admin device transfer** | `INSERT INTO active_devices (msme_id, device_id, user_id, last_seen_at) VALUES (:msme_id, :new_device_id, :admin_user_id, now()) ON CONFLICT (msme_id) DO UPDATE SET device_id = EXCLUDED.device_id, user_id = EXCLUDED.user_id, activated_at = now(), last_seen_at = now();` | Unconditional upsert — admin authority overrides the existing device. |
| **Stale device cleanup** | `DELETE FROM active_devices WHERE last_seen_at < now() - INTERVAL :threshold;` | Scheduled background job (default: 30-day threshold). |

### 6.5.6 Concurrency Guarantee

The `ON CONFLICT` upsert pattern eliminates the classic Time-of-Check-to-Time-of-Use (TOCTOU) race condition. Without it, two devices could simultaneously pass the `SELECT` check and both attempt `INSERT`, with one succeeding and the other failing unpredictably. The single atomic statement ensures that the device check and registration are indivisible.

---

## 6.6 Table 3: `sync_queue_logs`

### 6.6.1 Purpose

The operational heart of the Gateway. Every typed action received from the Flutter POS via `POST /sync/batch` is persisted here. The table serves as:

- **Idempotency store** — the UNIQUE constraint on `client_ref` guarantees exactly-once processing
- **Queue** — the background worker polls for `pending` actions in `recorded_at` order
- **State machine** — tracks each action through `pending` → `processing` → `completed` / `failed`
- **Audit trail** — retains the complete action payload, ERPNext reference, warnings, and failure reasons
- **Dead letter queue** — actions that exhaust retries remain with `status = 'failed'` for manual intervention

### 6.6.2 Schema

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | `UUID` | `PRIMARY KEY DEFAULT gen_random_uuid()` | Unique queue entry identifier. |
| `batch_ref` | `UUID` | `NOT NULL` | The batch this action belongs to. Multiple actions share the same `batch_ref` when submitted in a single `POST /sync/batch` call. Used for batch-level status queries. |
| `client_ref` | `UUID` | `NOT NULL UNIQUE` | **Idempotency key.** Generated on the POS device at action creation time. The UNIQUE constraint ensures that no two rows can exist for the same `client_ref` — the database enforces exactly-once semantics. |
| `msme_id` | `UUID` | `NOT NULL` | MSME that originated this action. Used for MSME-scoped status queries and audit. |
| `device_id` | `VARCHAR(128)` | `NOT NULL` | Sunmi device serial that submitted this action. Recorded for traceability. |
| `action_type` | `VARCHAR(32)` | `NOT NULL` | One of: `CREATE_SALE`, `STOCK_MOVEMENT`, `RECORD_EXPENSE`, `SUSU_CONTRIBUTION`, `LOAN_REPAYMENT`. |
| `recorded_at` | `TIMESTAMPTZ` | `NOT NULL` | **Business timestamp.** The moment the action was performed on the POS device (UTC). This is the ordering key for chronological replay — not `created_at` or `received_at`. |
| `tax_rate_version` | `INTEGER` | `NULLABLE` | The `version_id` from `cached_tax_rates` that the POS used to compute this action's tax values. Required for `CREATE_SALE`; null for all other action types. |
| `payload` | `JSONB` | `NOT NULL` | The complete, self-contained action payload as defined in Section 4.5. Stored as `JSONB` for indexable, queryable structured data. JSONB is preferred over JSON for binary storage efficiency and operator support in Postgres 16. |
| `status` | `VARCHAR(16)` | `NOT NULL DEFAULT 'pending'` | Current state in the queue lifecycle. Allowed values: `pending`, `processing`, `completed`, `failed`. See Section 4.10.3 for state machine definitions. |
| `retry_count` | `INTEGER` | `NOT NULL DEFAULT 0` | Number of processing attempts. Incremented on each retryable failure. When `retry_count >= max_retries`, the action transitions to `failed`. |
| `max_retries` | `INTEGER` | `NOT NULL DEFAULT 5` | Maximum retry attempts before the action is moved to `failed` (dead letter). Configurable per action if needed, but defaults to 5 for all types. |
| `failure_reason` | `TEXT` | `NULLABLE` | Human-readable description of why the action failed. Populated when `status = 'failed'`. Includes the ERPNext error response body for diagnostic purposes. |
| `erpnext_ref` | `VARCHAR(128)` | `NULLABLE` | ERPNext document reference returned on successful creation. Examples: `SI-2026-00042` (Sales Invoice), `SE-2026-00015` (Stock Entry), `SC-2026-00008` (Susu Contribution). Populated when `status = 'completed'`. In mock mode, values follow the `{PREFIX}-MOCK-{seq}` pattern. |
| `warnings` | `JSONB` | `NULLABLE` | Array of non-fatal warning objects generated during validation. Examples: `TAX_VERSION_MISMATCH`, `MATH_ROUNDED`. Stored as JSONB to support structured querying (e.g., find all actions with tax version mismatches for a given MSME). |
| `received_at` | `TIMESTAMPTZ` | `NOT NULL DEFAULT now()` | When the Gateway received and persisted this action. Distinct from `recorded_at` (business time) — the delta between `recorded_at` and `received_at` represents the offline duration. |
| `processing_started_at` | `TIMESTAMPTZ` | `NULLABLE` | When the background worker began processing this action. Used for monitoring worker throughput and detecting stuck actions. |
| `completed_at` | `TIMESTAMPTZ` | `NULLABLE` | When processing completed — either successfully (`status = 'completed'`) or terminally (`status = 'failed'` after exhausting retries). |
| `created_at` | `TIMESTAMPTZ` | `NOT NULL DEFAULT now()` | Record creation timestamp. |

### 6.6.3 Indexes

| Index Name | Columns | Type | Rationale |
|------------|---------|------|-----------|
| `pk_sync_queue_logs` | `id` | Primary Key (B-tree) | Record lookup by ID. |
| `uq_sync_queue_logs_client_ref` | `client_ref` | Unique (B-tree) | **Idempotency enforcement.** Every incoming action is checked against this index before insertion. The UNIQUE constraint ensures that a duplicate `client_ref` submission results in a constraint violation, which the application handles as an idempotent success response. This is the most critical constraint in the entire Gateway database. |
| `idx_sync_queue_logs_batch_ref` | `batch_ref` | B-tree | **Batch status queries.** `GET /sync/status/{batch_ref}` retrieves all actions belonging to a batch: `SELECT client_ref, action_type, status, erpnext_ref, failure_reason FROM sync_queue_logs WHERE batch_ref = :batch_ref`. |
| `idx_sync_queue_logs_status_recorded_at` | `(status, recorded_at)` | Composite B-tree | **Chronological queue polling.** The background worker selects the next action to process: `SELECT * FROM sync_queue_logs WHERE status = 'pending' ORDER BY recorded_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED`. The composite index enables a fast range scan within a specific status, ordered by business timestamp. The `FOR UPDATE SKIP LOCKED` pattern ensures multiple workers can poll concurrently without contention. |
| `idx_sync_queue_logs_msme_id` | `msme_id` | B-tree | **MSME-scoped queries.** Programme Staff and admin dashboards query sync status by MSME: `SELECT * FROM sync_queue_logs WHERE msme_id = :msme_id ORDER BY recorded_at DESC`. Also supports rate limiting per-MSME sync requests. |
| `idx_sync_queue_logs_status_failed` | `(status) WHERE status = 'failed'` | Partial B-tree | **Dead letter queue monitoring.** Partial index covering only failed actions. Enables fast DLQ queries without scanning the entire table: `SELECT * FROM sync_queue_logs WHERE status = 'failed' ORDER BY completed_at DESC`. Compact because only a small fraction of actions should be in `failed` state. |
| `idx_sync_queue_logs_device_id` | `device_id` | B-tree | **Device-scoped audit.** Supports queries for all actions submitted by a specific Sunmi device, useful for debugging sync issues or investigating a specific device's history. |

### 6.6.4 DDL

```sql
CREATE TABLE sync_queue_logs (
    id                      UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    batch_ref               UUID            NOT NULL,
    client_ref              UUID            NOT NULL UNIQUE,
    msme_id                 UUID            NOT NULL,
    device_id               VARCHAR(128)    NOT NULL,
    action_type             VARCHAR(32)     NOT NULL,
    recorded_at             TIMESTAMPTZ     NOT NULL,
    tax_rate_version        INTEGER,
    payload                 JSONB           NOT NULL,
    status                  VARCHAR(16)     NOT NULL DEFAULT 'pending',
    retry_count             INTEGER         NOT NULL DEFAULT 0,
    max_retries             INTEGER         NOT NULL DEFAULT 5,
    failure_reason          TEXT,
    erpnext_ref             VARCHAR(128),
    warnings                JSONB,
    received_at             TIMESTAMPTZ     NOT NULL DEFAULT now(),
    processing_started_at   TIMESTAMPTZ,
    completed_at            TIMESTAMPTZ,
    created_at              TIMESTAMPTZ     NOT NULL DEFAULT now()
);

CREATE INDEX idx_sync_queue_logs_batch_ref
    ON sync_queue_logs (batch_ref);

CREATE INDEX idx_sync_queue_logs_status_recorded_at
    ON sync_queue_logs (status, recorded_at);

CREATE INDEX idx_sync_queue_logs_msme_id
    ON sync_queue_logs (msme_id);

CREATE INDEX idx_sync_queue_logs_status_failed
    ON sync_queue_logs (status)
    WHERE status = 'failed';

CREATE INDEX idx_sync_queue_logs_device_id
    ON sync_queue_logs (device_id);
```

### 6.6.5 Worker Polling Pattern

The background worker uses Postgres' `FOR UPDATE SKIP LOCKED` advisory locking to safely dequeue actions in a concurrent environment:

```sql
-- Worker picks up the next pending action in chronological order
-- SKIP LOCKED ensures multiple workers don't compete for the same row
BEGIN;

UPDATE sync_queue_logs
SET status = 'processing',
    processing_started_at = now()
WHERE id = (
    SELECT id FROM sync_queue_logs
    WHERE status = 'pending'
    ORDER BY recorded_at ASC
    LIMIT 1
    FOR UPDATE SKIP LOCKED
)
RETURNING *;

-- Worker processes the action (forwards to ERPNext or mock)
-- On success:
UPDATE sync_queue_logs
SET status = 'completed',
    erpnext_ref = :ref,
    completed_at = now()
WHERE id = :id;

-- On retryable failure:
UPDATE sync_queue_logs
SET status = CASE
        WHEN retry_count + 1 >= max_retries THEN 'failed'
        ELSE 'pending'
    END,
    retry_count = retry_count + 1,
    failure_reason = :reason,
    completed_at = CASE
        WHEN retry_count + 1 >= max_retries THEN now()
        ELSE NULL
    END
WHERE id = :id;

COMMIT;
```

### 6.6.6 Retention Policy

| Data Category | Retention Period | Rationale |
|---------------|-----------------|-----------|
| Completed actions | 90 days | Sufficient for reconciliation and audit within the current GRA reporting cycle. After 90 days, ERPNext is the authoritative record. |
| Failed actions (DLQ) | Indefinite (until resolved) | Failed actions remain for manual intervention. They are never auto-purged. |
| Action payloads (JSONB) | Same as parent row | Payloads are retained with the row for diagnostic and audit purposes. |

**Archival query (scheduled job):**

```sql
DELETE FROM sync_queue_logs
WHERE status = 'completed'
AND completed_at < now() - INTERVAL '90 days';
```

---

## 6.7 Table 4: `cached_tax_rates`

### 6.7.1 Purpose

Maintains a versioned, read-only cache of GRA Modified Tax System rates sourced from ERPNext (live mode) or seed data (mock mode). The Flutter POS downloads these rates from `GET /tax-rates` and uses them for local offline tax computation on sales. Historical versions are retained so the Gateway can validate the `tax_rate_version` submitted with each `CREATE_SALE` action during sync.

### 6.7.2 Schema

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | `UUID` | `PRIMARY KEY DEFAULT gen_random_uuid()` | Unique cache record identifier. |
| `tax_type` | `VARCHAR(64)` | `NOT NULL` | Tax category identifier. Allowed values: `vat_standard`, `vat_flat_rate`, `nhil`, `getfund`, `covid_levy`. Each corresponds to a component of the GRA tax regime structure under the VAT Act 2013 (Act 870). |
| `rate_percent` | `DECIMAL(5,2)` | `NOT NULL` | The percentage rate. Examples: `15.00` (VAT standard), `3.00` (VFRS flat rate), `2.50` (NHIL, GETFund), `1.00` (COVID Levy). Stored as `DECIMAL(5,2)` for exact arithmetic — floating point is not acceptable for tax computation. |
| `vat_status_scope` | `VARCHAR(32)` | `NOT NULL` | Specifies which MSME `vat_status` regime this rate applies to. Allowed values: `not_registered`, `flat_rate`, `standard`. Enables the `GET /tax-rates?vat_status={status}` endpoint to return only the rates relevant to a specific MSME. |
| `effective_date` | `DATE` | `NOT NULL` | The date from which this rate is active. Allows the cache to hold both current and future-dated rates (e.g., a GRA rate change announced in advance). Historical rates are retained for tax version validation. |
| `version_id` | `INTEGER` | `NOT NULL` | Monotonically increasing version counter scoped to (`tax_type`, `vat_status_scope`). When a rate changes, a new row is inserted with `version_id` incremented. The POS records this value as `tax_rate_version` in each sale action, and the Gateway validates against it during sync. |
| `source_updated_at` | `TIMESTAMPTZ` | `NOT NULL` | When this rate was last confirmed against ERPNext (live mode) or set at startup (mock mode). Used for cache staleness monitoring. |
| `created_at` | `TIMESTAMPTZ` | `NOT NULL DEFAULT now()` | Record creation timestamp. |

### 6.7.3 Indexes

| Index Name | Columns | Type | Rationale |
|------------|---------|------|-----------|
| `pk_cached_tax_rates` | `id` | Primary Key (B-tree) | Record lookup by ID. |
| `uq_cached_tax_rates_version` | `(tax_type, vat_status_scope, version_id)` | Unique Composite (B-tree) | **Version uniqueness.** Ensures that for any given tax type and regime scope, each `version_id` maps to exactly one rate. Prevents accidental duplicate version insertion during the refresh cycle. |
| `idx_cached_tax_rates_scope_effective` | `(vat_status_scope, effective_date)` | Composite B-tree | **POS tax rate distribution.** The `GET /tax-rates?vat_status={status}` endpoint queries: `SELECT * FROM cached_tax_rates WHERE vat_status_scope = :status AND effective_date <= CURRENT_DATE ORDER BY effective_date DESC, version_id DESC`. The composite index enables a fast range scan by scope and date. |
| `idx_cached_tax_rates_version_lookup` | `(tax_type, vat_status_scope, version_id)` | Composite B-tree (same as unique constraint) | **Tax version validation during sync.** When the Gateway receives a `CREATE_SALE` with `tax_rate_version: 42`, it queries: `SELECT rate_percent FROM cached_tax_rates WHERE version_id = :version AND vat_status_scope = :scope`. The unique composite index makes this a single-row index scan. |

### 6.7.4 DDL

```sql
CREATE TABLE cached_tax_rates (
    id                  UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    tax_type            VARCHAR(64)     NOT NULL,
    rate_percent        DECIMAL(5,2)    NOT NULL,
    vat_status_scope    VARCHAR(32)     NOT NULL,
    effective_date      DATE            NOT NULL,
    version_id          INTEGER         NOT NULL,
    source_updated_at   TIMESTAMPTZ     NOT NULL,
    created_at          TIMESTAMPTZ     NOT NULL DEFAULT now(),

    CONSTRAINT uq_cached_tax_rates_version
        UNIQUE (tax_type, vat_status_scope, version_id)
);

CREATE INDEX idx_cached_tax_rates_scope_effective
    ON cached_tax_rates (vat_status_scope, effective_date);
```

### 6.7.5 Rate Reference — GRA Modified Tax System

For clarity, the following rates are the current GRA Modified Tax System rates that will populate this table at Phase 1 launch:

| `tax_type` | `rate_percent` | `vat_status_scope` | Legislative Basis |
|------------|---------------|-------------------|-------------------|
| `vat_standard` | `15.00` | `standard` | VAT Act 2013 (Act 870) — standard rate |
| `nhil` | `2.50` | `standard` | National Health Insurance Levy |
| `getfund` | `2.50` | `standard` | Ghana Education Trust Fund Levy |
| `covid_levy` | `1.00` | `standard` | COVID-19 Health Recovery Levy |
| `vat_flat_rate` | `3.00` | `flat_rate` | VAT Act 2013 (Act 870) — VAT Flat Rate Scheme (VFRS) |

MSMEs with `vat_status = 'not_registered'` have no applicable tax rates (0% — exempt below GHS 200,000 annual turnover). The `GET /tax-rates?vat_status=not_registered` endpoint returns an empty `rates` array.

### 6.7.6 Version Lifecycle

```
Day 1: GRA VFRS rate is 3.00%
  → cached_tax_rates row: tax_type='vat_flat_rate', rate_percent=3.00,
    vat_status_scope='flat_rate', effective_date='2025-01-01', version_id=1

Day 180: GRA announces VFRS rate change to 4.00%, effective 2026-07-01
  → New row inserted: tax_type='vat_flat_rate', rate_percent=4.00,
    vat_status_scope='flat_rate', effective_date='2026-07-01', version_id=2
  → Old row (version_id=1) is RETAINED — not deleted, not modified

Day 181: A POS syncs a sale recorded on Day 179 with tax_rate_version=1
  → Gateway looks up version_id=1 → finds rate_percent=3.00 → validates ✓
  → The sale is NOT recalculated at 4.00% — historical computation is preserved

Day 270: Maintenance job prunes versions older than 90 days
  → version_id=1 (effective_date='2025-01-01') is now >90 days old
  → version_id=1 is deleted — no POS should be syncing sales from 90+ days ago
```

### 6.7.7 Maintenance Operations

| Operation | Schedule | Query |
|-----------|----------|-------|
| Prune historical versions older than 90 days | Weekly | `DELETE FROM cached_tax_rates WHERE effective_date < CURRENT_DATE - INTERVAL '90 days' AND version_id < (SELECT MAX(version_id) FROM cached_tax_rates c2 WHERE c2.tax_type = cached_tax_rates.tax_type AND c2.vat_status_scope = cached_tax_rates.vat_status_scope);` |
| Staleness alert | Every 30 minutes | `SELECT * FROM cached_tax_rates WHERE source_updated_at < now() - INTERVAL '1 hour';` — if any rows are stale, emit an operational alert (ERPNext sync may be failing). |

---

## 6.8 Complete Migration Script

The following is the complete, ordered DDL for initialising the Gateway database from scratch. This script is idempotent — safe to run on an existing database without data loss.

```sql
-- ============================================================
-- TriLiska POS Gateway — Postgres 16 Database Schema
-- Version: 1.0.0
-- Date: March 2026
-- ============================================================

-- Enable UUID generation (native in Postgres 16, no extension needed)
-- gen_random_uuid() is available by default.

-- ============================================================
-- Table 1: refresh_tokens
-- Purpose: Edge JWT session management and token rotation
-- ============================================================
CREATE TABLE IF NOT EXISTS refresh_tokens (
    id              UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID            NOT NULL,
    device_id       VARCHAR(128)    NOT NULL,
    token_hash      VARCHAR(256)    NOT NULL UNIQUE,
    token_family    UUID            NOT NULL,
    rotation_count  INTEGER         NOT NULL DEFAULT 0,
    expires_at      TIMESTAMPTZ     NOT NULL,
    revoked_at      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ     NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_id
    ON refresh_tokens (user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_device_id
    ON refresh_tokens (device_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_token_family
    ON refresh_tokens (token_family);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_expires_at
    ON refresh_tokens (expires_at);

-- ============================================================
-- Table 2: active_devices
-- Purpose: Single Active Device Rule enforcement
-- ============================================================
CREATE TABLE IF NOT EXISTS active_devices (
    msme_id         UUID            PRIMARY KEY,
    device_id       VARCHAR(128)    NOT NULL,
    user_id         UUID            NOT NULL,
    activated_at    TIMESTAMPTZ     NOT NULL DEFAULT now(),
    last_seen_at    TIMESTAMPTZ     NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_active_devices_device_id
    ON active_devices (device_id);
CREATE INDEX IF NOT EXISTS idx_active_devices_last_seen_at
    ON active_devices (last_seen_at);

-- ============================================================
-- Table 3: sync_queue_logs
-- Purpose: Action Queue / Outbox Pattern processing
-- ============================================================
CREATE TABLE IF NOT EXISTS sync_queue_logs (
    id                      UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    batch_ref               UUID            NOT NULL,
    client_ref              UUID            NOT NULL UNIQUE,
    msme_id                 UUID            NOT NULL,
    device_id               VARCHAR(128)    NOT NULL,
    action_type             VARCHAR(32)     NOT NULL,
    recorded_at             TIMESTAMPTZ     NOT NULL,
    tax_rate_version        INTEGER,
    payload                 JSONB           NOT NULL,
    status                  VARCHAR(16)     NOT NULL DEFAULT 'pending',
    retry_count             INTEGER         NOT NULL DEFAULT 0,
    max_retries             INTEGER         NOT NULL DEFAULT 5,
    failure_reason          TEXT,
    erpnext_ref             VARCHAR(128),
    warnings                JSONB,
    received_at             TIMESTAMPTZ     NOT NULL DEFAULT now(),
    processing_started_at   TIMESTAMPTZ,
    completed_at            TIMESTAMPTZ,
    created_at              TIMESTAMPTZ     NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sync_queue_logs_batch_ref
    ON sync_queue_logs (batch_ref);
CREATE INDEX IF NOT EXISTS idx_sync_queue_logs_status_recorded_at
    ON sync_queue_logs (status, recorded_at);
CREATE INDEX IF NOT EXISTS idx_sync_queue_logs_msme_id
    ON sync_queue_logs (msme_id);
CREATE INDEX IF NOT EXISTS idx_sync_queue_logs_status_failed
    ON sync_queue_logs (status)
    WHERE status = 'failed';
CREATE INDEX IF NOT EXISTS idx_sync_queue_logs_device_id
    ON sync_queue_logs (device_id);

-- ============================================================
-- Table 4: cached_tax_rates
-- Purpose: Versioned GRA Modified Tax System rate cache
-- ============================================================
CREATE TABLE IF NOT EXISTS cached_tax_rates (
    id                  UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    tax_type            VARCHAR(64)     NOT NULL,
    rate_percent        DECIMAL(5,2)    NOT NULL,
    vat_status_scope    VARCHAR(32)     NOT NULL,
    effective_date      DATE            NOT NULL,
    version_id          INTEGER         NOT NULL,
    source_updated_at   TIMESTAMPTZ     NOT NULL,
    created_at          TIMESTAMPTZ     NOT NULL DEFAULT now(),

    CONSTRAINT uq_cached_tax_rates_version
        UNIQUE (tax_type, vat_status_scope, version_id)
);

CREATE INDEX IF NOT EXISTS idx_cached_tax_rates_scope_effective
    ON cached_tax_rates (vat_status_scope, effective_date);

-- ============================================================
-- Seed: GRA Modified Tax System rates (Phase 1)
-- ============================================================
INSERT INTO cached_tax_rates
    (tax_type, rate_percent, vat_status_scope, effective_date, version_id, source_updated_at)
VALUES
    ('vat_standard',  15.00, 'standard',  '2025-01-01', 1, now()),
    ('nhil',           2.50, 'standard',  '2025-01-01', 1, now()),
    ('getfund',        2.50, 'standard',  '2025-01-01', 1, now()),
    ('covid_levy',     1.00, 'standard',  '2025-01-01', 1, now()),
    ('vat_flat_rate',  3.00, 'flat_rate', '2025-01-01', 1, now())
ON CONFLICT ON CONSTRAINT uq_cached_tax_rates_version DO NOTHING;

-- ============================================================
-- End of schema
-- ============================================================
```

---

## 6.9 Schema Summary

| Table | Row Count Expectation (Phase 1 Pilot) | Growth Pattern | Primary Query Pattern |
|-------|--------------------------------------|----------------|----------------------|
| `refresh_tokens` | Hundreds (active POS sessions × rotation history) | Linear with active device count; pruned by expiry/revocation cleanup | Lookup by `token_hash` (auth hot path) |
| `active_devices` | Tens to low hundreds (one row per active MSME) | Bounded by enrolled MSME count; rows are replaced, not accumulated | Lookup by `msme_id` (login hot path) |
| `sync_queue_logs` | Thousands to tens of thousands (all synced actions) | High write volume during end-of-day sync bursts; pruned after 90 days | Poll by `(status, recorded_at)` (worker hot path); lookup by `client_ref` (idempotency hot path) |
| `cached_tax_rates` | Single digits (5 rates × ~2 versions) | Minimal; grows only when GRA changes tax rates | Lookup by `(vat_status_scope, effective_date)` (POS distribution); lookup by `version_id` (sync validation) |

---

*End of Section 6 — Gateway Database Schema*
*Next: Section 7 — Error Handling, Dead Letter Queues & Retry Mechanisms*
