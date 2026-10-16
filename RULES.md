# Non-negotiable rules (read before changing anything; give this file to Claude Code)

1. **Money is integer paise. Quantity is integer thousandths. Rates are basis points.** Never use floating point for amounts. Multiply with `mulDivRound` (BigInt).
2. **The UI never calculates money.** Totals come from `src/core`. One source of truth.
3. **Every state-changing command goes through `runCommand` with a `requestId`.** Replays return the original result and do no work. Side effects that leave the database (journal, events) go in `h.after(...)`.
4. **Finalizing a bill is one transaction.** Do not add I/O, network calls or `await` inside it. Invoice numbers are allocated inside it.
5. **Finalized documents are immutable** (database triggers). Corrections are cancellations (same day, same open shift) or credit notes. Never edit or delete invoices, lines, payments, audit rows.
6. **Parameterised SQL only.** Never build SQL from user input (the only interpolated identifiers are whitelisted column names).
7. **Never trust client values for price, tax or totals.** Resolve from the database.
8. **Permissions are checked in the service layer**, not only in HTTP routes. Sensitive actions accept a manager approval (`override`).
9. **No personal data in logs.** Errors shown to users are plain language with one action; never stack traces.
10. **Every feature ships with tests**, including the failure path. Anything touching tax, numbering, payments, backup/restore, auth or the print queue needs a human reviewer.
11. **Never weaken**: the immutability triggers, `synchronous=FULL`, backup verification, the audit hash chain, the Host/Content-Type checks.
12. **Schema changes are new migrations** in `src/store/schema.ts` (never edit an applied one; checksums will refuse to start). Test upgrade from the previous version.
