# Section 7: Error Handling, Dead Letter Queues & Retry Mechanisms

**Document:** TriLiska POS Gateway — Master System Architecture & PRD
**Section:** 07 — Error Handling, Dead Letter Queues & Retry Mechanisms
**Prepared by:** Trident Aliska Digital Tech Ghana LTD
**Programme:** GRA MSME Tax & Business Management Programme
**Sprint Focus:** POS Backend Gateway (Node.js 24 / Postgres 16)
**Date:** March 2026
**Classification:** Enterprise — Restricted Distribution

---

## 7.1 Overview

The TriLiska POS Gateway operates at the intersection of two unreliable boundaries: Sunmi POS devices with intermittent mobile connectivity at Makola Market, and an ERPNext backend that may be temporarily unavailable, overloaded, or returning business logic rejections. The Gateway's error handling strategy is built on a single non-negotiable principle:

> **No valid data is ever lost.** If the Gateway has accepted an action into `sync_queue_logs` (returned `202 Accepted`), that action will eventually reach ERPNext or be surfaced to operations staff for manual resolution. There is no silent discard path.

This section defines the complete error taxonomy, the retry strategy, the dead letter queue (DLQ) workflow, and the circuit breaker mechanism that protects ERPNext during sustained failure conditions.

---

## 7.2 Error Taxonomy

Errors in the Gateway are classified into two fundamentally different categories based on where they originate and how they are handled.

### 7.2.1 Category 1: Gateway-Level Validation Errors

These errors are detected **before** an action enters the sync queue. They are the result of malformed, structurally invalid, or arithmetically inconsistent payloads submitted by the POS device. These actions are **instantly rejected** — they are never written to `sync_queue_logs` with `pending` status and are never forwarded to ERPNext.

| Error Code | HTTP Status | Trigger | Retry Behaviour |
|------------|------------|---------|-----------------|
| `BATCH_VALIDATION_FAILED` | `422` | Batch envelope is structurally invalid (missing `batch_ref`, empty `actions` array, `device_id` mismatch with JWT claims) | **Not retryable.** The entire batch is rejected. No `sync_queue_logs` entries are created. The POS must fix the batch envelope and resubmit. |
| `PAYLOAD_VALIDATION_FAILED` | `422` | Zod schema validation failure on one or more actions (missing required fields, invalid types, enum violations) | **Not retryable** for the specific failing action. Other valid actions in the batch are accepted. The failing action is recorded in `sync_queue_logs` with `status = 'failed'` and `failure_reason` populated for DLQ review. |
| `MATH_VALIDATION_FAILED` | `422` | Arithmetic inconsistency in a `CREATE_SALE` payload (e.g., `line_total_before_tax` does not equal `quantity × unit_price - discount_amount` beyond rounding tolerance) | **Not retryable** without POS-side correction. Recorded in `sync_queue_logs` as `failed`. |
| `DISCOUNT_TAX_ORDER_INVALID` | `422` | Tax computed on pre-discount amount instead of post-discount `line_total_before_tax` | **Not retryable** without POS-side correction. Indicates a computation bug in the Flutter POS tax engine. Recorded in `sync_queue_logs` as `failed`. |
| `TAX_VERSION_UNKNOWN` | `422` | `tax_rate_version` references a `version_id` that does not exist in `cached_tax_rates` | **Not retryable.** May indicate payload tampering or data corruption. Recorded in `sync_queue_logs` as `failed`. |
| `UNKNOWN_ACTION_TYPE` | `422` | `action_type` is not one of the five permitted values | **Not retryable.** Recorded in `sync_queue_logs` as `failed`. |
| `DEVICE_MISMATCH` | `403` | `device_id` in payload does not match `device_id` in JWT claims | **Not retryable.** Entire batch rejected. No `sync_queue_logs` entries created. |
| `MSME_MISMATCH` | `403` | `msme_id` in payload does not match `msme_id` in JWT claims | **Not retryable.** Entire batch rejected. No `sync_queue_logs` entries created. |
| `RATE_LIMITED` | `429` | Per-device or per-MSME rate limit exceeded | **Retryable** after the duration specified in the `Retry-After` response header. |

### 7.2.2 Category 2: ERPNext-Level Processing Errors

These errors occur **after** an action has been accepted into `sync_queue_logs` and the background worker attempts to forward it to ERPNext. The action is already safely persisted in Postgres — the error determines whether the worker retries or moves the action to the dead letter queue.

| Error Category | ERPNext Response | Retryable | Worker Behaviour |
|---------------|-----------------|-----------|-----------------|
| **Server Error** | `500 Internal Server Error` | **Yes** | Increment `retry_count`. Requeue as `pending` with exponential backoff. |
| **Bad Gateway** | `502 Bad Gateway` | **Yes** | ERPNext proxy or load balancer issue. Increment `retry_count`. Requeue with backoff. |
| **Service Unavailable** | `503 Service Unavailable` | **Yes** | ERPNext is temporarily down (maintenance, overload). Increment `retry_count`. Requeue with backoff. |
| **Gateway Timeout** | `504 Gateway Timeout` | **Yes** | ERPNext did not respond within the configured threshold. Increment `retry_count`. Requeue with backoff. |
| **Network Error** | Connection refused / DNS failure / socket hang up | **Yes** | Infrastructure-level failure. Increment `retry_count`. Requeue with backoff. |
| **Write Conflict** | `409 Conflict` | **Yes** | Concurrent write on the same ERPNext document (e.g., simultaneous stock adjustments). Increment `retry_count`. Requeue with backoff and jitter. |
| **Bad Request** | `400 Bad Request` | **No** | The transformed payload is structurally invalid for ERPNext. Indicates a **Gateway transformation bug** — the payload passed Gateway validation but the ERPNext-mapped version is malformed. Move to `failed` immediately. |
| **Not Found** | `404 Not Found` | **No** | A referenced entity does not exist in ERPNext (e.g., `product_id` not in the ERPNext Item catalogue, `susu_scheme_id` not found, `loan_id` does not exist). Move to `failed` immediately. Requires manual data correction in ERPNext before re-queue. |
| **Validation Failure** | `422 Unprocessable Entity` | **No** | ERPNext business rule rejection (e.g., insufficient stock for a `STOCK_MOVEMENT` with `movement_type = 'correction'`, loan already fully repaid for a `LOAN_REPAYMENT`, Susu scheme is inactive). Move to `failed` immediately. |
| **Authentication Failure** | `401 Unauthorized` / `403 Forbidden` | **No** | Gateway service account credentials are invalid or expired. Move to `failed` immediately **and** trigger a critical operational alert — this affects all forwarding, not just one action. |

### 7.2.3 Error Flow Diagram

```
POST /sync/batch arrives
  │
  ├─── Batch envelope invalid? ──── YES ──→ 422 (entire batch rejected)
  │                                          No sync_queue_logs entries
  │
  ├─── Per-action Zod validation
  │    ├── PASS ──→ Insert to sync_queue_logs (status = 'pending')
  │    └── FAIL ──→ Insert to sync_queue_logs (status = 'failed')
  │                 Include in 207 Multi-Status response
  │
  ├─── Per-action math validation (CREATE_SALE only)
  │    ├── PASS ──→ Proceed to idempotency check
  │    └── FAIL ──→ Insert to sync_queue_logs (status = 'failed')
  │
  ├─── Idempotency check (client_ref)
  │    ├── NEW ──→ Insert to sync_queue_logs (status = 'pending')
  │    ├── ALREADY_COMPLETED ──→ Return idempotent success
  │    ├── IN_PROGRESS ──→ Return current status
  │    └── PREVIOUSLY_FAILED ──→ Reset to 'pending' for retry
  │
  └─── Return 202 / 207 with per-action statuses
         │
         ▼
  Background Worker picks up 'pending' actions
         │
         ├─── Forward to ERPNext (or Mock Adapter)
         │
         ├─── Success ──→ status = 'completed', erpnext_ref populated
         │
         ├─── Retryable error ──→ retry_count < max_retries?
         │    ├── YES ──→ status = 'pending' (requeue with backoff)
         │    └── NO  ──→ status = 'failed' (dead letter)
         │
         └─── Non-retryable error ──→ status = 'failed' (dead letter)
                                      failure_reason populated
                                      Alert emitted
```

---

## 7.3 Retry Strategy

### 7.3.1 Configuration

| Parameter | Default | Environment Variable | Description |
|-----------|---------|---------------------|-------------|
| Maximum retries | 5 | `SYNC_MAX_RETRIES` | Maximum processing attempts before an action moves to `failed` |
| Base delay | 1,000 ms | `SYNC_RETRY_BASE_DELAY_MS` | Initial delay before first retry |
| Maximum delay | 60,000 ms | `SYNC_RETRY_MAX_DELAY_MS` | Cap on exponential backoff |
| Jitter range | 0–500 ms | `SYNC_RETRY_JITTER_MS` | Random jitter added to each retry delay to prevent thundering herd |

### 7.3.2 Backoff Formula

```
delay = min(base_delay × 2^attempt + random(0, jitter_range), max_delay)
```

| Attempt | Base Calculation | With Max Delay Cap | Effective Range (with jitter) |
|---------|-----------------|-------------------|-------------------------------|
| 1 | 1,000 × 2¹ = 2,000 ms | 2,000 ms | 2,000 – 2,500 ms |
| 2 | 1,000 × 2² = 4,000 ms | 4,000 ms | 4,000 – 4,500 ms |
| 3 | 1,000 × 2³ = 8,000 ms | 8,000 ms | 8,000 – 8,500 ms |
| 4 | 1,000 × 2⁴ = 16,000 ms | 16,000 ms | 16,000 – 16,500 ms |
| 5 | 1,000 × 2⁵ = 32,000 ms | 32,000 ms | 32,000 – 32,500 ms |

**Total worst-case delay across all 5 retries:** ~63 seconds. An action that fails all 5 attempts will reach `failed` status within approximately 1 minute of its first processing attempt.

### 7.3.3 Retry State Transitions in `sync_queue_logs`

```sql
-- Worker encounters a retryable error

UPDATE sync_queue_logs
SET
    status = CASE
        WHEN retry_count + 1 >= max_retries THEN 'failed'
        ELSE 'pending'
    END,
    retry_count = retry_count + 1,
    failure_reason = :error_message,
    completed_at = CASE
        WHEN retry_count + 1 >= max_retries THEN now()
        ELSE NULL
    END
WHERE id = :action_id;
```

The worker does **not** implement the delay itself. Instead, it returns the action to `pending` status with an incremented `retry_count`. A separate scheduler (or the worker's next polling cycle after the delay interval) picks it up. This keeps the worker stateless and prevents blocked threads during backoff periods.

---

## 7.4 Dead Letter Queue (DLQ) Workflow

### 7.4.1 What Is the DLQ

The DLQ is not a separate table or infrastructure component. It is the subset of rows in `sync_queue_logs` where `status = 'failed'`. These actions have either:

- Exhausted all retry attempts (`retry_count >= max_retries`) against retryable ERPNext errors, or
- Encountered a non-retryable error (ERPNext 400, 404, 422, or Gateway validation failure)

Failed actions remain in `sync_queue_logs` indefinitely until manually resolved. They are never auto-purged, never silently discarded, and never re-queued without explicit human action.

### 7.4.2 DLQ Visibility

Failed actions are surfaced to operations staff through two channels:

| Channel | Audience | Mechanism |
|---------|----------|-----------|
| **Web Portal DLQ Dashboard** | Programme Staff (`programme_staff`), System Administrators (`admin`) | React/Vue dashboard queries ERPNext, which proxies to the Gateway's `GET /admin/dlq` endpoint. Displays failed actions grouped by `msme_id`, `action_type`, and `failure_reason`. |
| **Automated Alerts** | DevOps / on-call operations staff | When an action transitions to `failed`, the Gateway emits an alert via configurable channels (webhook, email, or structured log entry). Alert includes `client_ref`, `action_type`, `msme_id`, `failure_reason`, and `retry_count`. |

### 7.4.3 DLQ Resolution Procedures

| Failure Scenario | Root Cause | Resolution Steps | Actor |
|-----------------|------------|-----------------|-------|
| **ERPNext 404: Product not found** | MSME sold a product on the POS that does not exist in ERPNext's Item catalogue (e.g., product was in a mock fixture but not yet created in ERPNext after `ERP_MODE=live` transition) | 1. Identify missing `product_id` from `failure_reason` 2. Create the product in ERPNext 3. Re-queue the action via `POST /admin/dlq/requeue/{client_ref}` | `admin` or `programme_staff` (ERPNext) + `admin` (Gateway) |
| **ERPNext 404: Susu scheme not found** | The `susu_scheme_id` in a `SUSU_CONTRIBUTION` action references a scheme that has not been created in ERPNext's custom Susu module | 1. Create the Susu scheme in ERPNext 2. Re-queue the action | `admin` (ERPNext) + `admin` (Gateway) |
| **ERPNext 404: Loan not found** | The `loan_id` in a `LOAN_REPAYMENT` action references a loan that does not exist in ERPNext | 1. Create or verify the loan record in ERPNext 2. Re-queue the action | `admin` (ERPNext) + `admin` (Gateway) |
| **ERPNext 422: Insufficient stock** | A `STOCK_MOVEMENT` with `movement_type = 'correction'` attempted to reduce stock below zero | 1. Review the stock correction in ERPNext 2. Adjust stock levels or correct the movement quantity 3. Re-queue or discard the action | `programme_staff` + `admin` |
| **ERPNext 422: Loan fully repaid** | A `LOAN_REPAYMENT` was recorded on the POS for a loan that has already been fully repaid in ERPNext | 1. Verify loan status in ERPNext 2. If genuinely overpaid, discard the action with audit-logged reason 3. If ERPNext record is incorrect, fix loan balance and re-queue | `programme_staff` + `admin` |
| **ERPNext 400: Transformation bug** | The Gateway's payload transformation produced an invalid ERPNext DocType structure | 1. Inspect the `payload` and `failure_reason` in `sync_queue_logs` 2. Fix the Gateway transformation logic 3. Deploy fix 4. Re-queue all affected actions | `admin` (Gateway development team) |
| **ERPNext 401/403: Auth failure** | Gateway service account credentials expired or were revoked in ERPNext | 1. Rotate Gateway service account credentials in ERPNext 2. Update `ERPNEXT_API_KEY` / `ERPNEXT_API_SECRET` environment variables 3. Restart Gateway (or trigger credential reload) 4. Re-queue all affected actions | `admin` (DevOps) |
| **Max retries exhausted on 5xx** | ERPNext experienced a prolonged outage exceeding the retry window | 1. Confirm ERPNext is back online 2. Bulk re-queue all `failed` actions from the outage window | `admin` |
| **Gateway validation: MATH_VALIDATION_FAILED** | The Flutter POS computed incorrect tax arithmetic | 1. Inspect the `payload` to identify the computation error 2. This is a POS-side bug — escalate to the Flutter development team 3. If the error is minor (rounding), the action may be manually corrected and re-queued 4. If the error is fundamental, discard with audit-logged reason | `admin` + Flutter team |
| **Gateway validation: TAX_VERSION_UNKNOWN** | POS submitted a `tax_rate_version` that does not exist in `cached_tax_rates` | 1. Check if the version was pruned (>90 days old) 2. Check for POS data corruption 3. Typically discard with audit-logged reason | `admin` |

### 7.4.4 Re-Queue Endpoint

**Endpoint:** `POST /admin/dlq/requeue/{client_ref}`
**Auth:** Admin token (ERPNext SSO, `admin` role)

**Behaviour:**

```sql
UPDATE sync_queue_logs
SET status = 'pending',
    retry_count = 0,
    failure_reason = NULL,
    processing_started_at = NULL,
    completed_at = NULL
WHERE client_ref = :client_ref
AND status = 'failed';
```

The action re-enters the queue at its original `recorded_at` position and will be picked up by the next worker cycle.

**Bulk re-queue** (e.g., after ERPNext outage recovery):

**Endpoint:** `POST /admin/dlq/requeue-bulk`
**Body:** `{ "filter": { "failure_reason_contains": "503 Service Unavailable", "received_at_after": "2026-03-28T00:00:00Z" } }`

```sql
UPDATE sync_queue_logs
SET status = 'pending',
    retry_count = 0,
    failure_reason = NULL,
    processing_started_at = NULL,
    completed_at = NULL
WHERE status = 'failed'
AND failure_reason LIKE '%503 Service Unavailable%'
AND received_at >= :after_timestamp;
```

### 7.4.5 Permanent Discard

For irrecoverably invalid actions (e.g., test data from device setup, fundamentally corrupt payloads), an admin may permanently discard an action:

**Endpoint:** `POST /admin/dlq/discard/{client_ref}`
**Body:** `{ "reason": "Test data from device setup — not a real transaction" }`

The action is **not deleted** from `sync_queue_logs`. Instead, its status is updated to `discarded` and the discard reason is appended to `failure_reason`:

```sql
UPDATE sync_queue_logs
SET status = 'discarded',
    failure_reason = failure_reason || E'\n[DISCARDED] ' || :reason || ' by ' || :admin_user_id || ' at ' || now(),
    completed_at = now()
WHERE client_ref = :client_ref
AND status = 'failed';
```

**This is a destructive, audit-logged action.** The discard reason, admin identity, and timestamp are immutably recorded. No action can be discarded without attribution.

---

## 7.5 Circuit Breaker

### 7.5.1 Purpose

If ERPNext becomes unresponsive or returns sustained 5xx errors, the Gateway must stop forwarding actions to prevent:

1. **Wasted retries** — each forwarding attempt consumes a retry count. Without a circuit breaker, all queued actions would exhaust their retries during an ERPNext outage and move to `failed`, requiring mass manual re-queue.
2. **Connection exhaustion** — sustained failed HTTP calls consume connection pool resources, degrading Gateway performance for non-ERPNext functions (auth, validation, queue acceptance).
3. **ERPNext recovery interference** — flooding a recovering ERPNext instance with queued requests delays its stabilisation.

The circuit breaker pauses ERPNext forwarding while **continuing to accept and queue POS sync batches**. No data is lost during an ERPNext outage.

### 7.5.2 States

```
┌──────────────┐
│    CLOSED    │  (normal operation — forwarding active)
│              │
│  Forward all │
│  actions to  │
│  ERPNext     │
└──────┬───────┘
       │
       │  consecutive_failures >= threshold
       │
       ▼
┌──────────────┐
│     OPEN     │  (ERPNext unreachable — forwarding paused)
│              │
│  Queue       │
│  accepts     │
│  continue;   │
│  no forwards │
└──────┬───────┘
       │
       │  cooldown_ms elapsed
       │
       ▼
┌──────────────┐
│  HALF-OPEN   │  (probing — send one test request)
│              │
│  Single probe│
│  request to  │
│  ERPNext     │
└──────┬───────┘
       │
       ├── Probe succeeds ──→ CLOSED (resume forwarding)
       │
       └── Probe fails ────→ OPEN (restart cooldown)
```

### 7.5.3 Configuration

| Parameter | Default | Environment Variable | Description |
|-----------|---------|---------------------|-------------|
| Failure threshold | 5 | `ERPNEXT_CIRCUIT_BREAKER_THRESHOLD` | Consecutive ERPNext 5xx or network errors before the circuit opens |
| Cooldown period | 30,000 ms | `ERPNEXT_CIRCUIT_BREAKER_COOLDOWN_MS` | Time the circuit stays open before transitioning to half-open |
| Probe endpoint | `GET /api/method/frappe.ping` | `ERPNEXT_HEALTH_ENDPOINT` | Lightweight ERPNext endpoint used for half-open probing |
| Success threshold | 1 | — | Number of successful probes required to close the circuit (single probe is sufficient) |

### 7.5.4 Behaviour During Open Circuit

| Gateway Function | Behaviour |
|-----------------|-----------|
| `POST /sync/batch` | **Fully operational.** Batches are validated, deduplicated, and persisted to `sync_queue_logs` with `status = 'pending'`. The POS receives `202 Accepted`. No data is lost. |
| Background worker | **Paused for ERPNext forwarding.** Worker does not attempt to pick up `pending` actions while the circuit is open. Actions accumulate in the queue. |
| `GET /sync/status/{batch_ref}` | **Operational.** Returns current queue status. Actions will show as `pending` during the outage. |
| `POST /auth/login` | **Degraded in live mode.** If `ERP_MODE=live`, login requires ERPNext SSO for credential validation. Logins will fail during ERPNext outage. POS devices with valid cached sessions can continue offline operation. In mock mode, login is unaffected. |
| `GET /tax-rates` | **Operational.** Served from local `cached_tax_rates` Postgres table — no ERPNext dependency. |
| `GET /products`, `GET /msme-profile` | **Degraded in live mode.** These proxy to ERPNext and will fail. In mock mode, served from fixtures — unaffected. |

### 7.5.5 Circuit Breaker Logging

Every state transition is logged:

```
[CIRCUIT_BREAKER] State: CLOSED → OPEN
  Reason: 5 consecutive failures
  Last error: 503 Service Unavailable
  Queued actions pending: 47
  Timestamp: 2026-03-28T17:45:00Z

[CIRCUIT_BREAKER] State: OPEN → HALF_OPEN
  Cooldown elapsed: 30000ms
  Probing: GET /api/method/frappe.ping
  Timestamp: 2026-03-28T17:45:30Z

[CIRCUIT_BREAKER] State: HALF_OPEN → CLOSED
  Probe result: 200 OK
  Queued actions to process: 47
  Timestamp: 2026-03-28T17:45:31Z
```

### 7.5.6 Queue Drain After Circuit Recovery

When the circuit transitions from HALF-OPEN to CLOSED, the background worker resumes processing. Accumulated `pending` actions are processed in strict `recorded_at` chronological order, subject to the ERPNext forwarding rate limits defined in Section 3.5.4. The Gateway does not "dump" the accumulated queue — it feeds actions at the controlled rate (`ERPNEXT_MAX_CONCURRENT_REQUESTS`, `ERPNEXT_REQUEST_INTERVAL_MS`) to prevent re-triggering the circuit breaker on a recovering ERPNext instance.

---

## 7.6 Monitoring & Alerting

### 7.6.1 Key Metrics

| Metric | Description | Alert Threshold |
|--------|-------------|-----------------|
| `sync_queue_pending_count` | Number of actions with `status = 'pending'` | > 1,000 (sustained for 5 minutes) |
| `sync_queue_failed_count` | Number of actions with `status = 'failed'` | > 0 (any new failure triggers alert) |
| `sync_queue_processing_duration_p99` | 99th percentile time from `processing_started_at` to `completed_at` | > 10,000 ms |
| `sync_queue_oldest_pending_age` | Time since the oldest `pending` action's `received_at` | > 300,000 ms (5 minutes — indicates worker stall or circuit breaker open) |
| `circuit_breaker_state` | Current circuit breaker state | State = OPEN (triggers immediate alert) |
| `erpnext_forward_success_rate` | Percentage of successful ERPNext forwards in the last 5 minutes | < 90% |
| `erpnext_forward_latency_p99` | 99th percentile ERPNext API response time | > 5,000 ms |
| `auth_login_failure_rate` | Failed login attempts per minute per phone number | > 5/min (potential brute-force) |
| `device_conflict_count` | Number of `409 DEVICE_CONFLICT` responses per hour | > 10/hour (potential operational issue with device transfers) |

### 7.6.2 Alert Channels

| Channel | Configuration | Use Case |
|---------|--------------|----------|
| Structured logging (JSON) | Always enabled | All metrics, state transitions, and errors are emitted as structured JSON logs for aggregation (e.g., via ELK, CloudWatch, or Grafana Loki) |
| Webhook | `ALERT_WEBHOOK_URL` | Critical alerts (DLQ entries, circuit breaker state changes, auth failures) pushed to Slack, Teams, or PagerDuty |
| Email | `ALERT_EMAIL_RECIPIENTS` | Daily DLQ summary report for Programme Staff and admin |

---

## 7.7 Error Handling Summary

| Error Source | Detection Point | Persistence | Retry | Human Intervention |
|-------------|----------------|-------------|-------|-------------------|
| Malformed batch envelope | API layer (pre-queue) | Not persisted | No | POS team must fix client code |
| Zod schema validation failure | API layer (pre-queue) | `sync_queue_logs` as `failed` | No | DLQ review; POS team fix |
| Math/discount validation failure | API layer (pre-queue) | `sync_queue_logs` as `failed` | No | DLQ review; POS team fix |
| Tax version unknown | API layer (pre-queue) | `sync_queue_logs` as `failed` | No | DLQ review; investigate data integrity |
| ERPNext 5xx / timeout / network | Background worker | `sync_queue_logs` retry cycle | Yes (up to 5×) | Only if retries exhausted |
| ERPNext 409 conflict | Background worker | `sync_queue_logs` retry cycle | Yes (with jitter) | Only if retries exhausted |
| ERPNext 400 (transformation bug) | Background worker | `sync_queue_logs` as `failed` | No | Gateway code fix required |
| ERPNext 404 (missing entity) | Background worker | `sync_queue_logs` as `failed` | No | Create entity in ERPNext, then re-queue |
| ERPNext 422 (business rule) | Background worker | `sync_queue_logs` as `failed` | No | Resolve business rule in ERPNext, then re-queue |
| ERPNext 401/403 (auth) | Background worker | `sync_queue_logs` as `failed` | No | Rotate Gateway service account credentials |
| Sustained ERPNext outage | Circuit breaker | Actions queue as `pending` | Automatic on recovery | None — queue drains automatically |

---

*End of Section 7 — Error Handling, Dead Letter Queues & Retry Mechanisms*
*Next: Section 8 — Security & Infrastructure Compliance*
