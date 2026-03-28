# Section 4: Offline Sync Strategy & Queue Management

**Document:** TriLiska POS Gateway — Master System Architecture & PRD
**Section:** 04 — Offline Sync Strategy & Queue Management (Idempotency, Batching, Replay)
**Prepared by:** Trident Aliska Digital Tech Ghana LTD
**Programme:** GRA MSME Tax & Business Management Programme
**Sprint Focus:** POS Backend Gateway (Node.js 24 / Postgres 16)
**Date:** March 2026
**Classification:** Enterprise — Restricted Distribution

---

## 4.1 Overview

The offline sync subsystem is the **core feature** of the POS Gateway. Every other Gateway responsibility — authentication, device management, rate limiting, tax rate caching — exists to support this function.

At Makola Market, a trader records sales, expenses, Susu contributions, and loan repayments throughout the day on a Sunmi POS device with no internet connectivity. At the end of the trading day, the device comes online and transmits its accumulated outbox to the Gateway. The Gateway must receive this batch, deduplicate it, validate every action, queue it for sequential processing, and feed each action into the correct ERPNext API endpoint in the exact chronological order it was recorded — without data loss, without duplication, and without recalculating historical tax computations.

This section defines the sync protocol, the typed batch payload structure, the permitted action types, the idempotency guarantees, the tax version validation rules, the payload math validation, and the queue state machine that governs the lifecycle of every synced action.

---

## 4.2 The Outbox Pattern / Action Queue

### 4.2.1 Pattern Definition

TriLiska uses the **Outbox Pattern** (also known as the Action Queue pattern) for offline sync. The Flutter POS does not transmit raw database rows, table diffs, or unstructured event logs. Every business operation is serialised as a **typed, self-contained action** and appended to a local outbox queue in SQLite/Drift. When connectivity is available, the outbox is transmitted as a chronologically ordered batch to the Gateway.

### 4.2.2 Why This Pattern

| Alternative Considered | Reason Rejected |
|----------------------|-----------------|
| **Row-level sync** (transmit changed database rows) | Leaks internal POS schema to the Gateway; creates tight coupling; makes schema evolution across POS versions dangerous |
| **Event sourcing** (transmit granular UI events) | Excessive payload size; requires the Gateway to replay business logic; violates the principle that the POS is the point of computation |
| **CRDT-based merge** (conflict-free replicated data types) | Unnecessary complexity given the Single Active Device Rule eliminates multi-device conflicts entirely |
| **Full database snapshot sync** | Bandwidth-prohibitive on mobile data; O(n) payload size regardless of changes |

The Outbox Pattern transmits only the **result** of each business operation — a finalized, typed action with all computed values (tax breakdowns, totals, line items) already resolved. The Gateway validates and forwards; it does not re-derive.

---

## 4.3 The Typed Batch Payload

### 4.3.1 Endpoint

```
POST /sync/batch
Authorization: Bearer {access_token}
Content-Type: application/json
```

### 4.3.2 Request Structure

```json
{
  "device_id": "SUNMI-V3P-SN-20260101-0042",
  "msme_id": "a1b2c3d4-...",
  "batch_ref": "batch-uuid-v4",
  "actions": [
    {
      "action_type": "CREATE_SALE",
      "client_ref": "uuid-v4-unique-per-action",
      "recorded_at": "2026-03-28T09:15:32.000Z",
      "tax_rate_version": 42,
      "payload": { ... }
    },
    {
      "action_type": "RECORD_EXPENSE",
      "client_ref": "uuid-v4-unique-per-action",
      "recorded_at": "2026-03-28T09:22:10.000Z",
      "tax_rate_version": null,
      "payload": { ... }
    }
  ]
}
```

### 4.3.3 Batch Envelope Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `device_id` | String | Yes | Sunmi device serial; must match the `device_id` in the access token's JWT claims |
| `msme_id` | UUID | Yes | MSME identifier; must match the `msme_id` in the access token's JWT claims |
| `batch_ref` | UUID v4 | Yes | Unique identifier for this batch submission. Used for batch-level status tracking. |
| `actions` | Array | Yes | Chronologically ordered array of typed actions. Must contain at least 1 action. Maximum 500 actions per batch. |

### 4.3.4 Action Fields

Every action in the `actions` array must contain these fields:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `action_type` | String (enum) | Yes | The type of business operation. Must be one of the permitted values in Section 4.4. |
| `client_ref` | UUID v4 | Yes | Globally unique identifier generated on the POS device at the moment the action was created. This is the **idempotency key**. |
| `recorded_at` | ISO 8601 timestamp | Yes | The exact moment the business operation was performed on the POS device (device local clock, UTC-normalised). This is the **business timestamp** — not the sync timestamp. |
| `tax_rate_version` | Integer (nullable) | Yes | The `version_id` of the tax rates used to compute this action's tax values. `null` for action types that do not involve tax computation (e.g., `RECORD_EXPENSE`, `STOCK_MOVEMENT`). |
| `payload` | Object | Yes | The complete, self-contained data structure for the action. Structure varies by `action_type` (see Section 4.5). |

---

## 4.4 Permitted Action Types

The Gateway will **only** accept the following `action_type` values in the offline batch. Any action with an unrecognised type is rejected with a `422 Unprocessable Entity` error for that specific action.

| `action_type` | Description | Tax Computation | ERPNext Target |
|---------------|-------------|-----------------|----------------|
| `CREATE_SALE` | A completed sale with line items, discounts, tax breakdowns, and payment method | **Yes** — POS computes using cached tax rates; `tax_rate_version` required | ERPNext Sales Invoice API |
| `STOCK_MOVEMENT` | Stock adjustment: received goods, damaged/spoiled write-off, or manual count correction | No | ERPNext Stock Entry API |
| `RECORD_EXPENSE` | A business expense recorded by the trader (e.g., transport, rent, market levy) | No | ERPNext Journal Entry / Expense Claim API |
| `SUSU_CONTRIBUTION` | A daily Susu contribution recorded for the MSME's active Susu scheme | No | ERPNext Custom Susu Module API |
| `LOAN_REPAYMENT` | A repayment against an active micro-loan obligation | No | ERPNext Custom Loan Module API |

### Explicitly Excluded From Offline Sync

| Operation | Reason | Where It Happens |
|-----------|--------|-----------------|
| **Product creation** | Product catalogue is master data managed in ERPNext. Creating products offline would produce unvalidated entries without proper categorisation, pricing rules, or GRA product codes. | ERPNext Web Portal (online-only) |
| **MSME profile creation** | MSME registration requires Ghana Card and TIN validation, zone assignment, and programme reference generation — all ERPNext-mastered operations. | ERPNext Web Portal (online-only) |
| **Tax regime changes** | `vat_status` transitions are compliance-sensitive, audit-logged, and require `programme_staff` or `admin` authorisation via ERPNext. | ERPNext Web Portal (online-only) |
| **Void / reversal** | Voids require cross-referencing the original transaction in ERPNext to ensure it exists and has not already been voided. This cannot be safely performed offline. | ERPNext Web Portal (online-only) |
| **User account operations** | User creation, deactivation, and credential changes are ERPNext SSO operations. | ERPNext (online-only) |

---

## 4.5 Payload Structures by Action Type

### 4.5.1 `CREATE_SALE` Payload

```json
{
  "sale_ref": "client-generated-sale-id",
  "customer_id": "uuid-or-null-for-walk-in",
  "items": [
    {
      "product_id": "erpnext-product-uuid",
      "product_name": "Bag of Rice (50kg)",
      "quantity": 2,
      "unit_price": 350.00,
      "discount_amount": 10.00,
      "line_total_before_tax": 690.00,
      "tax_lines": [
        {
          "tax_type": "vat_standard",
          "rate_percent": 15.00,
          "tax_amount": 103.50
        },
        {
          "tax_type": "nhil",
          "rate_percent": 2.50,
          "tax_amount": 17.25
        },
        {
          "tax_type": "getfund",
          "rate_percent": 2.50,
          "tax_amount": 17.25
        },
        {
          "tax_type": "covid_levy",
          "rate_percent": 1.00,
          "tax_amount": 6.90
        }
      ],
      "line_total_after_tax": 834.90
    }
  ],
  "subtotal_before_tax": 690.00,
  "total_tax": 144.90,
  "grand_total": 834.90,
  "payment_method": "cash",
  "amount_tendered": 850.00,
  "change_given": 15.10,
  "receipt_printed": true
}
```

**Discount Application Rule:** Discounts are applied at the **line-item level before tax computation**. The `discount_amount` is subtracted from `(quantity × unit_price)` to produce `line_total_before_tax`. Tax is then computed on `line_total_before_tax`. The Gateway validates this arithmetic (see Section 4.8).

### 4.5.2 `STOCK_MOVEMENT` Payload

```json
{
  "movement_type": "received",
  "product_id": "erpnext-product-uuid",
  "product_name": "Bag of Rice (50kg)",
  "quantity": 50,
  "reason": "Supplier delivery — Invoice #INV-2026-0315",
  "movement_ref": "client-generated-movement-id"
}
```

| `movement_type` | Description |
|-----------------|-------------|
| `received` | Goods received from supplier |
| `damaged` | Write-off for damaged or spoiled stock |
| `correction` | Manual stock count correction |

### 4.5.3 `RECORD_EXPENSE` Payload

```json
{
  "expense_ref": "client-generated-expense-id",
  "category": "transport",
  "description": "Trotro fare for supplier trip to Tema",
  "amount": 45.00,
  "payment_method": "cash"
}
```

| `category` | Description |
|------------|-------------|
| `transport` | Transportation costs |
| `rent` | Market stall or shop rent |
| `market_levy` | Local market association levies |
| `utilities` | Electricity, water, phone credit |
| `supplies` | Non-inventory business supplies |
| `other` | Uncategorised expense |

### 4.5.4 `SUSU_CONTRIBUTION` Payload

```json
{
  "contribution_ref": "client-generated-contribution-id",
  "susu_scheme_id": "erpnext-scheme-uuid",
  "amount": 20.00,
  "collection_day": "2026-03-28",
  "collector_note": "Collected by Auntie Ama"
}
```

### 4.5.5 `LOAN_REPAYMENT` Payload

```json
{
  "repayment_ref": "client-generated-repayment-id",
  "loan_id": "erpnext-loan-uuid",
  "amount": 150.00,
  "payment_method": "cash",
  "schedule_period": "2026-03"
}
```

---

## 4.6 Chronological Replay

### 4.6.1 Ordering Guarantee

The Gateway processes actions from a batch in **strict chronological order** as determined by the `recorded_at` timestamp. This is critical because business operations have dependencies:

| Dependency Example | Why Order Matters |
|-------------------|-------------------|
| Stock received at 09:00, then sold at 10:00 | If the sale is processed before the stock receipt, ERPNext may reject it due to insufficient stock |
| Susu contribution at 08:00, sale at 12:00 | While not directly dependent, GRA audit trails require events to appear in business-time order |
| Two sales for the same product at 09:15 and 09:45 | Stock deductions must be applied in sequence to maintain accurate inventory |

### 4.6.2 Replay Process

```
1. Gateway receives POST /sync/batch with N actions
2. Validate batch envelope (auth, device_id match, msme_id match)
3. Sort actions array by recorded_at (ascending) — enforce chronological order
   even if the POS sent them out of order
4. For each action (in order):
   a. Check client_ref against sync_queue_logs for idempotency (Section 4.7)
   b. Validate action_type is in the permitted set (Section 4.4)
   c. If action_type == CREATE_SALE: validate tax_rate_version (Section 4.8)
   d. If action_type == CREATE_SALE: validate payload math (Section 4.9)
   e. Insert into sync_queue_logs with status = 'pending'
5. Return 202 Accepted with batch_ref and per-action acknowledgements
6. Background worker picks up pending actions (chronologically) and:
   a. Routes each action to the correct ERPNext API endpoint
   b. Updates sync_queue_logs status on success or failure
```

### 4.6.3 ERPNext Routing Table

| `action_type` | ERPNext API Endpoint | ERPNext DocType |
|---------------|---------------------|-----------------|
| `CREATE_SALE` | `POST /api/resource/Sales Invoice` | Sales Invoice |
| `STOCK_MOVEMENT` | `POST /api/resource/Stock Entry` | Stock Entry |
| `RECORD_EXPENSE` | `POST /api/resource/Expense Claim` | Expense Claim |
| `SUSU_CONTRIBUTION` | `POST /api/resource/Susu Contribution` | Susu Contribution (custom) |
| `LOAN_REPAYMENT` | `POST /api/resource/Loan Repayment` | Loan Repayment (custom) |

The Gateway performs **payload transformation** before forwarding — mapping the POS action payload structure into ERPNext's expected DocType field format. This transformation is a Gateway responsibility defined in Section 5 (API Contracts & Payload Transformation).

---

## 4.7 Idempotency & Deduplication

### 4.7.1 The Problem

The POS device operates on unreliable mobile connectivity. A device may submit a batch, lose connection before receiving the Gateway's `202 Accepted` response, and retry the exact same batch on the next connectivity window. Without idempotency enforcement, this produces duplicate records in ERPNext — duplicate sales, duplicate Susu contributions, duplicate expense entries.

### 4.7.2 The `client_ref` Idempotency Key

Every action carries a `client_ref` (UUID v4) generated on the POS device at the moment the action was created. This UUID is:

- **Globally unique** — UUID v4 collision probability is negligible
- **Immutable** — once assigned, the `client_ref` never changes, even across retries
- **End-to-end** — the same `client_ref` flows from POS → Gateway → ERPNext and is stored in all three systems

### 4.7.3 Deduplication Logic

```
FUNCTION check_idempotency(client_ref):

  row = SELECT status FROM sync_queue_logs WHERE client_ref = :client_ref

  IF row IS NULL:
    -- First time seeing this action. Proceed with processing.
    RETURN NEW_ACTION

  IF row.status == 'completed':
    -- This action was already successfully processed.
    -- Return the original result without re-processing.
    RETURN ALREADY_COMPLETED (idempotent success response)

  IF row.status == 'pending' OR row.status == 'processing':
    -- This action is currently in the queue or being processed.
    -- Do not create a duplicate. Return current status.
    RETURN IN_PROGRESS (idempotent status response)

  IF row.status == 'failed':
    -- This action previously failed. Allow retry.
    -- Reset status to 'pending' for reprocessing.
    UPDATE sync_queue_logs SET status = 'pending', retry_count = retry_count + 1
    WHERE client_ref = :client_ref
    RETURN RETRY_ACCEPTED
```

### 4.7.4 Batch-Level vs Action-Level Idempotency

Idempotency is enforced at the **action level** (`client_ref`), not the batch level (`batch_ref`). This means:

| Scenario | Behaviour |
|----------|-----------|
| POS retries the exact same batch | Each action's `client_ref` is checked. Already-completed actions return idempotent success. Failed actions are retried. No duplicates. |
| POS sends a batch with some new and some previously sent actions | New actions are processed normally. Previously sent actions are handled idempotently. |
| POS sends a new batch_ref but with the same actions (same `client_ref` values) | Actions are deduplicated by `client_ref` regardless of `batch_ref`. |

---

## 4.8 Tax Version Validation

### 4.8.1 The Rule

> **ABSOLUTE RULE:** The Gateway must NEVER silently recalculate historical offline sales with newer tax rates. A sale's tax computation is frozen at the tax rate version that was active when the trader recorded it on the POS device.

This rule exists because:

1. **Legal compliance:** Under the VAT Act 2013 (Act 870), the tax obligation on a sale is determined at the time of supply, not at the time of reporting.
2. **Audit integrity:** If the Gateway retroactively applied new rates to old sales, the GRA audit trail would show tax amounts that no trader ever saw on their receipt — destroying trust in the system.
3. **Receipt consistency:** The Sunmi device prints a receipt at the time of sale showing specific tax amounts. Those amounts must match what ERPNext records.

### 4.8.2 Validation Process

For every `CREATE_SALE` action in a sync batch:

```
FUNCTION validate_tax_version(action):

  version = action.tax_rate_version
  recorded_at = action.recorded_at

  -- Step 1: Look up the tax rates at the specified version
  rates = SELECT * FROM cached_tax_rates
           WHERE version_id = :version

  IF rates IS EMPTY:
    -- Unknown version. The POS is referencing a tax rate version
    -- that the Gateway has never seen. This is anomalous.
    RETURN REJECT with error: TAX_VERSION_UNKNOWN

  -- Step 2: Verify that the version was active at recorded_at time
  -- The version's effective_date must be <= recorded_at
  -- AND no newer version must have an effective_date <= recorded_at
  -- (i.e., this was the current version at that time)
  active_version = SELECT MAX(version_id) FROM cached_tax_rates
                    WHERE vat_status_scope = :msme_vat_status
                    AND effective_date <= :recorded_at

  IF version != active_version:
    -- The POS used a version that was NOT the active version at
    -- the time of the sale. This may indicate a stale cache on
    -- the POS device.
    --
    -- POLICY: Flag for review but do NOT reject automatically.
    -- The sale is accepted with a WARNING status, and the
    -- discrepancy is logged for Programme Staff review.
    FLAG action with warning: TAX_VERSION_MISMATCH
    LOG { client_ref, recorded_at, expected_version: active_version,
          submitted_version: version }

  -- Step 3: Proceed with payload math validation (Section 4.9)
  RETURN ACCEPT (or ACCEPT_WITH_WARNING)
```

### 4.8.3 Version Mismatch Scenarios

| Scenario | Cause | Gateway Behaviour |
|----------|-------|-------------------|
| POS used version 42; version 42 was active at `recorded_at` | Normal operation | Accept |
| POS used version 41; version 42 was active at `recorded_at` | POS had a stale tax rate cache (e.g., failed to refresh before going offline) | Accept with `TAX_VERSION_MISMATCH` warning; log for review |
| POS used version 43; version 42 was active at `recorded_at` | POS received a future-dated rate early (race condition during rate transition) | Accept with `TAX_VERSION_MISMATCH` warning; log for review |
| POS used version 99; no version 99 exists in `cached_tax_rates` | Corrupted or tampered payload | Reject with `TAX_VERSION_UNKNOWN` error |

**In no scenario does the Gateway recalculate the tax.** The POS-computed values are forwarded to ERPNext as-is. The warning flag enables Programme Staff to investigate mismatches without blocking the trader's data from reaching the system of record.

---

## 4.9 Payload Math Validation

### 4.9.1 Purpose

The Gateway performs arithmetic validation on `CREATE_SALE` payloads to catch computation errors, data corruption during offline storage, or malformed payloads. This is a **sanity check**, not a tax recalculation — the Gateway validates that the numbers are internally consistent, not that they match a specific tax policy.

### 4.9.2 Validation Rules

For each `CREATE_SALE` action, the Gateway checks the following:

| # | Rule | Formula | Tolerance |
|---|------|---------|-----------|
| 1 | **Line item discount application** | `line_total_before_tax` = (`quantity` × `unit_price`) − `discount_amount` | ± 0.01 (rounding) |
| 2 | **Discount applied before tax** | Tax is computed on `line_total_before_tax`, not on (`quantity` × `unit_price`) | Structural: `tax_amount` must be based on `line_total_before_tax` |
| 3 | **Individual tax line computation** | For each `tax_line`: `tax_amount` = `line_total_before_tax` × (`rate_percent` / 100) | ± 0.01 per line |
| 4 | **Line total after tax** | `line_total_after_tax` = `line_total_before_tax` + SUM(`tax_lines[].tax_amount`) | ± 0.01 |
| 5 | **Subtotal before tax** | `subtotal_before_tax` = SUM(`items[].line_total_before_tax`) | ± 0.01 × number of items |
| 6 | **Total tax** | `total_tax` = SUM(all `tax_lines[].tax_amount` across all items) | ± 0.01 × number of tax lines |
| 7 | **Grand total** | `grand_total` = `subtotal_before_tax` + `total_tax` | ± 0.01 |
| 8 | **Non-negative amounts** | All monetary values must be ≥ 0 | Exact |
| 9 | **Discount ≤ line subtotal** | `discount_amount` ≤ (`quantity` × `unit_price`) for each item | Exact |

### 4.9.3 Discount Application — The Rule

> **ARCHITECTURAL CONSTRAINT:** Discounts are applied at the line-item level BEFORE tax computation. The tax base for each line item is the discounted amount, not the original price.

**Correct computation order:**
```
unit_price = 350.00
quantity = 2
discount_amount = 10.00

line_total_before_tax = (350.00 × 2) - 10.00 = 690.00

vat_standard (15%)  = 690.00 × 0.15 = 103.50  ✓
nhil (2.5%)         = 690.00 × 0.025 = 17.25   ✓
getfund (2.5%)      = 690.00 × 0.025 = 17.25   ✓
covid_levy (1%)     = 690.00 × 0.01 = 6.90     ✓

total_tax = 144.90
line_total_after_tax = 690.00 + 144.90 = 834.90
```

**Incorrect (rejected):** Computing tax on the pre-discount amount (700.00) and then subtracting the discount would yield incorrect tax amounts and will fail validation.

### 4.9.4 Validation Failure Handling

| Validation Result | Gateway Action |
|-------------------|---------------|
| All rules pass | Action proceeds to `pending` in `sync_queue_logs` |
| Math discrepancy within tolerance (rounding) | Action proceeds with `MATH_ROUNDED` flag logged |
| Math discrepancy exceeds tolerance | Action is rejected with `MATH_VALIDATION_FAILED`; inserted into `sync_queue_logs` with status `failed` and `failure_reason` detailing which rule failed |
| Structural error (e.g., tax computed on pre-discount amount) | Action is rejected with `DISCOUNT_TAX_ORDER_INVALID`; logged with the expected vs actual tax base |

---

## 4.10 Queue State Machine — `sync_queue_logs`

### 4.10.1 Table Schema

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | UUID | PK, DEFAULT gen_random_uuid() | Queue entry identifier |
| `batch_ref` | UUID | NOT NULL, INDEX | The batch this action belongs to |
| `client_ref` | UUID | NOT NULL, UNIQUE | Idempotency key — one row per `client_ref` across the entire table |
| `msme_id` | UUID | NOT NULL, INDEX | MSME that originated this action |
| `device_id` | VARCHAR(128) | NOT NULL | Device that submitted this action |
| `action_type` | VARCHAR(32) | NOT NULL | One of the permitted action types |
| `recorded_at` | TIMESTAMPTZ | NOT NULL | Business timestamp from the POS device |
| `tax_rate_version` | INTEGER | NULLABLE | Tax rate version used (null for non-tax actions) |
| `payload` | JSONB | NOT NULL | The complete action payload |
| `status` | VARCHAR(16) | NOT NULL, DEFAULT 'pending' | Current state in the queue lifecycle |
| `retry_count` | INTEGER | NOT NULL, DEFAULT 0 | Number of processing attempts |
| `max_retries` | INTEGER | NOT NULL, DEFAULT 5 | Maximum retries before moving to `failed` |
| `failure_reason` | TEXT | NULLABLE | Human-readable failure description (populated on `failed` status) |
| `erpnext_ref` | VARCHAR(128) | NULLABLE | ERPNext document reference returned on successful creation (e.g., `SI-2026-00042`) |
| `warnings` | JSONB | NULLABLE | Array of non-fatal warnings (e.g., `TAX_VERSION_MISMATCH`, `MATH_ROUNDED`) |
| `received_at` | TIMESTAMPTZ | NOT NULL, DEFAULT now() | When the Gateway received this action |
| `processing_started_at` | TIMESTAMPTZ | NULLABLE | When the background worker began processing |
| `completed_at` | TIMESTAMPTZ | NULLABLE | When processing completed (success or final failure) |
| `created_at` | TIMESTAMPTZ | NOT NULL, DEFAULT now() | Record creation timestamp |

**Indexes:**
- `idx_sync_queue_client_ref` UNIQUE on `client_ref` — enforces idempotency at the database level
- `idx_sync_queue_batch_ref` on `batch_ref` — fast batch status lookups
- `idx_sync_queue_status` on (`status`, `recorded_at`) — enables the background worker to pick up pending actions in chronological order
- `idx_sync_queue_msme_id` on `msme_id` — fast MSME-scoped queries for status and audit

### 4.10.2 State Machine

```
                    ┌──────────┐
                    │ received │  (batch accepted, action validated)
                    └────┬─────┘
                         │
                         ▼
                    ┌──────────┐
            ┌──────│ pending   │◀─────────────────┐
            │      └────┬─────┘                   │
            │           │                         │
            │           ▼                         │
            │      ┌──────────────┐               │
            │      │ processing   │    retry_count < max_retries
            │      └───┬─────┬───┘         │
            │          │     │             │
            │     success   failure────────┘
            │          │
            │          ▼
            │      ┌──────────┐
            │      │ completed│
            │      └──────────┘
            │
            │  retry_count >= max_retries
            │
            ▼
       ┌──────────┐
       │  failed   │  (dead letter — requires manual intervention)
       └──────────┘
```

### 4.10.3 State Definitions

| Status | Meaning | Transitions |
|--------|---------|-------------|
| `pending` | Action has been received, validated, and is waiting for the background worker to pick it up | → `processing` (worker picks up) |
| `processing` | Background worker is actively forwarding this action to ERPNext | → `completed` (ERPNext returns success) or → `pending` (retryable failure, retry_count < max_retries) or → `failed` (retry_count ≥ max_retries OR non-retryable error) |
| `completed` | ERPNext has successfully created the corresponding record. `erpnext_ref` is populated. | Terminal state. No further transitions. |
| `failed` | Action has exhausted all retry attempts or encountered a non-retryable error. Requires manual intervention by Programme Staff or admin. | Terminal state unless manually re-queued. |

### 4.10.4 Retryable vs Non-Retryable Errors

| Error Category | Retryable | Examples |
|---------------|-----------|----------|
| **ERPNext 5xx** (server error) | Yes | 500 Internal Server Error, 502 Bad Gateway, 503 Service Unavailable |
| **ERPNext timeout** | Yes | Request timed out after configured threshold |
| **Network error** | Yes | DNS resolution failure, connection refused, socket hang up |
| **ERPNext 409** (conflict) | Yes (with backoff) | Concurrent write conflict on the same ERPNext document |
| **ERPNext 400** (bad request) | **No** | The transformed payload is structurally invalid for ERPNext — indicates a Gateway transformation bug or POS data corruption |
| **ERPNext 404** (not found) | **No** | Referenced entity (product, customer, Susu scheme, loan) does not exist in ERPNext |
| **ERPNext 422** (validation) | **No** | ERPNext business rule rejection (e.g., insufficient stock, loan already fully repaid) |
| **Gateway validation failure** | **No** | `MATH_VALIDATION_FAILED`, `DISCOUNT_TAX_ORDER_INVALID`, `TAX_VERSION_UNKNOWN` |

### 4.10.5 Retry Strategy

| Parameter | Value | Description |
|-----------|-------|-------------|
| `max_retries` | 5 | Maximum retry attempts per action |
| Backoff strategy | Exponential with jitter | `delay = min(base_delay × 2^attempt + random_jitter, max_delay)` |
| `base_delay` | 1000ms | Initial retry delay |
| `max_delay` | 60000ms | Maximum retry delay (1 minute) |
| `jitter_range` | 0–500ms | Random jitter to prevent thundering herd on ERPNext recovery |

### 4.10.6 Partial Batch Failure

A batch may contain 50 actions, of which 48 succeed and 2 fail. The Gateway handles this at the **individual action level**, not the batch level:

| Design Decision | Rationale |
|----------------|-----------|
| **Successful actions are committed independently** | A failing expense entry must not block 47 successful sales from reaching ERPNext. The trader's revenue data should not be held hostage by an unrelated failure. |
| **Failed actions remain in the queue for retry** | Each failed action retries independently according to the retry strategy. |
| **Batch status reflects the aggregate** | `GET /sync/status/{batch_ref}` returns the status of every action in the batch, allowing the POS to determine if the full batch is complete or if some actions are still pending/failed. |

**Batch Status Response:**

```json
{
  "batch_ref": "batch-uuid-v4",
  "total_actions": 50,
  "summary": {
    "completed": 48,
    "pending": 0,
    "processing": 0,
    "failed": 2
  },
  "actions": [
    {
      "client_ref": "uuid-1",
      "action_type": "CREATE_SALE",
      "status": "completed",
      "erpnext_ref": "SI-2026-00042"
    },
    {
      "client_ref": "uuid-49",
      "action_type": "RECORD_EXPENSE",
      "status": "failed",
      "failure_reason": "ERPNext 404: Expense category 'market_levy' not found in Chart of Accounts",
      "retry_count": 5
    }
  ]
}
```

### 4.10.7 Dead Letter Handling

Actions that reach `failed` status are effectively in a **dead letter queue (DLQ)**. They remain in `sync_queue_logs` with `status = 'failed'` and are not automatically retried.

| DLQ Procedure | Actor | Action |
|---------------|-------|--------|
| **Review** | `programme_staff` or `admin` (via Web Portal) | View all failed actions for a district/zone. Inspect `failure_reason` to determine root cause. |
| **Manual re-queue** | `admin` | Correct the underlying issue (e.g., create the missing product in ERPNext, fix the Chart of Accounts mapping) and re-queue the action by resetting `status = 'pending'` and `retry_count = 0`. |
| **Permanent discard** | `admin` | If the action is irrecoverably invalid (e.g., test data from device setup), mark as `discarded` with an audit-logged reason. This is a destructive action and is immutably recorded. |
| **Alerting** | System | When an action enters `failed` status, the Gateway emits an alert (configurable: webhook, email, or logging) to notify operations staff. |

---

## 4.11 Sync Response Contract

### 4.11.1 Successful Batch Acceptance — `202 Accepted`

```json
{
  "status": 202,
  "batch_ref": "batch-uuid-v4",
  "accepted": 50,
  "rejected": 0,
  "actions": [
    {
      "client_ref": "uuid-1",
      "status": "pending",
      "warnings": []
    },
    {
      "client_ref": "uuid-2",
      "status": "pending",
      "warnings": ["TAX_VERSION_MISMATCH"]
    }
  ]
}
```

### 4.11.2 Partial Rejection — `207 Multi-Status`

If some actions in the batch fail validation (e.g., math validation failure, unknown action type), the Gateway returns `207 Multi-Status`:

```json
{
  "status": 207,
  "batch_ref": "batch-uuid-v4",
  "accepted": 48,
  "rejected": 2,
  "actions": [
    {
      "client_ref": "uuid-1",
      "status": "pending",
      "warnings": []
    },
    {
      "client_ref": "uuid-49",
      "status": "rejected",
      "error": "MATH_VALIDATION_FAILED",
      "detail": "Rule 1: line_total_before_tax expected 690.00, got 700.00"
    }
  ]
}
```

Rejected actions are inserted into `sync_queue_logs` with `status = 'failed'` and `failure_reason` populated, enabling DLQ review. Accepted actions proceed to `pending` for processing.

### 4.11.3 Full Batch Rejection — `422 Unprocessable Entity`

If the batch envelope itself is invalid (e.g., missing `batch_ref`, empty `actions` array, `device_id` mismatch with JWT), the entire batch is rejected:

```json
{
  "status": 422,
  "error": "BATCH_VALIDATION_FAILED",
  "detail": "device_id in payload does not match device_id in access token"
}
```

No `sync_queue_logs` entries are created.

---

## 4.12 Operational Guarantees Summary

| Guarantee | Mechanism |
|-----------|-----------|
| **Exactly-once processing** | `client_ref` UNIQUE constraint on `sync_queue_logs`; idempotent response on duplicate submission |
| **Chronological ordering** | Actions sorted by `recorded_at` before processing; background worker picks up in `recorded_at` order within each MSME |
| **No silent tax recalculation** | `tax_rate_version` validated against `cached_tax_rates`; POS-computed values forwarded as-is to ERPNext |
| **No data loss on burst** | Gateway always persists valid batches to `sync_queue_logs` before returning `202`; processing is asynchronous |
| **Partial failure isolation** | Each action succeeds or fails independently; a single failed action does not block the rest of the batch |
| **Audit traceability** | Every action carries `client_ref`, `recorded_at`, `tax_rate_version`, and `device_id` — traceable from POS receipt through Gateway queue to ERPNext record |
| **Dead letter visibility** | Failed actions remain in `sync_queue_logs` with `failure_reason`; alerting notifies operations staff |

---

*End of Section 4 — Offline Sync Strategy & Queue Management*
*Next: Section 5 — API Contracts & Payload Transformation*
