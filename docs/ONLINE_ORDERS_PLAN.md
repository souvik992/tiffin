# Online orders: build plan

Status (2026-10-16): **approved by the owner. Phase 1 built and tested on one PC.** The order hub (`hub/`), the POS connection and the live ODS are in the ODS add-on (`addons/ods`, own installer), with Serviceability, GST on fees, road distance and a map provider switch. Tests cover F1-F5, F7, F8 and F11-F13 (hub and connector tests) and F15 (switch-off refused while orders are open). Still open in phase 1: F6 partial accept (v1 rejects the whole order), F14 (times come from the hub; no clock test yet), and trying it on a shop PC with a printer (docs/HARDWARE_TEST_PLAN.md). Phase 0 (contract in `contract/`) still waits for the owner's sign-off. Next: phase 2 (customer web app), SMS for OTP, hosting.

How the plan avoids gaps: agree the contract and every failure case **before** writing code, build in thin working slices, and close each phase with tests that inject failures, never only the happy path.

---

## 1. Principles (apply to every phase)

1. **Contract first.** One shared definition is written before any code, and the hub, the POS connector and the customer apps all use it:
   * the API (OpenAPI)
   * the event catalogue
   * the order state machine
2. **One owner per fact.**

   | Fact | Owner |
   |---|---|
   | Menu and prices | POS (publishes them) |
   | Order and its status | Hub |
   | GST bill and bill number | POS (made only on accept) |
   | Payment | Payment gateway (the hub stores its confirmations) |

3. **Event-driven, never polling.** The POS keeps one outgoing SSE connection to the hub. Events are numbered and acknowledged, and replayed after a reconnect. Actions go as HTTPS calls with request IDs, so a retry never repeats work.
4. **Nothing is lost or doubled.** Every message has an ID and every handler is idempotent. This already applies inside the POS (RULES.md 3); the hub follows the same rule.
5. **Offline mode stays safe.** With online orders off, the POS never connects. If the internet drops, counter billing is unaffected and the store shows as closed online.
6. **The POS never trusts outside money.** On accept, the POS recalculates price and GST from its own database (RULES.md 7).
7. **Each phase ends working and tested.** A phase is done only when its definition of done (section 7) is met.

## 2. Pieces and where they live

| Piece | Folder | What |
|---|---|---|
| Contract | `contract/` (new) | API (OpenAPI), event definitions, the order state machine as code, shared types and validators. No dependencies; used by everything below. |
| Order hub | `hub/` (new) | Cloud server: stores, pairing, menu, orders, event log, SSE streams, payment webhooks, customer API. Node/TypeScript + PostgreSQL. |
| POS connector | `src/services/online/` | Connects only when `isOnlineMode()`. Handles the SSE stream with resume and stores orders in a new `online_order` table (a migration). Accept makes the bill and KOT. |
| ODS | `ui/src/screens/Ods.tsx` | New / Preparing / Ready, sound alert, accept with prep time, reject with reason. Live through the POS's existing event stream. |
| Customer ordering | `apps/ordering/` (new) | Web app (PWA) per store: branding, menu, cart, order, live status. Later wrapped as Android/iOS apps. |
| Test harness | `hub/test/`, `test/online_*` | Runs hub + POS + a fake customer on one PC, with failure injection. |

## 3. Order state machine (to be signed off before coding)

```
PLACED ──(online payment)──► PAYMENT_PENDING ──► PAID ─┐
  │ (pay at counter)                                   │
  └────────────────────────────────────────────────────┴─► SENT_TO_STORE ──► RECEIVED (POS confirmed)
                                                                         │
             ┌───────────────────────────────────────────────────────────┤
             ▼                         ▼                                 ▼
         ACCEPTED (bill made)      REJECTED (reason)        AUTO_REJECTED (no answer in N min)
             ▼                         └──── refund if paid ◄────────────┘
         PREPARING ──► READY ──► COMPLETED (picked up / delivered)
Customer cancel: allowed until ACCEPTED (then only the store can cancel, with a credit note and refund).
```

Each transition is listed in the contract with:
* who may trigger it: customer, POS, hub timer or payment gateway
* which event it sends
* what the customer sees

## 4. Failure cases (each must have a test before its phase is done)

| # | Case | Required behaviour |
|---|---|---|
| F1 | The internet drops while an order is being sent | Hub keeps the event; POS resumes from its last event number; the order arrives once. |
| F2 | The internet drops while accepting | The accept call is retried with the same request ID; the bill is made once; the status reaches the customer. |
| F3 | The POS crashes after making the bill, before the hub hears | On restart the connector replays the pending accept (stored first, sent after: the outbox pattern). |
| F4 | A duplicate event or a replayed webhook | Ignored by ID. |
| F5 | The price changed after the menu was published | The order shows the price the customer saw. The POS flags the difference on the ODS; the bill uses the POS price, so the store decides to accept or reject. Exact rule to confirm with the owner. |
| F6 | An item is unavailable | v1: reject the whole order with a reason (partial accept later). Marking an item unavailable publishes it at once. |
| F7 | The store does not answer | Auto-reject after N minutes (setting), with a refund if paid; the customer is told. |
| F8 | The store's connection is down for more than 60 s | Store shows "offline"; new orders are refused with a clear message. |
| F9 | Payment succeeded but placing the order failed | The hub creates the order from the payment webhook, or refunds automatically; never money without an order. |
| F10 | Payment webhook late, or out of order | Matched by payment ID; the state machine ignores impossible jumps. |
| F11 | Customer cancels while the store is accepting | The first action wins at the hub (one transaction); the loser gets a clear message. |
| F12 | Two counters in one store | All screens see the order; the first accept wins; the others update live. |
| F13 | Hub restart or deploy | Streams reconnect and resume; no order lost (event log in PostgreSQL). |
| F14 | Clock difference between PC and hub | Times come from the hub; order is decided by event numbers, not clocks. |
| F15 | Online orders switched off with orders still open | Not allowed until open orders are finished, or the owner confirms rejecting them. |
| F16 | A refund after accept | A credit note in the POS (existing flow) plus a gateway refund. |
| F17 | Bad or abusive traffic | Rate limits, validation, signed webhooks, revocable device keys. |

## 5. Phases

| Phase | Builds | Done when |
|---|---|---|
| **0. Contract** | API spec, event catalogue, state machine, failure table final, decisions recorded | Owner signs off; contract tests compile |
| **1. Hub + POS + ODS (local)** | Pairing, menu publish, order intake, event log, SSE with resume, connector, `online_order` table, ODS live, accept to bill + KOT. Pickup + pay at counter | F1-F8, F11-F15 pass on one PC with failure injection |
| **2. Customer web app** | Per-store branding, menu, cart, order, live status; table QR if chosen | A real phone can order end to end against the local hub |
| **3. Online payment** | Gateway per store (money goes straight to the store), webhooks, refunds | F9, F10, F16 pass in gateway test mode; CA sign-off |
| **4. Go live** | Staging and production hub in an Indian region, domain, TLS, backups, monitoring and alerts, rate limits | One pilot store for 2 weeks with no lost or duplicate order |
| **5. Store apps** | Android (and iOS) wrappers per store, push notifications | Play Store / TestFlight builds approved |
| **6. Swiggy / Zomato** | Through UrbanPiper (built: hub `src/urbanpiper.ts`, hub/README.md) | UrbanPiper test orders (Atlas Developer Tools) flow into ODS; UrbanPiper certification |

## 6. Start now, in parallel (these take weeks and would otherwise become gaps)

| Item | Why it takes time |
|---|---|
| CA opinion: GST e-commerce operator (Section 9(5)) and TCS | Decides whether customer payments must go straight to each store |
| Payment gateway merchant account per store (Razorpay or Cashfree) | KYC per store takes days |
| Cloud account in an Indian region, domain name | Needed for Phase 4 (and staging earlier) |
| SMS OTP provider + **DLT registration** (TRAI) | Indian SMS needs registered templates; this can take 1-2 weeks |
| Google Play and Apple developer accounts | Apple enrolment and checks take time |
| Swiggy / Zomato partner application, or an aggregator contract | Approval is not in our control |
| Privacy policy and terms (DPDP Act 2023: customers' phone numbers) | Needed before collecting customer data |

## 7. Definition of done (every feature)

* Tests for the happy path **and** its rows in the failure table, written first.
* The contract is updated if the API changed, and stays backward compatible within v1.
* Typecheck and all suites green (backend, UI, desktop, hub).
* Docs updated: API.md, this plan, CHECKLIST.md. Anything not tested on real devices or networks goes in HARDWARE_TEST_PLAN.md.
* Human review for money, GST, payments, auth and the connector (RULES.md 10).

## 8. Owner decisions (2026-10-15)

| # | Decision |
|---|---|
| 1 | Approved: SSE events + HTTPS actions, phases 0-6 |
| 2 | Pickup and delivery; delivery by **in-house riders** (rider name/phone recorded on dispatch). Dine-in table QR later |
| 3 | **Online payment and COD** both. Default (by Claude, changeable): COD needs an OTP-verified mobile; guests pay online |
| 4 | Setting per store: **manual** (auto-reject after 5 min, 2-15 adjustable) or **automatic** accepting |
| 5 | Hosting: decided later (phases 0-3 run locally) |
| 6 | Customer: name optional, mobile required, OTP sign-in **and** guest checkout |

Still open: delivery fee and delivery area (radius or PIN codes); F5 price-change rule (proposal: show the POS price on the ODS and let staff accept or reject); hosting and domain.

## 8a. Original questions

1. Approve: SSE events + HTTPS actions, and this phase order.
2. First order types: pickup, dine-in table QR, delivery (whose riders?).
3. Pay at counter only in v1, or online payment from the start?
4. Auto-reject time (suggested 5 minutes) and the price-change rule (F5).
5. Hosting provider and budget; domain name.
6. Customer login: phone number + OTP, or guest checkout with a phone number.
