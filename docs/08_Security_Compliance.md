# Section 8: Security & Infrastructure Compliance

**Document:** TriLiska POS Gateway — Master System Architecture & PRD
**Section:** 08 — Security & Infrastructure Compliance
**Prepared by:** Trident Aliska Digital Tech Ghana LTD
**Programme:** GRA MSME Tax & Business Management Programme
**Sprint Focus:** POS Backend Gateway (Node.js 24 / Postgres 16)
**Date:** March 2026
**Classification:** Enterprise — Restricted Distribution

---

## 8.1 Overview

The TriLiska POS Gateway handles personally identifiable information (PII) for MSME traders enrolled in the GRA Modified Tax programme, tax computation data governed by the VAT Act 2013 (Act 870), and financial transaction records that constitute evidence in GRA compliance audits. The Gateway's security posture must satisfy three concurrent requirements:

1. **Ghanaian legislative compliance** — conformance with the Data Protection Act 2012 (Act 843) and the Electronic Transactions Act 2008 (Act 772)
2. **GRA programme confidence** — the Gateway must not introduce any pathway through which MSME data can be intercepted, tampered with, or repudiated
3. **Operational security** — the Gateway must resist common attack vectors (credential theft, token replay, device compromise, payload tampering) while remaining operable by traders with limited technical literacy

This section defines the security controls, cryptographic standards, transport requirements, storage protections, and audit mechanisms enforced by the Gateway.

---

## 8.2 Ghana Legislative Compliance

### 8.2.1 Data Protection Act 2012 (Act 843)

The Data Protection Act 2012 (Act 843) governs the collection, processing, storage, and transmission of personal data in Ghana. The TriLiska POS Gateway processes MSME trader data — including names, phone numbers, Ghana Card numbers, TIN references, and GPS coordinates — that falls squarely within the Act's scope.

| Act 843 Principle | Gateway Compliance Measure |
|-------------------|---------------------------|
| **Accountability** (Section 17) | All data flows through the Gateway are logged with `client_ref`, `device_id`, and timestamps. The `sync_queue_logs` table provides a complete, queryable record of every action processed. The Gateway does not operate outside the auditable pipeline. |
| **Lawful processing** (Section 18) | MSME data is processed under the lawful basis of the MOU between Trident Aliska Digital Tech and the Ghana Revenue Authority. Enrolment in the programme constitutes informed consent for data processing within the programme's stated objectives. |
| **Specification of purpose** (Section 20) | The Gateway processes MSME data exclusively for tax compliance submission, Susu contribution tracking, loan repayment recording, and inventory management. No data is repurposed for marketing, profiling, or third-party sharing. |
| **Data minimisation** (Section 21) | The Gateway does not store MSME profiles, product catalogues, customer records, or financial summaries. It stores only transient operational data (refresh tokens, device registrations, sync queue entries, cached tax rates). MSME PII passes through the Gateway in sync payloads but is not indexed, searchable, or retained beyond the 90-day `sync_queue_logs` retention window. |
| **Security safeguards** (Section 28) | TLS 1.2+ for all transit (Section 8.4), encryption at rest for Postgres (Section 8.5), bcrypt hashing for cached PINs, SHA-256 hashing for refresh tokens, RS256-signed JWTs. |
| **Data subject rights** (Section 33–35) | MSME traders can request access to their data through the Programme Staff Portal (ERPNext). The Gateway does not expose a direct data subject access endpoint — this is an ERPNext responsibility as the system of record. |

### 8.2.2 Electronic Transactions Act 2008 (Act 772)

The Electronic Transactions Act 2008 (Act 772) establishes the legal validity of electronic records, electronic signatures, and digital evidence in Ghana. The TriLiska system generates and transmits tax compliance records electronically, and these records must be legally admissible.

| Act 772 Provision | Gateway Compliance Measure |
|-------------------|---------------------------|
| **Legal recognition of electronic records** (Section 4) | Every action in `sync_queue_logs` is an electronic record with a unique `client_ref` (UUID v4), a `recorded_at` business timestamp, a `device_id` identifying the originating hardware, and a `tax_rate_version` linking to the exact tax rates applied. These fields collectively constitute a legally recognisable electronic record under Section 4. |
| **Integrity of electronic records** (Section 7) | The `client_ref` UUID is generated on the POS device at the moment of action creation and is immutable throughout the pipeline (POS → Gateway → ERPNext). The UNIQUE constraint on `client_ref` in `sync_queue_logs` ensures no record can be silently replaced or duplicated. The `payload` is stored as `JSONB` and is never modified after insertion. |
| **Admissibility of electronic evidence** (Section 14) | The combination of `client_ref`, `device_id`, `recorded_at`, `tax_rate_version`, and `erpnext_ref` creates a provenance chain from the point of sale to the system of record. Each link is independently verifiable: the POS retains the local record, the Gateway retains the queue log, and ERPNext retains the final document. |
| **Attribution** (Section 8) | Every action is attributable to a specific MSME (`msme_id`), a specific user (`user_id` in JWT claims), and a specific device (`device_id`). The Edge JWT binds these three identifiers together with a cryptographic signature. |

---

## 8.3 Edge JWT Security

### 8.3.1 Signing Algorithm

| Parameter | Specification |
|-----------|--------------|
| Algorithm | **RS256** (RSA Signature with SHA-256) |
| Key type | RSA 2048-bit minimum; 4096-bit recommended for Phase 2 national scale |
| Private key storage | Gateway server only; loaded from environment variable `JWT_PRIVATE_KEY` or mounted secret file. Never committed to version control. Never transmitted to POS devices. |
| Public key distribution | POS devices and any service needing to verify Gateway-issued JWTs receive the public key via `GET /auth/.well-known/jwks.json`. |

**Why RS256 over HS256:** RS256 (asymmetric) allows any service to verify a Gateway-issued JWT using the public key without possessing the signing secret. This is essential for the hybrid architecture where ERPNext or other services may need to validate Gateway-issued tokens without sharing a symmetric secret. HS256 (symmetric) would require the signing secret to be distributed to every verifying party, increasing the attack surface.

### 8.3.2 Token Lifecycle Controls

| Control | Specification | Rationale |
|---------|--------------|-----------|
| Access token TTL | **15 minutes** (`JWT_ACCESS_TOKEN_TTL=900`) | Minimises the window of exploitation if a Sunmi device is stolen or an access token is intercepted. 15 minutes is sufficient for a sync cycle; offline POS operation does not require a valid access token. |
| Refresh token TTL | **7 days** (`JWT_REFRESH_TOKEN_TTL=604800`) | Balances trader convenience (avoids daily re-authentication) with security. A trader who does not sync for 7 days must re-authenticate online. |
| Token refresh rotation | **Mandatory** | Every refresh token use invalidates the old token and issues a new one. The old token's `revoked_at` is set. Reuse of a revoked token triggers family revocation. |
| Family revocation | **Automatic** | If a previously rotated-out refresh token is presented (indicating theft), the entire `token_family` is revoked — all sessions in that rotation chain are terminated. |
| Clock skew tolerance | **30 seconds** | JWT `exp` validation allows ±30 seconds of clock drift between the Gateway and POS devices to account for imprecise device clocks on Sunmi hardware. |
| `iss` claim validation | Required: `triliska-gateway` | Tokens not issued by the Gateway are rejected. Prevents acceptance of ERPNext SSO tokens or tokens from other systems. |
| `aud` claim | Not used in Phase 1 | May be introduced in Phase 2 if multiple Gateway instances serve different regions. |

### 8.3.3 JWT Payload — No Sensitive Data

The Edge JWT payload contains **authorisation claims only** — no PII, no credentials, no financial data:

```json
{
  "sub": "user_uuid",
  "role": "msme_owner",
  "msme_id": "msme_uuid",
  "zone": "makola_central",
  "district": "accra",
  "device_id": "sunmi_device_serial",
  "iat": 1711612800,
  "exp": 1711613700,
  "iss": "triliska-gateway"
}
```

No names, phone numbers, Ghana Card numbers, TINs, or financial balances are embedded in the JWT. If a token is intercepted, the attacker gains only UUIDs and zone identifiers — not exploitable PII.

---

## 8.4 Transport Security

### 8.4.1 TLS Requirements

| Channel | Minimum TLS Version | Certificate Requirement | Enforcement |
|---------|---------------------|------------------------|-------------|
| POS (Flutter) → Gateway | **TLS 1.2** | Valid CA-signed certificate on the Gateway | Gateway rejects non-TLS connections. The Flutter app is configured to refuse plaintext HTTP. |
| Gateway → ERPNext | **TLS 1.2** | Valid CA-signed certificate on ERPNext | Gateway's `LiveAdapter` HTTP client is configured to reject self-signed certificates in production. Self-signed may be permitted in development via `ERPNEXT_TLS_REJECT_UNAUTHORIZED=false` (never in production). |
| Admin endpoints (Web Portal → Gateway) | **TLS 1.2** | Valid CA-signed certificate on the Gateway | Admin API endpoints (`/admin/*`) are only accessible over TLS. |
| Database (Gateway → Postgres) | **TLS 1.2** (if over network) | Server certificate validation | If Postgres is co-located (same host), Unix socket connection is preferred (no network transit). If over network, `sslmode=verify-full` is required in the connection string. |

### 8.4.2 Cipher Suite Policy

The Gateway's TLS configuration restricts cipher suites to those providing forward secrecy:

| Permitted | Excluded |
|-----------|----------|
| `TLS_AES_256_GCM_SHA384` | `RC4` (all variants) |
| `TLS_AES_128_GCM_SHA256` | `DES` / `3DES` |
| `TLS_CHACHA20_POLY1305_SHA256` | `MD5`-based MACs |
| `ECDHE-RSA-AES256-GCM-SHA384` | `NULL` cipher suites |
| `ECDHE-RSA-AES128-GCM-SHA256` | `EXPORT` cipher suites |

### 8.4.3 Certificate Rotation

| Component | Rotation Schedule | Mechanism |
|-----------|------------------|-----------|
| Gateway TLS certificate | 90 days (automated) | Let's Encrypt or equivalent ACME provider; automated renewal via certbot or similar |
| JWT RS256 signing key pair | Annually (manual) | Key rotation via JWKS endpoint. Old public key remains in JWKS for token validation during the overlap window (equal to the refresh token TTL: 7 days). |
| ERPNext API credentials | Quarterly (manual) | Rotate `ERPNEXT_API_KEY` / `ERPNEXT_API_SECRET` in Gateway environment variables |

---

## 8.5 Storage Security

### 8.5.1 Postgres Encryption at Rest

| Measure | Specification |
|---------|--------------|
| Disk-level encryption | The Postgres 16 data directory resides on an encrypted volume (AES-256). This is an infrastructure-level control managed by the hosting provider or DevOps team. |
| Column-level encryption | Not implemented at the Gateway level. The Gateway's four tables do not store high-sensitivity PII directly (no Ghana Card numbers, no TINs, no financial balances). Sync payloads in `sync_queue_logs.payload` may contain product names and amounts, but these are transient (90-day retention) and protected by disk encryption + access control. |
| Postgres role-based access | The Gateway application connects with a dedicated Postgres role that has `SELECT`, `INSERT`, `UPDATE`, `DELETE` on the four Gateway tables only. No `SUPERUSER`, no `CREATEDB`, no access to system catalogues. |

### 8.5.2 Credential & Secret Storage

| Secret | Storage Method | Never Stored In |
|--------|---------------|-----------------|
| JWT RS256 private key | Environment variable (`JWT_PRIVATE_KEY`) or mounted file from secret manager (e.g., AWS Secrets Manager, HashiCorp Vault) | Version control, logs, JWT payloads, database |
| ERPNext API key/secret | Environment variables (`ERPNEXT_API_KEY`, `ERPNEXT_API_SECRET`) | Version control, logs, database |
| Postgres connection string | Environment variable (`DATABASE_URL`) | Version control, logs |
| MSME Owner PINs | **Not stored in the Gateway database.** PINs are validated by ERPNext SSO during online login. The bcrypt hash cached on the POS device for offline unlock is a POS-local concern. | Gateway Postgres, Gateway logs, Gateway memory (beyond the login request lifecycle) |
| Refresh token plaintext | **Never stored.** Only the SHA-256 hash (`token_hash`) is persisted in `refresh_tokens`. The plaintext is returned to the POS device once at issuance and never retained by the Gateway. | Gateway Postgres, Gateway logs |

### 8.5.3 Hashing Standards

| Data | Algorithm | Parameters | Rationale |
|------|-----------|-----------|-----------|
| Refresh tokens | **SHA-256** | Single-pass hash of the opaque token string | Refresh tokens are high-entropy random UUIDs. SHA-256 is computationally efficient for lookup on every request and provides sufficient collision resistance for high-entropy inputs. Bcrypt's slow hashing would create unacceptable latency on the token refresh hot path. |
| Offline PIN (POS-local) | **Bcrypt** | Cost factor 10 (minimum) | PINs are low-entropy (4–6 digits). Bcrypt's intentional slowness resists brute-force guessing on a stolen device. Cost factor 10 balances security against the computational constraints of Sunmi Android hardware. This hash is stored on the POS device, not in the Gateway. |
| Mock user PINs (fixtures) | **Bcrypt** | Cost factor 10 | Mock mode uses the same bcrypt hashing as production to ensure realistic behaviour during Phase 0 testing. |

---

## 8.6 Authentication Security Controls

### 8.6.1 Login Rate Limiting

| Scope | Limit | Action on Exceed |
|-------|-------|-----------------|
| Per phone number | 5 attempts / minute | `429 Too Many Requests` with `Retry-After: 60`. Prevents PIN brute-force against a specific account. |
| Per IP address | 20 attempts / minute | `429 Too Many Requests`. Prevents distributed brute-force from a single network location. |
| Per device_id | 10 attempts / minute | `429 Too Many Requests`. Prevents automated attack scripts running on a compromised device. |

### 8.6.2 Offline PIN Lockout

| Control | Specification |
|---------|--------------|
| Max consecutive failed attempts | 5 |
| Lockout behaviour | POS device displays "Device locked. Connect to the internet and log in again." All offline POS operations are suspended until online re-authentication succeeds. |
| Lockout recovery | Online login via `POST /auth/login` — full credential verification via ERPNext SSO. The Gateway re-provisions the session and resets the local failed attempt counter. |
| Failed attempt persistence | Counter stored in POS device secure storage (Drift). Survives app restart. Cleared only on successful online authentication. |

### 8.6.3 Device Binding

| Control | Enforcement Layer |
|---------|------------------|
| `device_id` in JWT claims | Every Edge JWT embeds the `device_id`. The Gateway validates that the `device_id` in API request payloads matches the `device_id` in the JWT. Mismatch → `403 DEVICE_MISMATCH`. |
| `device_id` in `active_devices` | The `active_devices` table binds each `msme_id` to exactly one `device_id`. A different device attempting to authenticate for the same MSME is rejected with `409 DEVICE_CONFLICT`. |
| Token-device binding | Refresh tokens in the `refresh_tokens` table are scoped to `device_id`. A token obtained on Device A cannot be used on Device B — the Gateway validates `device_id` during token refresh. |

---

## 8.7 API Security

### 8.7.1 Input Validation

| Layer | Mechanism | Scope |
|-------|-----------|-------|
| **Schema validation** | Zod discriminated unions (Section 5.6) | Every field in every action payload is type-checked, range-checked, and enum-validated before entering the sync queue |
| **Math validation** | Arithmetic cross-checks (Section 4.9) | `CREATE_SALE` payloads are verified for internal consistency — discount application order, tax computation, totals |
| **JWT claim validation** | Middleware | Every authenticated endpoint validates `sub`, `role`, `msme_id`, `device_id`, `exp`, and `iss` from the JWT. Missing or invalid claims → `401`. |
| **Payload-token cross-validation** | Middleware | `device_id` and `msme_id` in the request body must match the JWT claims. Prevents a compromised device from submitting data for a different MSME. |

### 8.7.2 Injection Prevention

| Attack Vector | Mitigation |
|---------------|-----------|
| **SQL injection** | Parameterised queries exclusively. The Gateway uses a query builder or ORM with prepared statements. No string concatenation in SQL. |
| **JSONB injection** | Sync payloads are validated by Zod schemas before insertion. The `payload` column is typed as `JSONB` — Postgres parses and validates JSON structure on insertion. |
| **NoSQL injection** | Not applicable — the Gateway uses Postgres exclusively. No document stores. |
| **Header injection** | HTTP response headers are set programmatically. User-supplied values are never interpolated into headers. |
| **Log injection** | Structured JSON logging. All user-supplied values are serialised as JSON string values, preventing newline injection or log forging. |

### 8.7.3 Response Security Headers

| Header | Value | Purpose |
|--------|-------|---------|
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` | Enforce HTTPS for all subsequent requests |
| `X-Content-Type-Options` | `nosniff` | Prevent MIME type sniffing |
| `X-Frame-Options` | `DENY` | Prevent clickjacking (relevant if any Gateway endpoint returns HTML) |
| `Content-Security-Policy` | `default-src 'none'` | No content loading — Gateway is API-only |
| `Cache-Control` | `no-store` | Prevent caching of API responses containing sensitive data |

---

## 8.8 Auditability — The Evidence Chain

### 8.8.1 The Traceability Guarantee

Every business action recorded by an MSME trader at Makola Market carries a set of identifiers that, taken together, create an **immutable, tamper-evident evidence chain** suitable for GRA compliance audits under the Revenue Administration Act 2016 (Act 915).

| Identifier | Origin | Immutable | Purpose |
|------------|--------|-----------|---------|
| `client_ref` (UUID v4) | Generated on POS device at action creation | Yes — never changes across retries or resubmissions | Uniquely identifies this specific business action across POS, Gateway, and ERPNext. The idempotency key. |
| `device_id` | Sunmi device serial number | Yes — hardware-bound | Identifies the physical device on which the action was recorded. Links the digital record to a specific piece of market-deployed hardware. |
| `recorded_at` (TIMESTAMPTZ) | POS device clock at time of action | Yes — business timestamp, not sync timestamp | Establishes when the business event occurred, not when it was transmitted. Critical for tax version validation and chronological ordering. |
| `tax_rate_version` (INTEGER) | `cached_tax_rates.version_id` at time of computation | Yes — frozen at computation time | Links the tax computation to the exact GRA Modified Tax System rates that were active when the sale was recorded. Proves the trader was not charged incorrect tax. |
| `msme_id` (UUID) | ERPNext MSME profile | Yes — assigned at registration | Identifies the MSME business entity. Linked to Ghana Card and TIN in ERPNext. |
| `user_id` (UUID) | ERPNext user record, embedded in JWT `sub` | Yes — assigned at account creation | Identifies the human operator who performed the action. |
| `batch_ref` (UUID v4) | Generated on POS device per sync batch | Yes | Groups actions that were transmitted together. Useful for identifying sync timing and batch integrity. |
| `erpnext_ref` (VARCHAR) | Returned by ERPNext on successful creation | Yes — assigned by ERPNext | The ERPNext document reference (e.g., `SI-2026-00042`). Closes the evidence chain by linking the Gateway queue entry to the system of record. |

### 8.8.2 Evidence Chain Flow

```
MSME trader records a sale at Makola Market (09:15 WAT)
  │
  ├── POS generates: client_ref = "a1b2c3d4-..."
  │                  recorded_at = "2026-03-28T09:15:32Z"
  │                  tax_rate_version = 42
  │                  device_id = "SUNMI-V3P-SN-20260101-0042"
  │
  ├── POS prints receipt with client_ref and tax breakdown
  │   (paper evidence — trader retains)
  │
  ├── POS stores action in local SQLite outbox
  │   (device evidence — survives device restart)
  │
  ├── POS syncs at end of day → Gateway receives batch
  │
  ├── Gateway validates, deduplicates, persists to sync_queue_logs
  │   (queue evidence — client_ref UNIQUE, payload JSONB immutable)
  │
  ├── Gateway forwards to ERPNext → receives erpnext_ref = "SI-2026-00042"
  │
  └── ERPNext stores Sales Invoice SI-2026-00042
      (system of record — authoritative, GRA-auditable)
```

**At every point in this chain, the `client_ref` is the common thread.** A GRA auditor can start with any link — the paper receipt, the POS device, the Gateway queue log, or the ERPNext record — and trace the action through the entire pipeline using `client_ref`.

### 8.8.3 Tamper Evidence

| Tampering Scenario | Detection Mechanism |
|-------------------|---------------------|
| Action payload modified after Gateway receipt | The `payload` JSONB column in `sync_queue_logs` is write-once. The Gateway application never issues `UPDATE` on the `payload` column. Any modification would require direct database access, which is restricted to the Gateway's application role (no interactive SQL access in production). |
| `client_ref` collision (attacker submits a different action with the same UUID) | The UNIQUE constraint on `client_ref` rejects the insert. The original action's payload is preserved. |
| Tax rates retroactively altered | Historical `cached_tax_rates` versions are retained. The `tax_rate_version` in the sync payload is validated against the historical cache — not the current rates. Any discrepancy between the recorded version and the rate at `recorded_at` time is flagged with `TAX_VERSION_MISMATCH`. |
| Device spoofing (attacker claims a different `device_id`) | The `device_id` is embedded in the Edge JWT and signed with the Gateway's RS256 private key. Altering `device_id` in the request payload without a matching JWT claim results in `403 DEVICE_MISMATCH`. Forging the JWT requires the private key. |
| Replay attack (resubmitting a captured sync batch) | `client_ref` idempotency check returns the original result. No duplicate records are created. The replayed batch is harmless. |

### 8.8.4 GRA Audit Access

GRA Officers access audit data through the **GRA Console** (React/Vue Web Portal → ERPNext direct). They do not access the Gateway database directly. The evidence chain is exposed through ERPNext's reporting and export capabilities:

| GRA Audit Capability | Data Source | Format |
|---------------------|-------------|--------|
| View MSME tax submission history | ERPNext Sales Invoices (linked by `client_ref`) | Web dashboard + CSV/PDF export |
| Verify tax computation against rate version | ERPNext Sales Invoice (contains `tax_rate_version`) cross-referenced with ERPNext tax configuration history | Web dashboard |
| Trace action from receipt to system of record | ERPNext Sales Invoice → `client_ref` → Gateway `sync_queue_logs` (if needed for dispute resolution) | Internal investigation; Gateway access requires `admin` role |
| Export programme-level compliance reports | ERPNext aggregate reporting across all enrolled MSMEs | CSV, PDF |

---

## 8.9 Infrastructure Security

### 8.9.1 Network Segmentation

| Zone | Components | Access Policy |
|------|-----------|---------------|
| **Public** | Gateway API endpoints (`/auth/*`, `/sync/*`, `/tax-rates`, `/health`) | Accessible from POS devices over TLS. Rate-limited. |
| **Internal** | Gateway admin endpoints (`/admin/*`) | Accessible only from the internal network or VPN. Not exposed to POS devices. |
| **Database** | Postgres 16 instance | Accessible only from the Gateway application server. No public exposure. Firewall restricts to Gateway IP(s) only. |
| **ERPNext** | ERPNext instance | Accessible from the Gateway (for API forwarding) and from the Web Portal (for direct API access). Not accessible from POS devices directly. |

### 8.9.2 Dependency Security

| Measure | Implementation |
|---------|---------------|
| Node.js 24 LTS | Use only the LTS release channel. Apply security patches within 7 days of release. |
| npm dependency audit | `npm audit` runs in CI/CD pipeline. Builds with known high/critical vulnerabilities are blocked. |
| Container hardening | If containerised: non-root user, read-only filesystem (except for temp/log directories), no privileged capabilities. |
| Secret rotation | JWT signing keys rotated annually. ERPNext API credentials rotated quarterly. Postgres credentials rotated quarterly. All rotations are zero-downtime via environment variable reload or rolling deployment. |

### 8.9.3 Logging & Log Security

| Requirement | Implementation |
|-------------|---------------|
| Structured format | All logs emitted as JSON objects with `timestamp`, `level`, `service`, `event`, and contextual fields |
| No PII in logs | MSME names, phone numbers, Ghana Card numbers, and TINs are **never** logged. Only UUIDs (`msme_id`, `user_id`, `client_ref`) appear in logs. |
| No secrets in logs | JWTs, refresh tokens, API keys, and Postgres credentials are never logged. Token values are replaced with `[REDACTED]` in log output. |
| Log retention | 90 days minimum (aligns with `sync_queue_logs` retention). Configurable based on infrastructure policy. |
| Log integrity | Logs are shipped to a centralised, append-only log aggregation service (e.g., ELK, CloudWatch Logs, Grafana Loki). Application-level log deletion is not possible. |

---

## 8.10 Security Compliance Summary

| Domain | Control | Standard |
|--------|---------|----------|
| **Legislative** | MSME data handling | Data Protection Act 2012 (Act 843) |
| **Legislative** | Electronic record validity | Electronic Transactions Act 2008 (Act 772) |
| **Legislative** | Tax compliance auditability | Revenue Administration Act 2016 (Act 915) |
| **Transport** | POS ↔ Gateway | TLS 1.2+ with forward-secrecy cipher suites |
| **Transport** | Gateway ↔ ERPNext | TLS 1.2+ with certificate validation |
| **Transport** | Gateway ↔ Postgres | TLS 1.2+ or Unix socket (co-located) |
| **Authentication** | Edge JWT signing | RS256 (RSA 2048-bit minimum) |
| **Authentication** | Access token TTL | 15 minutes |
| **Authentication** | Refresh token storage | SHA-256 hash only; plaintext never stored |
| **Authentication** | Offline PIN storage | Bcrypt cost factor 10 (POS-local) |
| **Authentication** | Token rotation | Mandatory rotation; family revocation on reuse |
| **Authentication** | Login rate limiting | 5 attempts/min per phone; 20/min per IP |
| **Device** | Single Active Device | `active_devices` PK on `msme_id` |
| **Device** | Device binding | `device_id` in JWT claims + request validation |
| **Device** | Offline PIN lockout | 5 failed attempts → device lock |
| **Data** | Encryption at rest | AES-256 volume encryption (Postgres data directory) |
| **Data** | No PII in logs | UUIDs only; names/phones/IDs never logged |
| **Data** | Payload immutability | `sync_queue_logs.payload` is write-once JSONB |
| **Audit** | Evidence chain | `client_ref` → `device_id` → `tax_rate_version` → `erpnext_ref` |
| **Audit** | Tamper detection | UNIQUE `client_ref`, RS256 JWT signatures, version validation |
| **Infrastructure** | Network segmentation | Public API / Internal admin / Database zones |
| **Infrastructure** | Dependency management | npm audit in CI/CD; patch within 7 days |

---

*End of Section 8 — Security & Infrastructure Compliance*

---

# End of Document

**TriLiska POS Gateway — Master System Architecture & PRD**

| Section | Title | File |
|---------|-------|------|
| 1 | Executive Summary & Architecture Vision | `docs/01_Executive_Summary.md` |
| 2 | System Actors & Authentication Flow | `docs/02_System_Actors_Auth.md` |
| 3 | POS Gateway Responsibilities & Edge Logic | `docs/03_Gateway_Responsibilities.md` |
| 4 | Offline Sync Strategy & Queue Management | `docs/04_Offline_Sync_Queue.md` |
| 5 | API Contracts & Phase 0 Mocking Strategy | `docs/05_API_Contracts_Mocking.md` |
| 6 | Gateway Database Schema | `docs/06_Gateway_Database_Schema.md` |
| 7 | Error Handling, Dead Letter Queues & Retry Mechanisms | `docs/07_Error_Handling_DLQ.md` |
| 8 | Security & Infrastructure Compliance | `docs/08_Security_Compliance.md` |

**Prepared by:** Trident Aliska Digital Tech Ghana LTD
**Programme:** GRA MSME Tax & Business Management Programme
**Classification:** Enterprise — Restricted Distribution
**Date:** March 2026
