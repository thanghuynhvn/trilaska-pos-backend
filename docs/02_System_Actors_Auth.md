# Section 2: System Actors & Authentication Flow

**Document:** TriLiska POS Gateway — Master System Architecture & PRD
**Section:** 02 — System Actors & Authentication Flow (Edge JWTs & ERPNext SSO)
**Prepared by:** Trident Aliska Digital Tech Ghana LTD
**Programme:** GRA MSME Tax & Business Management Programme
**Sprint Focus:** POS Backend Gateway (Node.js 24 / Postgres 16)
**Date:** March 2026
**Classification:** Enterprise — Restricted Distribution

---

## 2.1 Overview

The TriLiska hybrid architecture splits authentication across two boundaries:

1. **ERPNext Master SSO** — the single source of truth for user identity, role assignment, and credential management across the entire ecosystem.
2. **POS Gateway Edge JWTs** — short-lived, device-scoped tokens issued by the Node.js Gateway for Flutter POS sessions, validated locally at the Gateway without requiring a round-trip to ERPNext on every request.

The React/Vue Web Portal (GRA Console, Programme Staff Portal, MSME Tax Portal) **bypasses the Gateway entirely** and authenticates directly against ERPNext SSO. This section therefore focuses on the actors that interact with the POS Gateway and the edge authentication flow that governs POS device sessions.

---

## 2.2 System Actors

TriLiska serves a structurally diverse user base ranging from semi-literate market traders at Makola Market to Ghana Revenue Authority compliance officials operating under the Revenue Administration Act 2016 (Act 915). Each role is bound to specific interface layers and precisely scoped data access permissions.

### 2.2.1 Full Role Matrix

| Role | Technical Key | Primary Interface | Auth Boundary | Data Scope | MFA Required |
|------|--------------|-------------------|---------------|------------|--------------|
| MSME Owner | `msme_owner` | Flutter POS (Sunmi V3 PLUS / V2 PRO) | **POS Gateway (Edge JWT)** | Own MSME only | No (PIN-based) |
| Programme Staff / SME Agent | `programme_staff` | Web Portal + Sunmi device | **ERPNext SSO** (Portal) / **Edge JWT** (Sunmi) | All MSMEs in assigned zone/district | Yes |
| District Officer | `district_officer` | Web Portal (React/Vue) | **ERPNext SSO** (direct) | All MSMEs in assigned district | Yes |
| GRA Officer | `gra_officer` | GRA Console (React/Vue — read-only) | **ERPNext SSO** (direct) | All registered MSMEs (read-only) | Yes |
| System Administrator | `admin` | Web Portal (React/Vue — full access) | **ERPNext SSO** (direct) | Entire system | Yes (Hardware token) |

### 2.2.2 Gateway-Relevant Actors

Only two roles interact with the POS Gateway:

| Role | Gateway Interaction |
|------|---------------------|
| `msme_owner` | Authenticates via Gateway → ERPNext SSO delegation; receives Edge JWT; syncs finalized transactions through Gateway |
| `programme_staff` | Authenticates via Gateway → ERPNext SSO delegation when using Sunmi device in the field; receives Edge JWT; may sync transactions on behalf of traders |

All other roles (`district_officer`, `gra_officer`, `admin`) interact exclusively with ERPNext via the React/Vue Web Portal. The Gateway has no authentication or API surface for these roles.

---

## 2.3 Detailed Persona Cards

### 2.3.1 MSME Owner (`msme_owner`)

**Who They Are**
A micro or small business trader operating at Makola Market or within the Accra CBD. Typical profiles include food retail vendors, general goods sellers, and service providers registered under the TriLiska pilot programme with a unique `programme_ref` (format: `TRL-{DISTRICT}-{SEQ}`, e.g., `TRL-ACC-0042`). Business structures range from sole proprietorships to informal partnerships.

**Primary Goals**
- Record daily sales and expenses quickly during peak trading hours
- Track Susu contributions and informal loan obligations
- Manage inventory with minimal administrative overhead
- Remain compliant with GRA reporting requirements without needing to understand tax mechanics directly

**Pain Points**
- Limited formal literacy or prior exposure to digital financial tools
- Inconsistent network connectivity at market locations
- Time pressure during high-volume trading periods
- Anxiety about GRA compliance and potential penalties

**Interface**
Flutter 3.41.5 POS application on Sunmi V3 PLUS (58mm thermal printer) or Sunmi V2 PRO (80mm printer, integrated barcode scanner). The application operates in offline-first mode (SQLite/Drift) with background batch sync via the POS Gateway. UI must conform to minimum 56dp tap targets, 16sp body text, and colour-plus-icon status indicators (never colour alone). Phase 1 language: English only. Twi, Ga, Ewe, Hausa, and Dagbani added in Phase 2.

**Gateway Permissions**

| Action | Permitted |
|--------|-----------|
| Authenticate (PIN → Edge JWT) | Yes |
| Sync sales transactions | Yes (own MSME only) |
| Sync expense entries | Yes (own MSME only) |
| Sync Susu contributions | Yes (own MSME only) |
| Sync loan repayments | Yes (own MSME only) |
| Fetch cached tax rates | Yes |
| Void transactions | **No** — must raise with Programme Staff |
| Modify `vat_status` / tax regime | **No** |

---

### 2.3.2 Programme Staff / SME Agent (`programme_staff`)

**Who They Are**
National Service Personnel (NSP) and Youth Employment Agency (YEA) field officers deployed to specific zones or districts under the GRA Modified Tax programme. They serve as the operational link between informal traders and the TriLiska compliance infrastructure — conducting onboarding visits, verifying Ghana Card data, and ensuring submissions are accurate.

**Primary Goals**
- Onboard new MSMEs and validate Ghana Card and TIN data at point of registration (via ERPNext)
- Assist traders with correct sales entry and expense categorisation (via Sunmi device)
- Review and void erroneous sales records within their assigned zone (via Web Portal → ERPNext)
- Escalate tax regime threshold alerts (GHS 500,000 and GHS 750,000 flags) to District Officers

**Dual Interface — Dual Auth**
Programme Staff are the only role that spans both authentication boundaries:

| Context | Interface | Auth Boundary |
|---------|-----------|---------------|
| Field work (market visits) | Sunmi device / Flutter POS | POS Gateway Edge JWT |
| Office / remote work | React/Vue Web Portal | ERPNext SSO (direct) |

**Gateway Permissions (Sunmi device context only)**

| Action | Permitted |
|--------|-----------|
| Authenticate (credentials → Edge JWT) | Yes |
| Sync sales transactions on behalf of traders | Yes (assigned zone only) |
| Fetch cached tax rates | Yes |
| Void transactions | **No** (void only via Web Portal → ERPNext) |
| MSME registration | **No** (registration only via Web Portal → ERPNext) |

---

### 2.3.3 District Officer (`district_officer`)

**Who They Are**
Zonal Heads responsible for oversight of multiple Programme Staff zones within a district. Supervisory and analytical role — reviews programme health, monitors threshold alerts, escalates compliance issues.

**Gateway Interaction:** None. Operates exclusively via React/Vue Web Portal → ERPNext SSO.

**ERPNext Permissions**
- Read: All MSME profiles, transactions, and submission statuses within assigned district
- Create: None
- Void: None

---

### 2.3.4 GRA Officer (`gra_officer`)

**Who They Are**
Officials of the Ghana Revenue Authority with a mandate to audit and review MSME tax compliance records. Access governed by the Revenue Administration Act 2016 (Act 915).

**Gateway Interaction:** None. Operates exclusively via GRA Console (React/Vue) → ERPNext SSO.

**ERPNext Permissions**
- View: Registered MSMEs, submitted tax reports, submission statuses, payment records, full audit trails
- Export: Programme reports (CSV, PDF)
- **ABSOLUTE RULE:** GRA Officers do not modify MSME data under any circumstances. This constraint is enforced at the ERPNext API layer and is not overridable by application configuration or administrator action.

---

### 2.3.5 System Administrator (`admin`)

**Who They Are**
Internal Trident Aliska Digital Tech operational staff responsible for platform health, user lifecycle management, and pilot reporting. Does not configure tax calculation rules — those are policy-locked within the ERPNext GRA tax configuration and governed by GRA.

**Gateway Interaction:** None for day-to-day operations. May access Gateway infrastructure (Postgres, logs) for operational monitoring and incident response, but not through the Gateway API surface.

**ERPNext Permissions**
- Create: All record types
- Void: All record types (immutably audit-logged)
- Configure: User roles, system settings (not tax calculation rules)
- Hardware token MFA required

---

## 2.4 Authentication Flow — Edge JWTs & ERPNext SSO

### 2.4.1 Design Principles

| Principle | Implementation |
|-----------|---------------|
| **ERPNext is the single identity authority** | The Gateway never stores passwords or manages user lifecycle. All credential verification is delegated to ERPNext SSO. |
| **Edge tokens are short-lived and device-scoped** | Access tokens issued by the Gateway expire quickly, minimizing the window of compromise if a Sunmi device is lost or stolen. |
| **Refresh tokens are Gateway-managed** | Stored in the Gateway's Postgres `refresh_tokens` table, enabling session revocation without ERPNext involvement for routine rotation. |
| **Offline operation does not require re-authentication** | Once a valid Edge JWT is obtained, the POS app can operate offline indefinitely. Transaction sync requires a valid token, but local operation does not. **However, "offline login" is strictly limited to unlocking a previously authenticated local session using a PIN — see Section 2.4.8.** |
| **Role and scope embedded in JWT claims** | The Edge JWT carries the user's role, MSME scope (`msme_id`), and zone/district scope, allowing the Gateway to enforce authorization locally without ERPNext round-trips. |
| **Single Active Device per MSME** | The Gateway enforces a strict one-device-per-MSME constraint. A second device attempting to log in for the same MSME is blocked with `409 DEVICE_CONFLICT`. This prevents split-brain offline conflicts — see Section 2.4.9. |

### 2.4.2 Login Flow — POS Device (MSME Owner)

This flow requires **online connectivity**. A user cannot perform a first-time login on a device without network access (see Section 2.4.8 for offline unlock constraints).

```
┌──────────────┐     ┌───────────────────┐     ┌──────────────┐
│  Flutter POS  │     │  Node.js Gateway   │     │   ERPNext    │
│  (Sunmi)      │     │  (POS Backend)     │     │   (Master)   │
└──────┬───────┘     └────────┬──────────┘     └──────┬───────┘
       │                      │                       │
       │  1. POST /auth/login │                       │
       │  { phone, pin,       │                       │
       │    device_id }       │                       │
       │─────────────────────▶│                       │
       │                      │                       │
       │                      │  2. Validate credentials│
       │                      │  via ERPNext SSO API   │
       │                      │──────────────────────▶│
       │                      │                       │
       │                      │  3. Return user record │
       │                      │  { user_id, role,     │
       │                      │    msme_id, zone }    │
       │                      │◀──────────────────────│
       │                      │                       │
       │                      │  4. CHECK active_devices│
       │                      │  for msme_id:          │
       │                      │  - If no active device:│
       │                      │    register this device│
       │                      │  - If same device_id:  │
       │                      │    proceed (re-login)  │
       │                      │  - If DIFFERENT device: │
       │                      │    REJECT 409          │
       │                      │    DEVICE_CONFLICT     │
       │                      │                       │
       │                      │  5. Generate Edge JWT  │
       │                      │  + Refresh Token       │
       │                      │  Store refresh_token   │
       │                      │  in Postgres           │
       │                      │  Register device_id in │
       │                      │  active_devices        │
       │                      │                       │
       │  6. Return tokens    │                       │
       │  { access_token,     │                       │
       │    refresh_token,    │                       │
       │    expires_in }      │                       │
       │◀─────────────────────│                       │
       │                      │                       │
       │  7. Store tokens +   │                       │
       │  user profile locally│                       │
       │  in Drift (secure    │                       │
       │  storage) for offline│                       │
       │  unlock capability   │                       │
```

### 2.4.3 Token Refresh Flow

```
┌──────────────┐     ┌───────────────────┐
│  Flutter POS  │     │  Node.js Gateway   │
└──────┬───────┘     └────────┬──────────┘
       │                      │
       │  1. POST /auth/refresh│
       │  { refresh_token }   │
       │─────────────────────▶│
       │                      │
       │                      │  2. Validate refresh_token
       │                      │  against Postgres
       │                      │  refresh_tokens table
       │                      │
       │                      │  3. If valid:
       │                      │  - Rotate refresh_token
       │                      │  - Issue new access_token
       │                      │  - Invalidate old refresh
       │                      │
       │  4. Return new tokens│
       │  { access_token,     │
       │    refresh_token,    │
       │    expires_in }      │
       │◀─────────────────────│
```

**Token refresh does NOT require an ERPNext round-trip** for routine rotation. The Gateway validates the refresh token against its own Postgres store. ERPNext is only consulted during initial login and periodic re-validation (e.g., when a refresh token family reaches its maximum rotation count or when the Gateway needs to confirm the user has not been deactivated).

### 2.4.4 Token Specification

| Token | Type | Lifetime | Storage | Revocation |
|-------|------|----------|---------|------------|
| Access Token | JWT (signed, not encrypted) | 15 minutes | POS app secure storage (Drift) | Short-lived; expires naturally |
| Refresh Token | Opaque token (UUID v4) | 7 days | Gateway Postgres `refresh_tokens` table | Explicit revocation via `DELETE` on `refresh_tokens`; automatic revocation on rotation |

### 2.4.5 Edge JWT Claims

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

| Claim | Purpose |
|-------|---------|
| `sub` | User identifier (maps to ERPNext user record) |
| `role` | Authorization role (`msme_owner` or `programme_staff`) |
| `msme_id` | MSME scope — restricts data access to this MSME only (null for `programme_staff`) |
| `zone` | Zone scope for `programme_staff`; enforced on sync operations |
| `district` | District scope; used for aggregate authorization checks |
| `device_id` | Sunmi device serial; enables per-device session tracking and revocation |
| `iss` | Issuer — `triliska-gateway` distinguishes Edge JWTs from ERPNext SSO tokens |

### 2.4.6 Session Revocation

The Gateway supports four revocation scenarios:

| Scenario | Mechanism | Latency |
|----------|-----------|---------|
| **Device lost/stolen** | Admin revokes all refresh tokens for `device_id` via Gateway admin endpoint AND deletes the `active_devices` row for the MSME, freeing the slot for a replacement device | Immediate for new requests; existing access tokens expire within 15 min |
| **User deactivated in ERPNext** | Gateway periodic sync checks user status; revokes all refresh tokens for `sub` and deletes associated `active_devices` row | Up to sync interval (configurable, default 5 min) |
| **Refresh token compromise** | Rotation detection — if a previously rotated refresh token is reused, the entire token family is revoked | Immediate |
| **Device transfer (non-emergency)** | Programme Staff or admin initiates a device transfer; Gateway atomically replaces `active_devices` row and revokes refresh tokens for the old `device_id` | Immediate |

### 2.4.8 Offline Login Constraints

"Offline login" in the TriLiska POS is **not a true login**. It is the **unlocking of a previously authenticated local session** using a locally cached PIN hash. This distinction is critical and non-negotiable.

#### What "Offline Login" Actually Is

When a user successfully authenticates online (via the flow in Section 2.4.2), the Flutter POS stores the following in secure local storage (Drift):

| Cached Data | Purpose |
|-------------|---------|
| User profile (`user_id`, `role`, `msme_id`, `zone`, `district`) | Populate JWT-equivalent local authorization context |
| PIN hash (bcrypt) | Validate offline PIN entry without network access |
| Last valid Edge JWT + refresh token | Resume sync operations when connectivity returns |
| Cached tax rates | Enable offline tax computation |

When the device is locked or the app is restarted while offline, the user enters their PIN. The POS validates the PIN against the locally cached hash and unlocks the existing session. **No new tokens are issued. No Gateway communication occurs. No ERPNext validation occurs.**

#### Strictly Online-Only Operations

The following operations **require live network connectivity** and **cannot be performed offline under any circumstances**:

| Operation | Reason |
|-----------|--------|
| **First-time login on a device** | The Gateway must validate credentials via ERPNext SSO, check the Single Active Device constraint, register the device in `active_devices`, and issue Edge JWTs. None of this can occur without connectivity. |
| **Password / PIN reset** | Credential changes are mastered in ERPNext SSO. The POS cannot modify credentials locally. |
| **User account creation** | User lifecycle is managed exclusively in ERPNext. |
| **Device transfer** | Changing the active device for an MSME requires the Gateway to deregister the old device and register the new one in `active_devices`. |
| **First sync after prolonged offline period** | If the cached refresh token has expired (>7 days offline), the user must re-authenticate online before sync can resume. Local POS operation continues, but the outbox cannot be transmitted. |

#### Offline Unlock Flow

```
┌──────────────┐
│  Flutter POS  │
│  (Offline)    │
└──────┬───────┘
       │
       │  1. User enters PIN on lock screen
       │
       │  2. POS checks: has this device EVER
       │  authenticated online for this user?
       │  (checks for cached user profile in Drift)
       │
       │  3. If NO cached profile exists:
       │     → Display "Internet connection required
       │       for first-time login"
       │     → BLOCK. No offline access.
       │
       │  4. If cached profile EXISTS:
       │     → Validate PIN against cached bcrypt hash
       │     → If PIN matches: unlock session,
       │       resume offline POS operations
       │     → If PIN fails: increment attempt counter,
       │       lock after 5 failed attempts
       │       (requires online re-authentication)
```

---

### 2.4.9 Device Hijacking Prevention — Single Active Device Enforcement

The Gateway enforces that **at most one Sunmi POS device may be active for any given MSME at any point in time**. This is the authentication-layer enforcement of the Single Active Device Rule described in Section 1.7.3.

#### Why This Exists

Without device-level exclusivity, the following attack and error scenarios become possible:

| Threat | Description |
|--------|-------------|
| **Split-brain offline sync** | Two devices record conflicting business operations for the same MSME while offline; sync produces irreconcilable action histories |
| **Device theft with continued use** | A stolen device continues to operate for the MSME while the owner activates a replacement; two parallel business records diverge |
| **Accidental dual activation** | A Programme Staff member sets up a new device for a trader without deactivating the old one; both record sales independently |

#### Enforcement Mechanism

The Gateway maintains an `active_devices` table in Postgres:

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `msme_id` | UUID | PK | One row per MSME — enforces single device at the schema level |
| `device_id` | VARCHAR(128) | NOT NULL | The Sunmi device serial currently authorised for POS operations |
| `user_id` | UUID | NOT NULL | The user who activated this device |
| `activated_at` | TIMESTAMPTZ | NOT NULL, DEFAULT now() | When this device was registered as active |
| `last_seen_at` | TIMESTAMPTZ | NOT NULL | Updated on each successful API interaction (login, sync, refresh) |

**The `msme_id` is the primary key.** This means the table physically cannot contain two rows for the same MSME. There is no application-level "soft" enforcement that can be bypassed — the constraint is structural.

#### Login Decision Matrix

| Current `active_devices` State | Incoming Login `device_id` | Result |
|-------------------------------|---------------------------|--------|
| No row for `msme_id` | Any device | **ALLOW** — insert new row, register device as active |
| Row exists, `device_id` matches | Same device | **ALLOW** — update `last_seen_at`, proceed with re-login |
| Row exists, `device_id` differs | Different device | **REJECT** — return `409 DEVICE_CONFLICT` with error body: `{ "error": "DEVICE_CONFLICT", "active_device_id": "<masked>", "message": "Another device is currently active for this MSME. Contact your Programme Staff to transfer devices." }` |

#### Device Transfer Procedures

| Procedure | Actor | Steps |
|-----------|-------|-------|
| **Normal logout** | `msme_owner` | MSME owner logs out on active device → POS calls `POST /auth/logout` → Gateway deletes `active_devices` row for `msme_id` → new device can now authenticate |
| **Staff-initiated transfer** | `programme_staff` | Via Web Portal → ERPNext API → Gateway admin endpoint `POST /admin/devices/transfer` with `{ msme_id, new_device_id }` → Gateway atomically replaces `active_devices` row |
| **Admin emergency revocation** | `admin` | Via Gateway admin endpoint `DELETE /admin/devices/{msme_id}` → Gateway deletes `active_devices` row and revokes all refresh tokens for the old `device_id` |
| **Automatic expiry** | System | If `last_seen_at` exceeds a configurable threshold (default: 30 days), a background job deregisters the device — accommodating scenarios where a device is permanently lost without explicit logout |

---

### 2.4.10 Web Portal Authentication (Non-Gateway)

For completeness, the Web Portal authentication path is documented here, but it is **outside the Gateway's scope**:

```
┌──────────────┐     ┌──────────────┐
│  React/Vue    │     │   ERPNext    │
│  Web Portal   │     │   (Master)   │
└──────┬───────┘     └──────┬───────┘
       │                    │
       │  1. Login via      │
       │  ERPNext SSO       │
       │───────────────────▶│
       │                    │
       │  2. ERPNext session│
       │  token / cookie    │
       │◀───────────────────│
       │                    │
       │  3. All subsequent │
       │  API calls direct  │
       │  to ERPNext        │
       │───────────────────▶│
```

The POS Gateway has **no role** in Web Portal authentication. The React/Vue apps authenticate directly with ERPNext SSO using ERPNext's native session management. This separation ensures that Gateway downtime does not affect Web Portal operations, and vice versa.

---

## 2.5 MSME Profile Data Model

The following fields constitute the canonical MSME record as mastered in ERPNext and exposed to the POS Gateway as read-only context during sync operations.

| Field | Key | Format / Allowed Values | Required at Registration |
|-------|-----|-------------------------|--------------------------|
| Programme Reference | `programme_ref` | `TRL-{DISTRICT}-{SEQ}` — e.g., `TRL-ACC-0042` | Yes — system-generated |
| Business Name | `business_name` | Free text string | Yes |
| Owner Name | `owner_name` | Free text string | Yes |
| Owner Phone | `owner_phone` | E.164 format | Yes |
| Owner National ID | `owner_national_id` | Ghana Card number | Yes |
| Tax Identification Number | `tin` | GRA-issued TIN | No (optional at registration) |
| Business Type | `business_type` | `sole_proprietor`, `partnership`, `company` | Yes |
| Sector | `sector` | `retail_food`, `retail_general`, `services`, `manufacturing`, `agriculture`, `transport`, `hospitality`, `other` | Yes |
| VAT Status | `vat_status` | `not_registered`, `flat_rate`, `standard` | Yes |
| Annual Turnover Band | `annual_turnover_band` | `below_200k`, `200k_to_500k`, `above_500k` | Yes |
| Market GPS Coordinates | `gps_lat` / `gps_lng` | Decimal (10,7) | Yes |
| District | `district` | Standardised district name | Yes |
| Zone | `zone` | Assigned programme zone within district | No |
| Preferred Language | `preferred_language` | `en`, `tw`, `ga`, `ee`, `ha`, `dag` | Yes (default: `en`) |
| Profile Status | `status` | `active`, `inactive`, `suspended` | Yes — system-managed |

**Gateway Note:** The MSME profile is mastered in ERPNext. The Gateway does not store or cache MSME profiles. Profile data relevant to JWT claims (`msme_id`, `zone`, `district`) is obtained during the login flow via ERPNext SSO delegation.

---

## 2.6 Tax Regime × Role Interaction

| Role | View Current Tax Status | Initiate Status Change | Change Requires Audit Log | Can Override Threshold Flag |
|------|------------------------|------------------------|---------------------------|----------------------------|
| `msme_owner` | Yes (own record only) | No | N/A | No |
| `programme_staff` | Yes (zone scope) | **Yes** (via ERPNext) | **Yes — immutable** | No |
| `district_officer` | Yes (district scope) | No | N/A | No |
| `gra_officer` | Yes (full read-only) | No | N/A | No |
| `admin` | Yes (full) | **Yes** (via ERPNext) | **Yes — immutable** | No |

### Tax Regime Reference

| Regime | `vat_status` | Turnover Threshold | Effective Tax Treatment |
|--------|-------------|-------------------|------------------------|
| Unregistered | `not_registered` | Below GHS 200,000 | 0% — no VAT obligation |
| Modified Tax / Flat Rate VAT (VFRS) | `flat_rate` | GHS 200,000 – GHS 500,000 | 3% applied to gross sales |
| Standard Rate | `standard` | Above GHS 500,000 | VAT 15% + NHIL 2.5% + GETFund 2.5% + COVID Levy 1% |

**Threshold Behaviour:** The system raises advisory flags at GHS 500,000 and GHS 750,000 cumulative turnover. These are informational only — the system does **not** automatically change `vat_status`. A `programme_staff` or `admin` user must review the flag and initiate any status transition via the ERPNext Web Portal, which is then immutably written to the audit log. No role can suppress or dismiss a threshold flag without audit-logging the action.

**Gateway Role in Tax:** The Gateway caches current tax rates in `cached_tax_rates` (Postgres, read-only) for fast distribution to POS devices. It does not evaluate, modify, or enforce tax regime transitions. Tax regime management is an ERPNext-only operation.

---

## 2.7 Gateway Database Schemas

### 2.7.1 `refresh_tokens` Table

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | UUID | PK, DEFAULT gen_random_uuid() | Token record identifier |
| `user_id` | UUID | NOT NULL, INDEX | Maps to ERPNext user |
| `device_id` | VARCHAR(128) | NOT NULL, INDEX | Sunmi device serial number |
| `token_hash` | VARCHAR(256) | NOT NULL, UNIQUE | SHA-256 hash of the opaque refresh token (plaintext never stored) |
| `token_family` | UUID | NOT NULL, INDEX | Groups tokens in the same rotation chain for family revocation |
| `rotation_count` | INTEGER | NOT NULL, DEFAULT 0 | Number of times this family has been rotated |
| `expires_at` | TIMESTAMPTZ | NOT NULL, INDEX | Absolute expiry; tokens past this timestamp are invalid |
| `revoked_at` | TIMESTAMPTZ | NULLABLE | Set on explicit revocation or rotation; non-null = invalid |
| `created_at` | TIMESTAMPTZ | NOT NULL, DEFAULT now() | Record creation timestamp |

**Indexes:**
- `idx_refresh_tokens_user_id` on `user_id` — fast lookup for user-scoped revocation
- `idx_refresh_tokens_device_id` on `device_id` — fast lookup for device-scoped revocation
- `idx_refresh_tokens_token_hash` on `token_hash` — unique constraint enforces deduplication
- `idx_refresh_tokens_expires_at` on `expires_at` — supports cleanup of expired tokens

### 2.7.2 `active_devices` Table

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `msme_id` | UUID | **PK** | One row per MSME — primary key enforces single-device constraint at the schema level |
| `device_id` | VARCHAR(128) | NOT NULL | Sunmi device serial number currently authorised for POS operations |
| `user_id` | UUID | NOT NULL | The user who activated this device binding |
| `activated_at` | TIMESTAMPTZ | NOT NULL, DEFAULT now() | When this device was registered as the active POS terminal |
| `last_seen_at` | TIMESTAMPTZ | NOT NULL | Updated on each successful API interaction (login, sync, token refresh) |

**Indexes:**
- Primary key on `msme_id` — structural enforcement of one-device-per-MSME
- `idx_active_devices_device_id` on `device_id` — fast lookup for device-scoped queries and revocation

---

## 2.8 Security Constraints

| Constraint | Enforcement |
|------------|-------------|
| Refresh token plaintext is never stored | Only `token_hash` (SHA-256) is persisted in Postgres |
| Access tokens are stateless | No Gateway database lookup required; validation is cryptographic (JWT signature verification) |
| Token rotation is mandatory | Each refresh token use produces a new token; the old one is invalidated |
| Family revocation on reuse detection | If a rotated-out token is presented, the entire `token_family` is revoked — all sessions in that chain are terminated |
| Device binding | Tokens are scoped to `device_id`; a token obtained on one Sunmi device cannot be used on another |
| Single Active Device enforcement | The `active_devices` table uses `msme_id` as a primary key — the database physically cannot store two active devices for the same MSME. This is a schema-level constraint, not application logic. |
| Device conflict rejection | If a second device attempts login for an MSME with an existing active device, the Gateway returns `409 DEVICE_CONFLICT` without issuing tokens — the attempt is logged but no session is created |
| Offline login is local unlock only | "Offline login" validates a cached PIN hash on-device. No tokens are issued, no Gateway communication occurs. First-time login, PIN reset, and user creation are strictly online-only. |
| Offline PIN lockout | After 5 consecutive failed offline PIN attempts, the device locks and requires online re-authentication to unlock — prevents brute-force PIN guessing on a lost device |
| PIN-based auth for MSME Owners | MSME Owners authenticate with phone + PIN (not password). The PIN is validated by ERPNext SSO, not by the Gateway. |
| MFA for Programme Staff on Sunmi | Programme Staff authenticate with credentials + MFA code when logging into a Sunmi device via the Gateway |
| Expired token cleanup | Background job purges `refresh_tokens` where `expires_at < now()` on a configurable schedule |
| Stale device cleanup | Background job deregisters devices in `active_devices` where `last_seen_at` exceeds the configurable threshold (default: 30 days) |

---

*End of Section 2 — System Actors & Authentication Flow*
*Next: Section 3 — POS Gateway Responsibilities & Edge Logic*
