# TriLiska POS Gateway — Phase 1 Implementation Plan

**Stack:** NestJS / Node.js 24 / TypeORM / Postgres 16 / Jest / Winston
**Mode:** Phase 0 (Mock Adapter Strategy) → Phase 1 (Live ERPNext)
**Authority:** `docs/` PRD sections 01–08

---

## Step 1: Project Scaffolding & Dev Environment ✅

- [x] Initialize NestJS project (`@nestjs/cli`) with strict TypeScript config
- [x] Configure `tsconfig.json` (strict mode, path aliases `@src/*`, ES2023 target)
- [x] Set up `docker-compose.yml` with Postgres 16 service
- [x] Install and configure `@nestjs/config` with Joi env schema validation
- [x] Define `.env.example` with all required env vars (`DATABASE_*`, `ERP_MODE`, `JWT_*`, `MOCK_*`)
- [x] Install and configure Winston (`nest-winston`) for structured JSON logging (no PII)
- [x] Configure TypeORM module with `namingStrategy: SnakeNamingStrategy` for camelCase → snake_case mapping
- [x] Set up global `ValidationPipe` with `class-validator` + `class-transformer`
- [x] Create `GET /health` endpoint (no auth, returns `{ status: 'ok', timestamp, uptime }`)
- [x] Verify: build passes, Jest passes, health controller tested (Docker e2e deferred — Docker not installed on machine)
- [x] Add `.gitignore`, `.env.example`, ESLint + Prettier config

---

## Step 2: Database Schema & Migrations ✅

> **Schema Override Applied:** `device_id` replaced with `install_id` (UUID, NOT NULL) + `hardware_serial` (VARCHAR 128, nullable) across all 3 device-bearing tables.

- [x] Create TypeORM migration: `refresh_tokens` table (with `install_id` + `hardware_serial`)
- [x] Create TypeORM migration: `active_devices` table (`msme_id` PK, `install_id` + `hardware_serial`)
- [x] Create TypeORM migration: `sync_queue_logs` table (all PRD columns + `install_id`/`hardware_serial`, partial index on failed)
- [x] Create TypeORM migration: `cached_tax_rates` table (DECIMAL 5,2, unique composite constraint)
- [x] Create corresponding TypeORM entity classes for all 4 tables
- [x] Create tax rates seed migration (5 GRA Modified Tax System rates, idempotent ON CONFLICT)
- [x] Verify: build passes, tests pass (DB verification deferred until Docker available)

---

## Step 3: Configuration & Shared Module

- [ ] Create `src/config/` module with Joi-validated env schema
  - Groups: `database`, `jwt`, `erp`, `mock`, `rateLimit`, `app`
  - All env vars from PRD: `ERP_MODE`, `MOCK_FAILURE_RATE`, `MOCK_FAILURE_TYPE`, `MOCK_FORWARD_DELAY_MS`, `JWT_PRIVATE_KEY_PATH`, `JWT_PUBLIC_KEY_PATH`, `JWT_ACCESS_TTL`, `JWT_REFRESH_TTL`, etc.
- [ ] Create `src/common/` shared module
  - Global exception filter with PRD error response format (`{ status, error, message, ... }`)
  - Error code constants enum (`DEVICE_CONFLICT`, `BATCH_VALIDATION_FAILED`, `MATH_VALIDATION_FAILED`, etc.)
  - Winston logger service wrapper (auto-redacts PII fields)
  - Custom decorators: `@CurrentUser()` param decorator for extracting JWT claims

---

## Step 4: Auth Module — JWT & Refresh Tokens

- [ ] Create `src/auth/` module
- [ ] Implement DTOs with class-validator:
  - `LoginDto` — `phone` (E.164 format), `pin` (4–6 digit string), `deviceId`
  - `RefreshDto` — `refreshToken`
  - `LoginResponseDto` — `accessToken`, `refreshToken`, `expiresIn`, `userProfile`
- [ ] Implement `TokenService`
  - `generateAccessToken(payload)` — RS256 signed JWT, 15-min TTL, claims: `sub`, `role`, `msmeId`, `zone`, `district`, `deviceId`
  - `generateRefreshToken(userId, deviceId)` — UUID v4, store SHA-256 hash in `refresh_tokens` with `token_family`
  - `rotateRefreshToken(oldToken)` — revoke old, issue new in same family, increment `rotation_count`
  - `revokeTokenFamily(tokenFamily)` — theft detection: revoke all tokens in family
  - `validateAccessToken(token)` — verify RS256 signature, check expiry
- [ ] Implement `DeviceService`
  - `registerDevice(msmeId, deviceId, userId)` — UPSERT into `active_devices` if same device, else check conflict
  - `checkDeviceConflict(msmeId, deviceId)` — return `409 DEVICE_CONFLICT` response per PRD contract
  - `deregisterDevice(msmeId)` — remove from `active_devices`
  - `updateLastSeen(msmeId)` — touch `last_seen_at`
- [ ] Implement `AuthService`
  - `login(dto)` — in mock mode: validate against fixture JSON; enforce device check; issue tokens
  - `refresh(dto)` — validate refresh token hash, detect family reuse (theft), rotate
  - `logout(userId, deviceId)` — revoke family, deregister device
- [ ] Implement `AuthController`
  - `POST /auth/login` → `AuthService.login()`
  - `POST /auth/refresh` → `AuthService.refresh()`
  - `POST /auth/logout` → `AuthService.logout()` (requires JWT guard)
- [ ] Implement `JwtAuthGuard` (global-capable, excludes `/health`, `/auth/login`, `/auth/refresh`)
- [ ] **Unit tests:** token generation/validation, refresh rotation, family revocation, device conflict detection

---

## Step 5: ERP Adapter Module — Mock Implementation

- [ ] Create `src/erp-adapter/` module
- [ ] Define `ErpAdapter` interface (abstract class)
  - `validateCredentials(phone, pin): Promise<UserProfile | null>`
  - `forwardAction(action: SyncQueueLog): Promise<ErpForwardResult>`
  - `fetchProducts(msmeId): Promise<Product[]>`
  - `fetchMsmeProfile(msmeId): Promise<MsmeProfile>`
- [ ] Implement `MockAdapter` (implements `ErpAdapter`)
  - Credential validation against `fixtures/users.json`
  - Action forwarding: configurable delay (`MOCK_FORWARD_DELAY_MS`), mock ERPNext refs (`SI-MOCK-{seq}`, `SE-MOCK-{seq}`, etc.)
  - Configurable failure simulation (`MOCK_FAILURE_RATE`, `MOCK_FAILURE_TYPE`)
  - Static JSON fixtures: `products.json`, `msme-profiles.json`, `users.json`
- [ ] Implement `LiveAdapter` (stub — throws `NotImplementedException` for Phase 0)
- [ ] Register adapter via factory provider: inject `MockAdapter` or `LiveAdapter` based on `ERP_MODE` env var
- [ ] **Unit tests:** mock adapter returns correct refs per action type, failure simulation respects configured rate

---

## Step 6: Tax Rate Cache Module

- [ ] Create `src/tax-rates/` module
- [ ] Implement `TaxRateService`
  - `getRatesByVatStatus(vatStatus): Promise<TaxRate[]>` — query `cached_tax_rates` for latest versions per tax type
  - `validateTaxVersion(versionId, recordedAt): ValidationResult` — confirm version existed and was active at business time
  - `seedRates()` — run on startup in mock mode to populate initial GRA rates
- [ ] Implement `TaxRateController`
  - `GET /tax-rates?vatStatus=standard` — returns rates per PRD contract (requires JWT guard)
- [ ] Implement DTOs: `TaxRateQueryDto`, `TaxRateResponseDto`
- [ ] **Unit tests:** version validation logic, correct rates returned per VAT status scope

---

## Step 7: Sync Module — Batch Ingestion & Validation

- [ ] Create `src/sync/` module
- [ ] Implement action payload DTOs with class-validator discriminated unions:
  - `CreateSalePayloadDto` — items array with nested `SaleItemDto` (quantity, unitPrice, discountAmount, lineTotalBeforeTax, taxLines, lineTotalAfterTax), subtotalBeforeTax, totalTax, grandTotal, paymentMethod, amountTendered, changeGiven
  - `StockMovementPayloadDto` — productId, movementType (received/damaged/correction), quantity, reason
  - `RecordExpensePayloadDto` — category (enum), amount, description, receiptRef
  - `SusuContributionPayloadDto` — schemeId, amount, contributionDate
  - `LoanRepaymentPayloadDto` — loanId, amount, paymentMethod
  - `SyncActionDto` — actionType, clientRef, recordedAt, taxRateVersion, payload (discriminated by actionType)
  - `SyncBatchDto` — deviceId, msmeId, batchRef, actions[] (1–500 items)
- [ ] Implement `MathValidationService` (CREATE_SALE specific)
  - Rule 1: `line_total_before_tax = (quantity × unit_price) − discount_amount` (per item)
  - Rule 2: Each `tax_line.tax_amount = line_total_before_tax × (rate_percent / 100)`
  - Rule 3: `line_total_after_tax = line_total_before_tax + sum(tax_lines)`
  - Rule 4: `subtotal_before_tax = sum(line_totals_before_tax)`
  - Rule 5: `total_tax = sum(all tax amounts)`
  - Rule 6: `grand_total = subtotal_before_tax + total_tax`
  - Rule 7: `change_given = amount_tendered − grand_total` (if cash)
  - Tolerance: ±0.01 GHS for rounding (emit `MATH_ROUNDED` warning)
- [ ] Implement `SyncService`
  - `processBatch(dto, user)` — validate each action, insert into `sync_queue_logs`, return per-action status
  - Idempotency: catch `client_ref` UNIQUE constraint violation → return existing record status
  - Tax version validation: call `TaxRateService.validateTaxVersion()` for tax-bearing actions
  - Device ID cross-check: `dto.deviceId` must match JWT `device_id` claim
- [ ] Implement `SyncController`
  - `POST /sync/batch` → returns `202 Accepted` or `207 Multi-Status` per PRD contract
  - `GET /sync/status/:batchRef` → aggregate batch status with per-action details
- [ ] **Unit tests:**
  - Math validation: all 7 rules, edge cases (zero discount, rounding, multiple tax lines)
  - Tax version validation: valid version, expired version, unknown version
  - Idempotency: duplicate client_ref handling
  - Batch validation: empty batch, oversized batch (>500), mixed valid/invalid actions

---

## Step 8: Sync Queue Worker — Background Processing

- [ ] Create `src/sync-worker/` module
- [ ] Implement `SyncWorkerService` (NestJS `OnModuleInit` lifecycle)
  - Polling loop: configurable interval (default 1000ms)
  - Query: `SELECT * FROM sync_queue_logs WHERE status = 'pending' ORDER BY recorded_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED`
  - Transition: `pending` → `processing` (set `processing_started_at`)
  - Forward to `ErpAdapter.forwardAction(action)`
  - On success: `processing` → `completed`, set `erpnext_ref`, `completed_at`
  - On retryable error: increment `retry_count`, revert to `pending` (if retries remaining), apply backoff delay
  - On non-retryable error / max retries: `processing` → `failed`, set `failure_reason`, `completed_at`
  - Graceful shutdown: complete in-flight action before process exit
- [ ] Implement retry backoff logic
  - Formula: `min(base_delay × 2^attempt + random(0, jitter), max_delay)`
  - Defaults: base=2000ms, jitter=500ms, max=32000ms
- [ ] Implement Circuit Breaker
  - States: `CLOSED` → `OPEN` (5 consecutive failures) → `HALF_OPEN` (probe after 30s cooldown) → `CLOSED`
  - When OPEN: skip forwarding, actions remain `pending`
  - When HALF_OPEN: send single probe, transition based on result
- [ ] **Unit tests:** state transitions, retry count logic, circuit breaker state machine, backoff calculation

---

## Step 9: Admin Module — DLQ & Device Management

- [ ] Create `src/admin/` module
- [ ] Implement `AdminController` (protected by admin-role JWT guard)
  - `GET /admin/dlq` — list failed actions with filters (actionType, msmeId, dateRange, failureReason contains)
  - `POST /admin/dlq/requeue/:clientRef` — reset failed action to `pending` (reset retry_count)
  - `POST /admin/dlq/requeue-bulk` — bulk requeue with filter criteria
  - `POST /admin/dlq/discard/:clientRef` — mark as `discarded` with audit reason
  - `POST /admin/devices/transfer` — transfer device binding to new device_id
  - `DELETE /admin/devices/:msmeId` — emergency device revocation
- [ ] Implement `AdminService` with corresponding business logic
- [ ] Implement DTOs: `DlqQueryDto`, `RequeueDto`, `BulkRequeueDto`, `DiscardDto`, `DeviceTransferDto`
- [ ] **Unit tests:** requeue resets state correctly, discard requires reason, device transfer updates binding

---

## Step 10: Rate Limiting & Middleware

- [ ] Implement rate limiting (using `@nestjs/throttler` or custom guard)
  - Per-device: 10 requests/min, 3-burst allowance
  - Per-MSME: 30 sync requests/hour
  - Login-specific: 5 attempts/min per phone, 20/min per IP, 10/min per device
  - Exclude: `GET /health`
- [ ] Implement `last_seen_at` update middleware — touch `active_devices.last_seen_at` on every authenticated request
- [ ] **Unit tests:** rate limiter correctly throttles, burst allowance works

---

## Step 11: Proxy Endpoints (Mock Data)

- [ ] Implement `GET /products` — proxy to `ErpAdapter.fetchProducts()` (mock: return fixture JSON)
- [ ] Implement `GET /msme-profile` — proxy to `ErpAdapter.fetchMsmeProfile()` (mock: return fixture for JWT's msmeId)
- [ ] Implement response DTOs for both endpoints
- [ ] **Unit tests:** correct fixture data returned in mock mode

---

## Step 12: Scheduled Maintenance Jobs

- [ ] Implement `src/maintenance/` module with NestJS `@Cron()` decorators
  - Hourly: `DELETE FROM refresh_tokens WHERE expires_at < now()`
  - Daily: `DELETE FROM refresh_tokens WHERE revoked_at IS NOT NULL AND revoked_at < now() - INTERVAL '30 days'`
  - Daily: `DELETE FROM active_devices WHERE last_seen_at < now() - INTERVAL '30 days'`
- [ ] Log each cleanup run with count of affected rows
- [ ] **Unit tests:** cleanup queries target correct records

---

## Step 13: End-to-End Smoke Test & Polish

- [ ] Write e2e test: full login → sync batch → poll status → verify completed flow
- [ ] Write e2e test: device conflict scenario (login from second device → 409)
- [ ] Write e2e test: duplicate client_ref → idempotent response
- [ ] Verify all error responses match PRD format
- [ ] Verify no PII in Winston log output (scan for phone, name, Ghana Card patterns)
- [ ] Review all DTOs against PRD Section 05 API contracts
- [ ] Update `README.md` with setup instructions, env vars, and dev workflow

---

## Conventions Reference

| Concern | Decision |
|---------|----------|
| ORM | TypeORM + `SnakeNamingStrategy` |
| Folder structure | Module-based NestJS (`src/auth/`, `src/sync/`, etc.) |
| Validation | `class-validator` + `class-transformer` |
| Testing | Jest (unit-focused on business logic) |
| Queue worker | Custom Postgres polling (`FOR UPDATE SKIP LOCKED`) |
| Config | `@nestjs/config` + Joi schema |
| Logging | Winston structured JSON (no PII) |
| Dev env | `docker-compose.yml` (Postgres 16) |
| API naming | camelCase DTOs, snake_case Postgres, kebab-case URLs |
| JWT | RS256, 15-min access, 7-day refresh, token family revocation |
| Adapter pattern | `ErpAdapter` interface → `MockAdapter` / `LiveAdapter` via `ERP_MODE` |
