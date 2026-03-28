# Section 2: User Personas & Role Matrix

**Document:** TriLiska Master System Architecture & Product Requirements Document
**Section:** 02 — User Personas & Role Matrix
**Prepared by:** Trident Aliska Digital Tech Ghana LTD
**Programme:** GRA MSME Tax & Business Management Programme
**Date:** March 2026
**Classification:** Enterprise — Restricted Distribution

---

## 2.1 Overview

TriLiska's four-layer hybrid architecture — Odoo Business Engine, NestJS API Gateway, Flutter Mobile POS, and React/Vue Web Portal — is purpose-built to serve a structurally diverse user base ranging from semi-literate market traders at Makola Market to Ghana Revenue Authority compliance officials operating under the Revenue Administration Act 2016 (Act 915). Each role in the system is bound to a specific interface layer and a precisely scoped set of data access and mutation permissions.

The MSME Owner interacts exclusively with the offline-first Flutter POS application deployed on Sunmi Android hardware. Programme Staff (NSP and YEA field officers) operate across both the Sunmi device and the Web Portal, bridging the gap between informal traders and the compliance infrastructure. District Officers, GRA Officers, and System Administrators operate entirely within the React/Vue Web Portal, with access scopes that widen with operational authority but are independently constrained by their respective governance mandates. GRA Officers are constitutionally read-only by design — no system pathway permits them to mutate MSME records or tax submissions.

All role definitions below are normative for Phase 1 and govern access control policy enforced at the NestJS API Gateway layer. Any deviation from these definitions requires a formal change request reviewed by both the Product Owner and the Compliance Lead.

---

## 2.2 Role Matrix

| Role | Technical Key | Primary Interface | Data Scope | Create Permissions | Void Permissions | MFA Required |
|---|---|---|---|---|---|---|
| MSME Owner | `msme_owner` | Flutter POS (Sunmi V3 PLUS / V2 PRO) | Own MSME only | Sales, Expenses | None | No (PIN-based) |
| Programme Staff / SME Agent | `programme_staff` | Web Portal + Sunmi device | All MSMEs in assigned zone/district | MSMEs, Sales | Sales (own zone only) | Yes |
| District Officer | `district_officer` | Web Portal (React/Vue) | All MSMEs in assigned district | None | None | Yes |
| GRA Officer | `gra_officer` | GRA Console (React/Vue — read-only) | All registered MSMEs (read-only) | None | None | Yes |
| System Administrator | `admin` | Web Portal (React/Vue — full access) | Entire system | Everything | Everything | Yes (Hardware token) |

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
Flutter 3.x POS application on Sunmi V3 PLUS (58mm thermal printer) or Sunmi V2 PRO (80mm printer, integrated barcode scanner). The application operates in offline-first mode with background sync. UI must conform to minimum 56dp tap targets, 16sp body text, and colour-plus-icon status indicators (never colour alone). Phase 1 language support: English only. Twi, Ga, Ewe, Hausa, and Dagbani added in Phase 2.

**Key Permissions**
- Create: Sales transactions, Expense entries
- Read: Own MSME profile, own sales and expense history, own Susu scheme and loan records
- Void: None

**Critical Constraints**
- Data access is strictly scoped to the owner's own MSME — no cross-MSME visibility at any layer
- Cannot modify `vat_status`, tax regime, or `programme_ref`
- Cannot void any transaction; all corrections must be raised with their assigned Programme Staff

---

### 2.3.2 Programme Staff / SME Agent / Field Officer (`programme_staff`)

**Who They Are**
National Service Personnel (NSP) and Youth Employment Agency (YEA) field officers deployed to specific zones or districts under the GRA Modified Tax programme. They serve as the operational link between informal traders and the TriLiska compliance infrastructure — conducting onboarding visits, verifying Ghana Card data, and ensuring submissions are accurate before they reach the GRA Console.

**Primary Goals**
- Onboard new MSMEs and validate Ghana Card and TIN data at point of registration
- Assist traders with correct sales entry and expense categorisation
- Review and void erroneous sales records within their assigned zone
- Escalate tax regime threshold alerts (GHS 500,000 and GHS 750,000 flags) to District Officers

**Pain Points**
- Managing large trader populations across geographically dispersed market zones
- Handling MSMEs with missing or unverified TINs at point of registration
- Ensuring offline-generated POS data reconciles correctly after batch sync

**Interface**
Web Portal (React/Vue) for zone-level dashboards and MSME management. Sunmi device for field-based data entry and trader-side support.

**Key Permissions**
- Create: MSME profiles, Sales transactions on behalf of traders
- Read: All MSMEs and transactions within assigned zone/district
- Void: Sales transactions within own zone only
- Initiate: Tax regime status changes (must be audit-logged)

**Critical Constraints**
- Cannot modify tax calculation results or override GRA tax plugin outputs
- Tax regime changes require explicit initiation by `programme_staff` or `admin` and are immutably written to the audit log
- MFA enforced on all Web Portal sessions
- Cannot access records outside their assigned zone

---

### 2.3.3 District Officer (`district_officer`)

**Who They Are**
Zonal Heads responsible for oversight of multiple Programme Staff zones within a district. Their role is supervisory and analytical — reviewing programme health, monitoring threshold alerts, and escalating compliance issues — but they do not directly create or void operational records.

**Primary Goals**
- Monitor district-level MSME registration progress and tax submission rates
- Review system-generated threshold flags (GHS 500,000 and GHS 750,000 cumulative turnover alerts)
- Ensure Programme Staff are operating correctly within their respective zones
- Access the District / Zone Overview report to track enrolled MSMEs, active MSMEs, total transactions, total revenue, and total tax collected by zone

**Pain Points**
- Lack of granular visibility into individual trader activity without cross-referencing Programme Staff field reports
- Managing escalations involving rejected or amended GRA submissions

**Interface**
Web Portal (React/Vue) — district-scoped dashboards and reporting views only.

**Key Permissions**
- Read: All MSME profiles, transactions, and submission statuses within assigned district
- Create: None
- Void: None

**Critical Constraints**
- Cannot initiate tax status changes — must escalate to `programme_staff` or `admin`
- MFA enforced on all Web Portal sessions

---

### 2.3.4 GRA Officer — Government Viewer (`gra_officer`)

**Who They Are**
Officials of the Ghana Revenue Authority (GRA) with a mandate to audit and review MSME tax compliance records submitted through the TriLiska programme. Their access is governed by the Revenue Administration Act 2016 (Act 915).

**Primary Goals**
- Review registered MSME records and validate Ghana Card and TIN linkages
- Inspect submitted tax reports and verify submission statuses (Draft, Submitted, Accepted, Rejected, Amended)
- Access audit and evidence trails for compliance investigations
- Export programme-level reports in CSV or PDF format for regulatory use

**Pain Points**
- Dependency on programme submission quality — MSMEs registered without a TIN create reconciliation gaps at filing time
- Need for exportable, tamper-evident audit trails suitable for enforcement proceedings

**Interface**
GRA Console — a dedicated, read-only React/Vue portal. No write operations are exposed at any layer of the NestJS API Gateway for this role.

**Key Permissions**
- View: Registered MSMEs, submitted tax reports, submission statuses, tax payment records, full audit and evidence trails
- Export: Programme reports (CSV, PDF)
- Create: None — under any circumstances
- Void: None — under any circumstances
- Modify: None — under any circumstances

**Critical Constraints**
- **ABSOLUTE RULE:** GRA Officers do not modify SME data under any circumstances. This constraint is enforced at the NestJS API Gateway layer and is not overridable by application configuration or administrator action.
- MFA enforced on all GRA Console sessions

---

### 2.3.5 System Administrator (`admin`)

**Who They Are**
Internal Trident Aliska Digital Tech operational staff responsible for platform health, user lifecycle management, and pilot reporting. This role does not configure tax calculation rules — those are policy-locked within the Odoo GRA tax plugin and governed by GRA.

**Primary Goals**
- Manage user accounts and role assignments across all five role types
- Handle rejected or amended GRA submissions requiring system-level intervention
- Generate pilot programme reports for internal and stakeholder review
- Maintain system configuration, excluding tax calculation rules

**Pain Points**
- Coordinating rejected submission workflows across Programme Staff zones without disrupting live trader operations
- Maintaining audit log integrity during system configuration changes

**Interface**
Web Portal (React/Vue) — full system access across all districts and zones.

**Key Permissions**
- Create: All record types
- Void: All record types
- Read: Entire system, all districts and zones
- Configure: User roles, system settings (not tax calculation rules)

**Critical Constraints**
- Cannot modify the tax calculation rules embedded in the Odoo GRA tax plugin — these are policy-locked by GRA mandate
- All void and amendment actions are immutably audit-logged
- Hardware token MFA required for all sessions

---

## 2.4 MSME Profile Data Model

The following fields constitute the canonical MSME record as mastered in Odoo and exposed via the NestJS API Gateway.

| Field | Key | Format / Allowed Values | Required at Registration |
|---|---|---|---|
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

---

## 2.5 Tax Regime × Role Interaction

| Role | View Current Tax Status | Initiate Status Change | Change Requires Audit Log | Can Override System Threshold Flag |
|---|---|---|---|---|
| `msme_owner` | Yes (own record only) | No | N/A | No |
| `programme_staff` | Yes (zone scope) | **Yes** | **Yes — immutable** | No |
| `district_officer` | Yes (district scope) | No | N/A | No |
| `gra_officer` | Yes (full read-only) | No | N/A | No |
| `admin` | Yes (full) | **Yes** | **Yes — immutable** | No |

### Tax Regime Reference

| Regime | `vat_status` | Turnover Threshold | Effective Tax Treatment |
|---|---|---|---|
| Unregistered | `not_registered` | Below GHS 200,000 | 0% — no VAT obligation |
| Modified Tax / Flat Rate VAT (VFRS) | `flat_rate` | GHS 200,000 – GHS 500,000 | 3% applied to gross sales |
| Standard Rate | `standard` | Above GHS 500,000 | VAT 15% + NHIL 2.5% + GETFund 2.5% + COVID Levy 1% |

**Threshold Behaviour:** The system raises advisory flags at GHS 500,000 and GHS 750,000 cumulative turnover. These are informational only — the system does **not** automatically change `vat_status`. A `programme_staff` or `admin` user must review the flag and initiate any status transition, which is then immutably written to the audit log. No role can suppress or dismiss a threshold flag without audit-logging the action.

---

## 2.6 Phase 2 Role Roadmap

The following role extensions are noted for planning purposes only. They are **out of scope for Phase 1**.

| Addition | Description | Dependency |
|---|---|---|
| Bank / Fintech Partner API Access | Read-scoped API access for MTN MoMo, Fido, and equivalent fintech partners supporting embedded lending and payment reconciliation | Phase 2 integration specification; separate data exposure boundary definition |
| National Rollup GRA Analytics Role | Elevated GRA analytics role with cross-district aggregation access for national compliance reporting | GRA data governance policy alignment; Revenue Administration Act 2016 compliance review |
| Twi / Ga / Ewe / Hausa / Dagbani Language Support | Flutter POS localisation for MSME Owners in non-English-primary language communities | Phase 2 localisation sprint; community validator engagement |

All Phase 2 role additions will be subject to the same NestJS API Gateway access control architecture and will require a formal amendment to this document prior to implementation.

---

*End of Section 2 — User Personas & Role Matrix*
*Next: Section 3 — High-Level System Architecture*
