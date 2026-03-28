# Section 5: API Contracts & The Phase 0 Mocking Strategy

**Document:** TriLiska POS Gateway — Master System Architecture & PRD
**Section:** 05 — API Contracts, Payload Transformation & Phase 0 Mock Adapter Strategy
**Prepared by:** Trident Aliska Digital Tech Ghana LTD
**Programme:** GRA MSME Tax & Business Management Programme
**Sprint Focus:** POS Backend Gateway (Node.js 24 / Postgres 16)
**Date:** March 2026
**Classification:** Enterprise — Restricted Distribution

---

## 5.1 Overview — The Parallel Development Problem

The TriLiska ecosystem has a sequencing dependency: the Flutter POS team needs to build against the Gateway API immediately, but the ERPNext backend — which serves as the system of record for products, MSME profiles, customers, tax configuration, Susu schemes, and loans — is still under active development. If the POS team waits for ERPNext to be feature-complete before starting integration, the project timeline collapses.

The solution is a **Phase 0 Mock Adapter Strategy** built into the Gateway from day one. The Gateway introduces a runtime toggle (`ERP_MODE`) that switches between a mock adapter (returning static fixtures) and a live adapter (forwarding to ERPNext). The POS team builds against the Gateway's API contracts, which remain identical in both modes. When ERPNext is ready, the switch from `ERP_MODE=mock` to `ERP_MODE=live` requires **zero changes** to the Flutter POS codebase and **zero changes** to the Gateway's API surface.

---

## 5.2 The `ERP_MODE` Environment Variable

### 5.2.1 Definition

| Variable | Allowed Values | Default | Description |
|----------|---------------|---------|-------------|
| `ERP_MODE` | `mock`, `live` | `mock` | Controls whether the Gateway communicates with ERPNext or returns mock fixtures |

### 5.2.2 Behavioural Contract

| Gateway Function | `ERP_MODE=mock` | `ERP_MODE=live` |
|-----------------|-----------------|-----------------|
| `POST /auth/login` | Validates credentials against a static mock user list; issues real Edge JWTs and refresh tokens; enforces Single Active Device Rule against real `active_devices` table | Delegates credential validation to ERPNext SSO; issues real Edge JWTs; enforces Single Active Device Rule |
| `POST /auth/refresh` | Fully functional — validates and rotates refresh tokens in Postgres | Identical to mock mode (refresh is Gateway-local) |
| `POST /auth/logout` | Fully functional — revokes tokens, deregisters device | Identical to mock mode |
| `GET /products` | Returns static JSON fixtures from mock data files | Proxies to ERPNext Product API |
| `GET /msme-profile` | Returns static JSON fixture for the authenticated MSME | Proxies to ERPNext MSME Profile API |
| `GET /tax-rates` | Returns rates from the real `cached_tax_rates` Postgres table (seeded with mock data on startup) | Returns rates from `cached_tax_rates` (populated by ERPNext sync job) |
| `POST /sync/batch` | Full queue processing: validation, idempotency, `sync_queue_logs` persistence — but the final ERPNext HTTP forward is mocked (instant `completed` with log output) | Full queue processing with real ERPNext HTTP forwarding |
| `GET /sync/status/{batch_ref}` | Fully functional against real `sync_queue_logs` | Identical to mock mode |

### 5.2.3 What Is Real In Both Modes

The following Gateway subsystems operate identically regardless of `ERP_MODE`:

| Subsystem | Why It Must Be Real |
|-----------|---------------------|
| Edge JWT issuance and validation | The Flutter POS must test against real token lifecycles, expiry, and refresh flows |
| Refresh token rotation (Postgres) | Token rotation bugs are among the hardest to catch late — they must be exercised from day one |
| Single Active Device enforcement (`active_devices` table) | Device conflict handling must be tested with real Postgres constraints |
| Sync queue processing (`sync_queue_logs` table) | The Outbox Pattern, idempotency, state machine, and partial failure handling are the Gateway's core value — they must be fully functional in Phase 0 |
| Payload validation (Zod schemas) | Invalid payloads must be caught before they reach the queue, regardless of whether ERPNext is present |
| Rate limiting | Burst absorption behaviour must be validated under mock load |

### 5.2.4 What Is Mocked

Only the **external boundary** — the HTTP calls to ERPNext — is mocked. Everything inside the Gateway is real.

```
┌─────────────────────────────────────────────────────┐
│                   Node.js Gateway                    │
│                                                     │
│  ┌──────────┐  ┌──────────┐  ┌──────────────────┐  │
│  │ Auth     │  │ Sync     │  │ Payload          │  │
│  │ (real)   │  │ Queue    │  │ Validation       │  │
│  │          │  │ (real)   │  │ (real)           │  │
│  └──────────┘  └──────────┘  └──────────────────┘  │
│                                                     │
│  ┌──────────────────────────────────────────────┐   │
│  │         ERP Adapter Layer                     │   │
│  │  ┌─────────────┐    ┌──────────────────┐     │   │
│  │  │ MockAdapter  │    │  LiveAdapter     │     │   │
│  │  │ (ERP_MODE=   │    │  (ERP_MODE=live) │     │   │
│  │  │  mock)       │    │                  │     │   │
│  │  │ Returns JSON │    │  HTTP → ERPNext  │     │   │
│  │  │ fixtures     │    │                  │     │   │
│  │  └─────────────┘    └──────────────────┘     │   │
│  └──────────────────────────────────────────────┘   │
│                                                     │
└─────────────────────────────────────────────────────┘
```

---

## 5.3 Strict Anti-Pattern Warning

> **ARCHITECTURAL CONSTRAINT — NON-NEGOTIABLE:**
>
> The Gateway team **MUST NOT** build Postgres tables, CRUD endpoints, or persistence logic for Products, MSME Profiles, Customers, Susu Schemes, Loans, or any other ERPNext-mastered entity. This data belongs to ERPNext. The Gateway's relationship to this data is strictly one of:
>
> 1. **Proxy** — forwarding requests to ERPNext and returning responses (live mode)
> 2. **Mock** — returning static JSON fixtures (mock mode)
> 3. **Cache** — maintaining a read-only, time-limited cache (e.g., `cached_tax_rates`)
>
> There is no fourth option.

### Why This Rule Exists

| Violation Scenario | Consequence |
|-------------------|-------------|
| Gateway team creates a `products` table in Postgres | Two sources of truth for product data. When ERPNext goes live, the Gateway table must be migrated or abandoned — both are costly. Product updates in ERPNext will not reflect in the Gateway without a sync mechanism that should never have been needed. |
| Gateway team builds CRUD endpoints for MSME profiles | Field officers begin creating MSMEs through the Gateway during Phase 0. When ERPNext goes live, these records do not exist in the system of record. Data migration is required, and programme references (`TRL-{DISTRICT}-{SEQ}`) may conflict. |
| Gateway team adds a `customers` table for walk-in customer tracking | Customer identity is an ERPNext-mastered concern tied to Ghana Card and TIN validation. A Gateway-local customer table bypasses these controls. |

### Permitted Gateway-Owned Tables (Exhaustive List)

| Table | Purpose | Lifecycle |
|-------|---------|-----------|
| `refresh_tokens` | Edge JWT session management | Permanent Gateway responsibility |
| `active_devices` | Single Active Device enforcement | Permanent Gateway responsibility |
| `sync_queue_logs` | Action queue processing and idempotency | Permanent Gateway responsibility |
| `cached_tax_rates` | Read-only tax rate cache for POS distribution | Permanent Gateway responsibility (populated by mock seed or ERPNext sync) |

**No other Postgres tables may be created without explicit architectural review and approval.**

---

## 5.4 Mock Data Fixtures

### 5.4.1 Fixture Storage

Mock fixtures are stored as static JSON files in the Gateway codebase under a `fixtures/` directory. They are loaded at startup when `ERP_MODE=mock` and served from memory. They are **not** stored in Postgres.

```
src/
  adapters/
    erp/
      mock/
        mock-adapter.ts         # MockAdapter implementation
        fixtures/
          products.json         # Product catalogue
          msme-profiles.json    # MSME profile fixtures
          customers.json        # Customer fixtures
          users.json            # Mock user credentials for auth
          susu-schemes.json     # Active Susu schemes
          loans.json            # Active loan records
          tax-rates-seed.sql    # SQL seed for cached_tax_rates table
      live/
        live-adapter.ts         # LiveAdapter implementation (ERPNext HTTP)
      erp-adapter.interface.ts  # Shared interface contract
```

### 5.4.2 `GET /products` — Mock Response Example

**Endpoint:** `GET /products?vat_status=standard`
**Auth:** Bearer token required (Edge JWT)
**Purpose:** Returns the product catalogue applicable to the authenticated MSME's tax regime. The Flutter POS caches this locally in Drift for offline product lookup during sale entry.

**Mock Response:**

```json
{
  "msme_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "vat_status": "standard",
  "catalogue_version": 1,
  "generated_at": "2026-03-28T08:00:00Z",
  "products": [
    {
      "product_id": "prod-001-rice-50kg",
      "name": "Bag of Rice (50kg)",
      "category": "retail_food",
      "unit_price": 350.00,
      "currency": "GHS",
      "tax_applicable": true,
      "barcode": "5901234123457",
      "unit_of_measure": "bag",
      "stock_tracked": true,
      "current_stock": 120,
      "low_stock_threshold": 10
    },
    {
      "product_id": "prod-002-cooking-oil-5l",
      "name": "Cooking Oil (5L)",
      "category": "retail_food",
      "unit_price": 95.00,
      "currency": "GHS",
      "tax_applicable": true,
      "barcode": "5901234123458",
      "unit_of_measure": "bottle",
      "stock_tracked": true,
      "current_stock": 85,
      "low_stock_threshold": 15
    },
    {
      "product_id": "prod-003-cement-bag",
      "name": "Cement (50kg Bag)",
      "category": "retail_general",
      "unit_price": 78.00,
      "currency": "GHS",
      "tax_applicable": true,
      "barcode": "5901234123459",
      "unit_of_measure": "bag",
      "stock_tracked": true,
      "current_stock": 45,
      "low_stock_threshold": 5
    },
    {
      "product_id": "prod-004-phone-credit",
      "name": "MTN Airtime Top-Up",
      "category": "services",
      "unit_price": 0.00,
      "currency": "GHS",
      "tax_applicable": false,
      "barcode": null,
      "unit_of_measure": "unit",
      "stock_tracked": false,
      "current_stock": null,
      "low_stock_threshold": null
    },
    {
      "product_id": "prod-005-kenkey-wrap",
      "name": "Kenkey (Wrap of 6)",
      "category": "retail_food",
      "unit_price": 30.00,
      "currency": "GHS",
      "tax_applicable": true,
      "barcode": null,
      "unit_of_measure": "wrap",
      "stock_tracked": true,
      "current_stock": 200,
      "low_stock_threshold": 20
    }
  ]
}
```

### 5.4.3 `GET /msme-profile` — Mock Response Example

**Endpoint:** `GET /msme-profile`
**Auth:** Bearer token required (Edge JWT). Returns the profile for the `msme_id` embedded in the token claims.

**Mock Response:**

```json
{
  "msme_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "programme_ref": "TRL-ACC-0042",
  "business_name": "Auntie Ama's Provisions",
  "owner_name": "Ama Mensah",
  "owner_phone": "+233241234567",
  "owner_national_id": "GHA-XXXXXXXXX-X",
  "tin": "P00XXXXXXXX",
  "business_type": "sole_proprietor",
  "sector": "retail_food",
  "vat_status": "flat_rate",
  "annual_turnover_band": "200k_to_500k",
  "gps_lat": 5.5500140,
  "gps_lng": -0.2207730,
  "district": "accra",
  "zone": "makola_central",
  "preferred_language": "en",
  "status": "active"
}
```

### 5.4.4 `GET /tax-rates` — Mock Behaviour

Tax rates are **not** served from static JSON fixtures. Even in mock mode, the `GET /tax-rates` endpoint reads from the real `cached_tax_rates` Postgres table. The difference is how the table is populated:

| Mode | Population Method |
|------|-------------------|
| `ERP_MODE=mock` | On startup, the Gateway executes `tax-rates-seed.sql` to populate `cached_tax_rates` with the current GRA Modified Tax System rates |
| `ERP_MODE=live` | Background job syncs from ERPNext tax configuration API on a 15-minute cycle (Section 3.6) |

This ensures the tax rate caching and version tracking subsystem is fully exercised in Phase 0, including version validation during sync.

**Seed data (tax-rates-seed.sql):**

```sql
INSERT INTO cached_tax_rates (tax_type, rate_percent, vat_status_scope, effective_date, version_id, source_updated_at)
VALUES
  -- Standard rate components (VAT Act 2013, Act 870)
  ('vat_standard',   15.00, 'standard',       '2025-01-01', 1, now()),
  ('nhil',            2.50, 'standard',       '2025-01-01', 1, now()),
  ('getfund',         2.50, 'standard',       '2025-01-01', 1, now()),
  ('covid_levy',      1.00, 'standard',       '2025-01-01', 1, now()),

  -- Flat Rate / VFRS (Modified Tax System)
  ('vat_flat_rate',   3.00, 'flat_rate',      '2025-01-01', 1, now())

  -- not_registered: no rates (0% — exempt under current thresholds)
ON CONFLICT DO NOTHING;
```

### 5.4.5 Mock User Credentials

For `POST /auth/login` in mock mode, the Gateway validates against a static user fixture:

```json
[
  {
    "phone": "+233241234567",
    "pin_hash": "$2b$10$...",
    "user_id": "user-001-ama",
    "role": "msme_owner",
    "msme_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "zone": "makola_central",
    "district": "accra"
  },
  {
    "phone": "+233209876543",
    "pin_hash": "$2b$10$...",
    "user_id": "user-002-kwame",
    "role": "programme_staff",
    "msme_id": null,
    "zone": "makola_central",
    "district": "accra"
  }
]
```

The mock login flow issues **real Edge JWTs and real refresh tokens** stored in the real `refresh_tokens` Postgres table. Only the credential verification step is mocked. This ensures the Flutter POS team tests against authentic token lifecycles.

---

## 5.5 Mocking the Sync Forwarder

### 5.5.1 Behaviour

When `ERP_MODE=mock`, the sync pipeline operates as follows:

| Pipeline Stage | Mock Behaviour | Real Behaviour |
|----------------|---------------|----------------|
| **1. Receive batch** | Identical — parse JSON, validate auth | Identical |
| **2. Validate payloads** | Identical — Zod schema validation, math validation, tax version validation | Identical |
| **3. Check idempotency** | Identical — `client_ref` lookup in `sync_queue_logs` | Identical |
| **4. Persist to queue** | Identical — insert into `sync_queue_logs` with `status = 'pending'` | Identical |
| **5. Return 202 Accepted** | Identical — per-action acknowledgement with warnings | Identical |
| **6. Background worker: forward to ERPNext** | **MOCKED** — no HTTP call. Worker instantly transitions action to `completed`, generates a mock `erpnext_ref`, and logs `[MOCK] Forwarded to ERPNext`. | Real HTTP call to ERPNext API; status transitions based on response |

### 5.5.2 Mock Forwarder Logic

```
FUNCTION mock_forward_to_erpnext(action):

  -- Simulate processing delay (configurable, default 100ms)
  await sleep(MOCK_FORWARD_DELAY_MS)

  -- Generate a mock ERPNext document reference
  erpnext_ref = generate_mock_ref(action.action_type)
    -- CREATE_SALE       → "SI-MOCK-{sequential}"
    -- STOCK_MOVEMENT    → "SE-MOCK-{sequential}"
    -- RECORD_EXPENSE    → "EC-MOCK-{sequential}"
    -- SUSU_CONTRIBUTION → "SC-MOCK-{sequential}"
    -- LOAN_REPAYMENT    → "LR-MOCK-{sequential}"

  -- Update sync_queue_logs
  UPDATE sync_queue_logs
  SET status = 'completed',
      erpnext_ref = :erpnext_ref,
      completed_at = now()
  WHERE client_ref = :action.client_ref

  -- Log for observability
  LOG.info("[MOCK] Forwarded to ERPNext", {
    client_ref: action.client_ref,
    action_type: action.action_type,
    erpnext_ref: erpnext_ref,
    recorded_at: action.recorded_at
  })
```

### 5.5.3 Mock Failure Simulation

To test the Gateway's retry logic and DLQ handling during Phase 0, the mock forwarder supports an optional failure simulation mode controlled by an environment variable:

| Variable | Allowed Values | Default | Description |
|----------|---------------|---------|-------------|
| `MOCK_FAILURE_RATE` | `0.0` – `1.0` | `0.0` | Fraction of mock forwards that simulate an ERPNext failure (e.g., `0.1` = 10% failure rate) |
| `MOCK_FAILURE_TYPE` | `5xx`, `timeout`, `400`, `404` | `5xx` | The type of simulated failure |
| `MOCK_FORWARD_DELAY_MS` | Integer (ms) | `100` | Simulated processing latency per action |

When `MOCK_FAILURE_RATE > 0`, the mock forwarder randomly fails a proportion of actions, triggering the real retry state machine in `sync_queue_logs`. This allows the POS team and the Gateway team to validate end-to-end error handling without requiring a live ERPNext instance.

---

## 5.6 API Payload Validation — Zod Schemas

### 5.6.1 Design Principle

The Gateway validates every incoming payload at the API boundary **before** it reaches the sync queue. Invalid data is rejected at the door — it never enters `sync_queue_logs`, never touches the background worker, and never reaches ERPNext (or the mock forwarder).

Validation is implemented using **Zod** (TypeScript-first schema validation library). Zod schemas serve as the single source of truth for:

1. **Runtime validation** — parsing and validating request bodies at the API layer
2. **TypeScript type inference** — generating static types from schemas for compile-time safety
3. **API documentation** — schemas are the executable specification of the payload contracts defined in Section 4.5

### 5.6.2 Schema Architecture

```
src/
  schemas/
    sync/
      batch.schema.ts           # Batch envelope schema
      actions/
        create-sale.schema.ts   # CREATE_SALE payload validation
        stock-movement.schema.ts
        record-expense.schema.ts
        susu-contribution.schema.ts
        loan-repayment.schema.ts
      index.ts                  # Action type → schema dispatcher
    auth/
      login.schema.ts           # Login request validation
      refresh.schema.ts         # Token refresh validation
```

### 5.6.3 Batch Envelope Schema

```typescript
import { z } from 'zod';

export const SyncBatchSchema = z.object({
  device_id: z.string().min(1, 'device_id is required'),
  msme_id: z.string().uuid('msme_id must be a valid UUID'),
  batch_ref: z.string().uuid('batch_ref must be a valid UUID v4'),
  actions: z
    .array(ActionSchema)
    .min(1, 'Batch must contain at least 1 action')
    .max(500, 'Batch must not exceed 500 actions'),
});
```

### 5.6.4 Action Schema (Discriminated Union)

```typescript
const BaseActionSchema = z.object({
  action_type: z.enum([
    'CREATE_SALE',
    'STOCK_MOVEMENT',
    'RECORD_EXPENSE',
    'SUSU_CONTRIBUTION',
    'LOAN_REPAYMENT',
  ]),
  client_ref: z.string().uuid('client_ref must be a valid UUID v4'),
  recorded_at: z.string().datetime({ offset: true }),
  tax_rate_version: z.number().int().positive().nullable(),
});

export const ActionSchema = z.discriminatedUnion('action_type', [
  BaseActionSchema.extend({
    action_type: z.literal('CREATE_SALE'),
    tax_rate_version: z.number().int().positive(),  // Required for sales
    payload: CreateSalePayloadSchema,
  }),
  BaseActionSchema.extend({
    action_type: z.literal('STOCK_MOVEMENT'),
    tax_rate_version: z.null(),
    payload: StockMovementPayloadSchema,
  }),
  BaseActionSchema.extend({
    action_type: z.literal('RECORD_EXPENSE'),
    tax_rate_version: z.null(),
    payload: RecordExpensePayloadSchema,
  }),
  BaseActionSchema.extend({
    action_type: z.literal('SUSU_CONTRIBUTION'),
    tax_rate_version: z.null(),
    payload: SusuContributionPayloadSchema,
  }),
  BaseActionSchema.extend({
    action_type: z.literal('LOAN_REPAYMENT'),
    tax_rate_version: z.null(),
    payload: LoanRepaymentPayloadSchema,
  }),
]);
```

### 5.6.5 `CREATE_SALE` Payload Schema

```typescript
const TaxLineSchema = z.object({
  tax_type: z.enum([
    'vat_standard',
    'vat_flat_rate',
    'nhil',
    'getfund',
    'covid_levy',
  ]),
  rate_percent: z.number().nonnegative(),
  tax_amount: z.number().nonnegative(),
});

const SaleItemSchema = z.object({
  product_id: z.string().min(1),
  product_name: z.string().min(1),
  quantity: z.number().int().positive(),
  unit_price: z.number().nonnegative(),
  discount_amount: z.number().nonnegative().default(0),
  line_total_before_tax: z.number().nonnegative(),
  tax_lines: z.array(TaxLineSchema),
  line_total_after_tax: z.number().nonnegative(),
});

export const CreateSalePayloadSchema = z.object({
  sale_ref: z.string().min(1),
  customer_id: z.string().uuid().nullable(),
  items: z.array(SaleItemSchema).min(1, 'Sale must contain at least 1 item'),
  subtotal_before_tax: z.number().nonnegative(),
  total_tax: z.number().nonnegative(),
  grand_total: z.number().nonnegative(),
  payment_method: z.enum(['cash', 'mobile_money', 'card', 'credit']),
  amount_tendered: z.number().nonnegative(),
  change_given: z.number().nonnegative(),
  receipt_printed: z.boolean(),
});
```

### 5.6.6 Validation Pipeline

```
POST /sync/batch
  │
  ▼
┌─────────────────────────────────┐
│  1. Parse JSON body             │
│     (reject 400 if malformed)   │
└──────────────┬──────────────────┘
               │
               ▼
┌─────────────────────────────────┐
│  2. Validate JWT claims         │
│     - device_id matches token   │
│     - msme_id matches token     │
│     (reject 403 if mismatch)    │
└──────────────┬──────────────────┘
               │
               ▼
┌─────────────────────────────────┐
│  3. Validate batch envelope     │
│     via SyncBatchSchema.parse() │
│     (reject 422 if invalid)     │
└──────────────┬──────────────────┘
               │
               ▼
┌─────────────────────────────────┐
│  4. For each action:            │
│     a. Validate via ActionSchema│
│        (discriminated union)    │
│     b. If CREATE_SALE:          │
│        - Tax version validation │
│          (Section 4.8)          │
│        - Payload math validation│
│          (Section 4.9)          │
│     c. Idempotency check        │
│        (Section 4.7)            │
└──────────────┬──────────────────┘
               │
               ▼
┌─────────────────────────────────┐
│  5. Persist valid actions to    │
│     sync_queue_logs             │
│     (reject invalid actions     │
│      with per-action errors)    │
└──────────────┬──────────────────┘
               │
               ▼
┌─────────────────────────────────┐
│  6. Return 202 / 207 / 422     │
│     (Section 4.11)             │
└─────────────────────────────────┘
```

### 5.6.7 Validation Error Response Format

When Zod schema validation fails, the Gateway returns a structured error identifying the exact field(s) that failed:

```json
{
  "status": 422,
  "error": "PAYLOAD_VALIDATION_FAILED",
  "batch_ref": "batch-uuid-v4",
  "validation_errors": [
    {
      "client_ref": "uuid-of-failing-action",
      "action_type": "CREATE_SALE",
      "path": "payload.items[0].quantity",
      "code": "too_small",
      "message": "Number must be greater than 0",
      "received": 0
    },
    {
      "client_ref": "uuid-of-another-failing-action",
      "action_type": "RECORD_EXPENSE",
      "path": "payload.category",
      "code": "invalid_enum_value",
      "message": "Invalid enum value. Expected 'transport' | 'rent' | 'market_levy' | 'utilities' | 'supplies' | 'other', received 'food'",
      "received": "food"
    }
  ]
}
```

---

## 5.7 The ERP Adapter Interface

### 5.7.1 Interface Contract

Both the `MockAdapter` and `LiveAdapter` implement a shared TypeScript interface. This ensures that switching from mock to live mode is a configuration change, not a code change.

```typescript
export interface ErpAdapter {
  // Authentication
  validateCredentials(phone: string, pin: string): Promise<ErpUserRecord>;

  // Master Data (read-only from Gateway perspective)
  getProducts(msmeId: string, vatStatus: string): Promise<ProductCatalogue>;
  getMsmeProfile(msmeId: string): Promise<MsmeProfile>;
  getCustomer(customerId: string): Promise<Customer | null>;

  // Tax Configuration
  fetchTaxRates(): Promise<TaxRateSet[]>;

  // Sync Forwarding
  forwardAction(action: QueuedAction): Promise<ErpForwardResult>;
}

export interface ErpForwardResult {
  success: boolean;
  erpnext_ref: string | null;
  error_code: number | null;
  error_message: string | null;
  retryable: boolean;
}
```

### 5.7.2 Adapter Registration

```typescript
// src/adapters/erp/index.ts
import { MockAdapter } from './mock/mock-adapter';
import { LiveAdapter } from './live/live-adapter';

export function createErpAdapter(): ErpAdapter {
  const mode = process.env.ERP_MODE || 'mock';

  if (mode === 'mock') {
    console.log('[ERP] Starting in MOCK mode — ERPNext calls will be simulated');
    return new MockAdapter();
  }

  if (mode === 'live') {
    console.log('[ERP] Starting in LIVE mode — connecting to ERPNext');
    return new LiveAdapter({
      baseUrl: process.env.ERPNEXT_BASE_URL,
      apiKey: process.env.ERPNEXT_API_KEY,
      apiSecret: process.env.ERPNEXT_API_SECRET,
    });
  }

  throw new Error(`Invalid ERP_MODE: "${mode}". Must be "mock" or "live".`);
}
```

---

## 5.8 Phase 0 → Phase 1 Transition Checklist

When ERPNext is ready for integration, the transition from mock to live is governed by this checklist:

| # | Step | Owner | Verification |
|---|------|-------|-------------|
| 1 | ERPNext SSO endpoint is accessible from Gateway network | DevOps | `curl -s {ERPNEXT_BASE_URL}/api/method/frappe.auth.get_logged_user` returns 200 |
| 2 | ERPNext product, MSME, and customer APIs return valid data | ERPNext team | Manual API call verification against test data |
| 3 | ERPNext custom Susu and Loan module APIs are deployed | ERPNext team | Endpoint existence check |
| 4 | ERPNext tax configuration matches `cached_tax_rates` seed data | ERPNext team + Gateway team | Rate comparison audit |
| 5 | Gateway environment variables updated | DevOps | `ERP_MODE=live`, `ERPNEXT_BASE_URL`, `ERPNEXT_API_KEY`, `ERPNEXT_API_SECRET` |
| 6 | `LiveAdapter` integration tests pass against ERPNext staging | Gateway team | Automated test suite |
| 7 | Flutter POS team confirms no client-side changes required | POS team | Smoke test of login → offline operation → sync cycle |
| 8 | Sync queue drain test: submit 500-action batch and verify all reach ERPNext | Gateway team + ERPNext team | `sync_queue_logs` shows 500 `completed` with valid `erpnext_ref` values |

**The Flutter POS codebase requires zero changes for this transition.** The API contracts are identical in both modes. This is the entire point of the adapter pattern.

---

## 5.9 Environment Variables — Complete Reference

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ERP_MODE` | No | `mock` | `mock` or `live` — controls adapter selection |
| `ERPNEXT_BASE_URL` | If `live` | — | ERPNext instance URL (e.g., `https://erp.triliska.com`) |
| `ERPNEXT_API_KEY` | If `live` | — | ERPNext API key for Gateway service account |
| `ERPNEXT_API_SECRET` | If `live` | — | ERPNext API secret |
| `MOCK_FAILURE_RATE` | No | `0.0` | Simulated ERPNext failure rate in mock mode |
| `MOCK_FAILURE_TYPE` | No | `5xx` | Type of simulated failure (`5xx`, `timeout`, `400`, `404`) |
| `MOCK_FORWARD_DELAY_MS` | No | `100` | Simulated ERPNext response latency in mock mode (ms) |
| `JWT_SECRET` | Yes | — | Secret key for signing Edge JWTs |
| `JWT_ACCESS_TOKEN_TTL` | No | `900` | Access token lifetime in seconds (default: 15 minutes) |
| `JWT_REFRESH_TOKEN_TTL` | No | `604800` | Refresh token lifetime in seconds (default: 7 days) |
| `CACHE_REFRESH_INTERVAL_MS` | No | `900000` | Tax rate cache refresh interval in ms (default: 15 minutes) |
| `ERPNEXT_MAX_CONCURRENT_REQUESTS` | No | `20` | Max simultaneous ERPNext API calls |
| `ERPNEXT_CIRCUIT_BREAKER_THRESHOLD` | No | `5` | Consecutive failures before circuit breaker trips |
| `ERPNEXT_CIRCUIT_BREAKER_COOLDOWN_MS` | No | `30000` | Circuit breaker cooldown in ms |
| `STALE_DEVICE_THRESHOLD_DAYS` | No | `30` | Days before inactive device is auto-deregistered |
| `DATABASE_URL` | Yes | — | Postgres 16 connection string |

---

*End of Section 5 — API Contracts & The Phase 0 Mocking Strategy*
*Next: Section 6 — Gateway Database Schema*
