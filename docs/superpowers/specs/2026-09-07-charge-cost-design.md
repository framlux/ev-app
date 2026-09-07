# Charge cost — design

**Date:** 2026-09-07
**Status:** Approved for planning
**Scope:** Give every charge session a cost: home charges from the PSE energy rate in effect at the time, Supercharger sessions from what Tesla actually billed. Tesla only.
**Parent spec:** `docs/superpowers/specs/2026-09-04-ev-app-design.md` (§4.1, §11)

---

## 1. Purpose

`session.cost` and `session.cost_currency` have existed since migration 003 and nothing has ever written them. The read API carries both keys, `SessionList.svelte` renders a Cost column conditionally on `costCurrency`, and the charge detail page renders a Cost tile the same way — all of it currently dead, waiting for a tariff. Parent spec §11 deferred exactly this.

This spec fills those columns from two sources, and stores the rate alongside the figure so a price is a fact about the charge rather than a fact about today's tariff.

### Goals

- Price a home charge at the PSE rate **in effect when it started**, captured onto the session so history never re-prices when PSE raises rates.
- Price a Supercharger session at what Tesla actually billed — including idle and congestion fees — rather than reconstructing it from a rate.
- Cost nothing, in Tesla API calls, in a month with no Supercharging.
- Make an unpriced charge legible as unpriced, never as free.

### Non-goals

- **Time-of-use.** PSE Schedule 307 (11.2¢ off-peak / 53.6¢ peak) needs per-interval energy, not a multiplication. The rate model leaves room for it; the URDB parser refuses it loudly (§3.3) rather than mis-pricing.
- **The whole bill.** The PSE energy charge is not the basic charge, the riders, or the taxes. §3.2's manual override is where that reconciliation lives if it ever matters.
- **Green Button import.** PSE offers manual "Download My Data" export only; automated Connect My Data is not broadly available. A file-upload reconciliation pipeline is its own spec.
- **Third-party networks.** EVgo, Electrify America and destination chargers stay `unknown`. We have no billing feed for them.
- **Drives and idles.** Only charges get a cost.

---

## 2. Decisions and rationale

| Decision | Choice | Why |
|---|---|---|
| Where the rate comes from | OpenEI URDB API, with a manual override | The only free programmatic source for PSE rates (utility EIA #15500, ~117 rate entries incl. Residential Schedule 7). NREL refreshes it roughly annually, so it can lag a PSE change by months — the override is not a nicety, it is the correctness escape hatch. |
| Rejected: scraping pse.com | — | Tariff PDFs, no contract, breaks silently. |
| Rejected: paid aggregator | — | Nectar/UtilityAPI want PSE credentials and a contract to solve a problem one number in a settings form solves. |
| The rate is stored on the session | `cost_rate_per_kwh` | The ask was to capture the rate *at the time of the charge*. Storing only the product would make the charge page unable to show its own arithmetic, and would make a future re-pricing indistinguishable from the original. |
| Supercharger pricing | Tesla's billing, not a rate | `/api/1/dx/charging/history` returns what was charged, idle fees included. A per-kWh Supercharger rate would be a guess that is wrong at exactly the sessions that cost the most. |
| When reconciliation runs | Month-end, gated on a pending row | Fees post hours-to-days after a session, so this cannot run at close. The gate — one indexed `EXISTS` — is what makes a quiet month free; the month-end interval is the owner's choice, accepting that a charge early in a month shows blank until the run. §6 records the tradeoff. |
| How a charge knows it may be Supercharged | `fast_charger_present` / `fast_charger_type`, already captured | `catalogue.ts:232,463`. The car tells us at the time, for free, so the gate never needs an API call to decide whether to make an API call. |
| Classification is self-evident, not sniffed | home → Tesla-billed → unknown | No charger-taxonomy to maintain: at home is a location fact, Tesla-billed is a match fact, and everything else is honestly unknown. |
| Unpriced renders as unpriced | `costBasis` in the API contract | A blank cell is ambiguous between "free" and "we don't know". The existing UI already refuses to render an unknown cost as zero (`components.test.ts:392`); this extends that to say *why*. |

---

## 3. Architecture

### 3.1 Data model — migration `007_energy_rate.sql`

```sql
CREATE TABLE energy_rate (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  effective_from  TIMESTAMPTZ NOT NULL,
  price_per_kwh   NUMERIC(10,5) NOT NULL,
  currency        TEXT NOT NULL DEFAULT 'USD',
  source          TEXT NOT NULL,          -- 'urdb' | 'manual'
  urdb_label      TEXT,                   -- the URDB page label the value came from
  fetched_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (effective_from, source)
);
CREATE INDEX energy_rate_effective_from_idx
  ON energy_rate (effective_from DESC, (source = 'manual') DESC);
```

The index is two-column because §3.2's tiebreak is part of the lookup's ORDER BY, not prose. `gen_random_uuid()` is used nowhere else in this repo — every existing PK is TEXT minted in Node (`sessions.ts:22`) — so 007 carries a comment recording that it is a core builtin since PG 13, needs no `CREATE EXTENSION` on the `postgres:17-alpine` we run, and that `energy_rate.id` being a UUID where `session.id` is TEXT is deliberate: nothing joins them.

No `effective_to`. A rate's window ends where the next row's begins, and a stored end date is a second copy of that fact that can disagree with it.

`session` gains:

```sql
ALTER TABLE session
  ADD COLUMN cost_rate_per_kwh NUMERIC(10,5),   -- the rate this cost was computed at
  ADD COLUMN cost_basis        TEXT,            -- 'home' | 'tesla' | 'pending' | 'unknown'
  ADD COLUMN cost_source       TEXT;            -- 'urdb' | 'manual' | 'tesla-invoice' | 'backfill-estimate'
```

Two columns because they answer two questions. `cost_basis` says **why this charge is priced the way it is** — where the energy came from — and is what the UI renders when there is no figure. `cost_source` says **where the number came from**, and is what marks a backfilled estimate as an estimate. Both are null on drives and idles.

`cost_rate_per_kwh` is populated for a Tesla-billed session too, as `amountDue ÷ energyKwh`, so the charge page shows an effective rate for both kinds symmetrically. It is derived there, not authoritative.

### 3.2 Rate lookup

```ts
rateAt(c: DbClient, at: Date): Promise<EnergyRate | null>
```

The row with the greatest `effective_from ≤ at`, tie broken toward `source = 'manual'` because a human typed that one on purpose:

```sql
SELECT … FROM energy_rate WHERE effective_from <= $1
 ORDER BY effective_from DESC, (source = 'manual') DESC LIMIT 1
```

**A manual override suspends the fetch for as long as it stands.** This is a correction to the design, not a detail of it: review reproduced the original rule silently defeating itself. Ordering on the date first means a fetched row does not *tie* with an override typed this morning — it beats it outright the next day, and the "insert only when the value differs" guard can never save it, because an override exists precisely when the operator disagrees with URDB's number. The escape hatch for URDB's lag would have survived until the next tick, or the next pod restart, which fires one immediately. A 41.2 kWh charge would then price at $8.20 against an operator tariff saying $10.30, with nothing logged and the settings page showing the fetched row as in effect.

So §3.3's fetch asks what rate is in force before it asks OpenEI, and declines — without making the call — while that answer is `manual`. Fetching resumes when a human says so, by entering a newer manual row. The worker logs one line a day while an override stands, so a rate that has stopped moving is explicable from the pod log rather than mysterious.

The lookup's ordering is deliberately left alone. A `urdb` row already sitting later on the same day as a manual one still wins the lookup; post-fix nothing can create that state, and making a manual row outrank every later fetched row forever is a decision about how long an override should live, which is the owner's to make and not a defect to fix.

**`price_per_kwh` must be coerced to a number inside `rateAt`**, and the interface must type it `number`. `pg` returns NUMERIC as a string, and this repo installs no `setTypeParser` — the only coercion that exists (`queries.ts:118`) is in the web tier, which the worker never goes through. `energyKwh * rate` would coerce by luck; `rate + x` would concatenate. The test asserts `typeof` explicitly, because `toBeCloseTo` passes on a coerced string and would hide it.

No rate covering the moment (a charge older than the first row) returns null, and the charge stays unpriced. Inventing a rate backwards is what §5's backfill does deliberately and visibly; the pricing path must not do it accidentally.

### 3.3 URDB fetch

```
GET https://api.openei.org/utility_rates
    ?version=latest&format=json&api_key=…&eia=15500&sector=Residential&approved=true
```

The parser picks the Residential Schedule 7 entry by `label`, then reads `energyratestructure[0][0].rate`. It **throws** if `energyratestructure` has more than one period, or the first period more than one tier — that shape means a tiered or time-of-use plan, and silently taking `[0][0]` would price a whole year of peak charging at the off-peak rate. A loud failure that leaves the last known rate in place is the correct outcome of "PSE moved you to Schedule 307".

A fetch inserts a row only when the value differs from the newest existing row, with `effective_from = now()` — URDB's own `startdate` describes when the tariff took effect, but we cannot honestly claim to have known it then, and back-dating would silently re-price sessions already closed at the old rate. Same value, no row.

Runs daily from a **second, coarse** `setInterval` in the worker — *not* the tick at `main.ts:103`, which is the accumulator flush at roughly 1 Hz (`FLUSH_INTERVAL_MS`, `main.ts:38`) and would hammer OpenEI ~86,400 times a day. The new timer is `unref()`d like its neighbour and cleared in `shutdown` beside the existing `clearInterval(timer)`, or SIGTERM will not drain. The worker owns database writes; the web tier makes no outbound HTTP from a request path.

The fetch is also skipped entirely while a manual override is in force (§3.2) — the check is on the rate in force, before the HTTP call, so an override costs no request at all.

Config: `OPENEI_API_KEY` — free from NREL's signup form at `openei.org/services/api/signup`, no cost and no commercial-use restriction. Whatever their published limit is, one call a day is not near it. Absent, the fetch is skipped entirely and manual rows are the whole story — the feature degrades to "type your rate in", which is a working product, not a broken one.

### 3.4 Pricing at close

In `pipeline.finish()`, for `kind === 'charge'` only, after `closeSession`:

1. **At home?** True if any sample in the session has `locatedAtHome === true`. If the signal is null throughout — the car may not report it — fall back to `start_lat`/`start_lon` within `EV_HOME_RADIUS_KM` of `EV_HOME_LAT`/`EV_HOME_LON`. Without either, we cannot say, and the session is not home.
   → `cost_basis = 'home'`, `cost = round(energyKwh × rateAt(startedAt), 2)`, `cost_rate_per_kwh`, `cost_currency`, `cost_source = rate.source`.
   `energyKwh` null, or no rate: `cost_basis = 'home'` with a null cost. We know why it is unpriced; we just have no number.

2. **Possibly Tesla-billed?** Any sample with `fastChargerPresent === true`, **and** `fastChargerType` either absent or naming a Tesla connector.

   Two facts from the code shape this. Enum values keep their proto prefix — `normalise.ts:14` passes `.String()` names through untouched, so the column holds `'FastChargerSupercharger'`, not `'Supercharger'`; the existing web fixtures use the unprefixed form and will actively mislead. And `FastChargerType` is catalogued at tier `static`, a 3600s interval (`catalogue.ts:463`), while `FastChargerPresent` is tier `charge` at 60s (`catalogue.ts:232`) — so a 20-minute Supercharger stop can carry the presence flag on many samples and the type on none. **Requiring both would leave real Supercharger sessions unclassified**, which is why a null type still qualifies.
   → `cost_basis = 'pending'`, cost null. This is the flag §3.5's gate reads.

3. **Otherwise** → `cost_basis = 'unknown'`.

This runs inside the same transaction as `closeSession`, so a session never commits half-classified.

Two structural notes. `finish()` returns at `pipeline.ts:556` (`if (kind !== 'charge') return`) above the battery-health block, so pricing appended naively lands after an unconditional return and never runs — it becomes a second helper called alongside the battery one, not an append. And `finish()` has two callers: `applySample` and `recoverOpenSession`, so a session recovered after a crash is re-priced. That is correct — the rate is looked up by the session's own start time, not by now — and it gets a test saying so.

`rateAt` is the first *read* through the `Store` seam, which is write-only today. That is a deliberate widening, recorded in a comment, and held to one indexed SELECT inside the message transaction.

### 3.5 Supercharger reconciliation — BLOCKED on a credential decision

**This section is not implementable as written, and the reason is not a detail.** The ingest worker holds no Tesla credential of any kind: `apps/ingest/src/config.ts` reads none, `apps/ingest/src` imports `@ev/tesla` only for decoders and the field catalogue (`pipeline.ts:7`, `deps.ts:14`), and `refresh()` in `oauth.ts:125` has no runtime caller anywhere in the repo. The only live Tesla credential in the deployed system is an in-memory map in the **web** pod (`tesla-session.ts:48`) — per-operator, roughly 8 hours, deliberately refresh-tokenless because `WEB_SCOPES` omits `offline_access`, under a header comment stating there is deliberately no renewal path.

So "the worker token already carries `vehicle_charging_cmds`" was wrong: that token does not exist. Three exits, all owner decisions rather than implementation details:

1. **Mount a sealed refresh token into the ingest pod.** Reverses the posture documented at `tesla-session.ts:1-26`.
2. **Run reconciliation in ev-web instead.** Contradicts §3.3's rule that the web tier makes no outbound HTTP — though a scheduled job is not a request path, so this is a smaller contradiction than it first reads.
3. **A third credential, scoped to billing reads only.** Most work, least blast radius.

Unanswerable from this repo either way: ev-web reaches Tesla through `ev-teslaproxy` behind a NetworkPolicy, so whether the ingest pod has egress to `fleet-api.prd.na.vn.cloud.tesla.com` at all, and whether that proxy passes `/dx/*` unsigned, needs the k8s manifests.

Everything below stands as the design once a credential exists. **§3.4's `pending` classification ships now regardless** — it is free, it is local, and it means the sessions this job will one day price are already identified rather than needing a backfill.

A job on the ingest worker's tick, in two guards, cheapest first:

1. **Calendar guard.** Has the month changed since the last run? The last-run timestamp lives in `ingest_cursor` under source `charge-reconcile`, reusing the table that already exists for exactly this shape of fact.
2. **Work guard.** `EXISTS (SELECT 1 FROM session WHERE kind='charge' AND cost IS NULL AND cost_basis='pending')`. No pending row, no API call — a month with no Supercharging costs one indexed query.

Then, once:

```
GET /api/1/dx/charging/history?vin=…&startTime=<oldest pending session start>&endTime=<now>
```

paginated — and `fleet-api.ts`'s `get<T>` returns only `(await res.json()).response`, discarding the rest of the envelope, so if Tesla's pagination cursor sits outside `response` it is unreachable through the existing helper. That is the single most useful thing a live call would settle. Each record carries a session id, site name, start/stop times, energy and a `fees[]` array whose entries hold `feeType`, `amountDue`, `currencyCode`, `usageBase`, `usageTier1..3`, `pricingType`.

**Matching** is by time-window overlap between our session and the record's charge start/stop, for our VIN. The record with the greatest overlap wins, and only if the overlap exceeds half our session's duration. Two records tying, or none clearing the threshold, leaves the session pending — a wrong cost attached to the wrong stop is worse than a blank one.

**Cost** is the sum of `amountDue` across `fees[]`, so idle and congestion fees are included: it is what was paid. Currency comes from `currencyCode`, and entries disagreeing on currency leave the session pending with a logged warning rather than summing dollars and euros. A matched session gets `cost_basis = 'tesla'`, `cost_source = 'tesla-invoice'`, and a derived `cost_rate_per_kwh`.

**Give-up.** A session still pending 45 days after it ended flips to `unknown`. Free supercharging, a session billed to another account, or a record Tesla never publishes would otherwise be re-queried forever.

The scope for `dx/charging/*` is undocumented. `vehicle_charging_cmds` is in `SCOPES` (`oauth.ts:29`) but not in `WEB_SCOPES`, and widening scopes costs a full re-consent — see the comment block at `oauth.ts:7-22`. Both the scope and the pagination envelope are settled by one live call, which cannot be made until the credential question above is answered.

The reconcile watermark uses `advanceCursor`, which is GREATEST-guarded (`cursor.ts:32-45`): a run can never be forced to repeat by rewinding, only by a manual DELETE. Worth a comment where it is written, along with the correction that `migrations/001_initial.sql:105` — "`ingest_cursor` is not written by anything in this plan" — stops being true here.

### 3.6 API contract

`SessionSummaryDto` gains, alongside the existing `cost` / `costCurrency`:

```ts
/** Why this charge is priced the way it is. null on drives and idles. */
costBasis: 'home' | 'tesla' | 'pending' | 'unknown' | null
/** Where the figure came from. null whenever cost is null. */
costSource: 'urdb' | 'manual' | 'tesla-invoice' | 'backfill-estimate' | null
/** The rate the cost was computed at, in costCurrency per kWh. */
costRatePerKwh: number | null
```

The existing invariant — `costCurrency` null whenever `cost` is null, enforced in `api.ts` and asserted at `api.test.ts:868-873` — extends to `costSource` and `costRatePerKwh`.

**It must NOT extend to `costBasis`.** `costBasis` is precisely the field that survives a null cost: it is what §3.7 renders *instead of* a number. Gating all four the same way in `mapSession` is the easy mistake, and it makes every pending and unknown state unreachable while every test still passes.

### 3.7 UI

**Charges list** (`SessionList.svelte`). The Cost column appears when any charge in the page has a `costBasis`, not merely a currency — otherwise a page of exclusively pending sessions hides the column that would explain them. An unpriced row renders `—` with a title. There are **four** unpriced states, not three: `unknown` → "Not priced", `pending` → "Awaiting Tesla invoice", and `home` with a null cost → "No rate for this date" (no covering rate row) or "Energy not measured" (null `energyKwh`). §3.4 creates that last pair; a UI naming only three states renders one of them as an empty title.

**Charge detail** (`routes/charges/[id]/+page.svelte`). The Cost tile is always present for a charge. Priced, it shows the figure with the arithmetic beneath it — `41.2 kWh × $0.199/kWh` for home, `$0.42/kWh effective` for Tesla. Unpriced, it shows the basis in words instead of a number. When a Tesla record carried more than one fee, the tile is followed by a breakdown by `feeType`, because an idle fee is the one charge whose explanation changes behaviour. Persisted fee rows are a `SessionDetail`-only concern with their own table and their own bounded query, modelled on `ChargeSetup` — they never join `SessionListItem`. That table lands with §3.5, not before.

`formatCost` already returns an em dash when the currency is missing even with an amount present (`format.test.ts:192`), and a genuine $0.00 must still render (`format.test.ts:201`) — so "never render unpriced as free" branches on `costBasis`, never on treating 0 as missing. The per-kWh formatter sets min/max fraction digits explicitly, or `Intl` rounds $0.199/kWh to $0.20.

A `costSource === 'backfill-estimate'` figure renders with an *estimated* marker — an approximation sign before the figure — and a title saying it was priced at a later rate than it was charged at. This applies on **both** surfaces: an estimate on the list rendered as a plain figure would be indistinguishable from a real price at exactly the moment a reader is scanning for one.

### 3.8 Configuration

| Name | Purpose | Absent |
|---|---|---|
| `OPENEI_API_KEY` | URDB fetch | Fetch skipped; manual rates only |
| `EV_HOME_LAT`, `EV_HOME_LON` | Home fallback when `locatedAtHome` never arrives | Fallback disabled; the signal is the only test |
| `EV_HOME_RADIUS_KM` | Radius for that fallback | Defaults to 0.1 |

No test constrains these names: `env-names.test.ts` greps `apps/web/src` only, and asserts one thing — no `PUBLIC_`-prefixed name in a file reading `$env/*/private`. It never looks at `apps/ingest`. So `OPENEI_API_KEY` breaking the `EV_`/`MQTT_` prefix pattern is a judgement call (it names a vendor, not this system) and carries a comment saying so.

`positiveNumber` (`config.ts:62`) cannot validate the coordinates: it rejects negatives, and Seattle's longitude is about −122. `Number('')` is also `0`, which would place home in the Gulf of Guinea and silently misclassify every charge rather than failing at startup. The pair needs a `coordinate` validator, treated as all-or-nothing.

---

## 4. Settings surface

A rates section on the settings page: the current rate, the history behind it with each row's source and date, and a form to add a manual rate. Reads and one insert — no outbound HTTP, no scheduling. Adding a row is the override; nothing is ever edited or deleted, because a rate someone charged at is a historical fact.

A second manual rate on an instant that already carries one is a **409 naming the date and the price already recorded**, not a silent success. `insertRate` is `ON CONFLICT DO NOTHING` against `UNIQUE (effective_from, source)`, so the original route answered 201 Created with the old price still in the table — a correction that looked accepted and changed nothing. An identical resubmission still answers 201 with the stored row, because that one is genuinely idempotent.

---

## 5. Backfill

A one-off script prices already-closed charges at **today's** rate, `cost_source = 'backfill-estimate'`.

Stating the cost of this choice plainly: for any charge older than the last PSE rate change, the figure is invented. Two things bound the damage — the estimate marker in §3.7 makes every such row visibly an estimate, and re-running a properly dated backfill later is possible once `energy_rate` has real history. Rows the script priced are identifiable by `cost_source`, so a later pass can correct exactly them and nothing else.

Old sessions may predate the `locatedAtHome` signal, so the script uses the §3.4 coordinate fallback to decide home. A session it cannot place stays `unknown`. Pending Supercharger sessions are not backfilled — §3.5 will price them properly, or give up.

---

## 6. Known tradeoffs

- **Month-end reconciliation delays a figure.** A Supercharger stop on the 2nd shows "Awaiting Tesla invoice" for four weeks. The gate, not the interval, is what makes an idle month free, so a daily run would cost a handful of calls after a trip and show the number the next day. Recorded here because the interval is a one-line change if the wait annoys.
- **URDB lag.** A PSE rate change may not reach us for months. The manual override is the answer, and the rate history makes the lag visible rather than silent.
- **The energy charge is not the bill.** No basic charge, riders, or taxes. A charge priced here is what the electrons cost, not what the envelope says.
- **Backfilled figures are estimates.** §5.
- **The Supercharger half is blocked, not built.** §3.5. Home pricing does not depend on it, and `pending` classification ships now so nothing has to be reconstructed later.

---

## 7. Build order

1. Migration 007 and the repo layer for `energy_rate` (`rateAt`, insert, list) plus `priceSession` as a sibling of `closeSession` — not a widening of it, whose UPDATE is positional through `$15`.
2. Pricing and classification at close (§3.4), and the config the home test needs.
3. URDB client and its parser, including the TOU refusal, on its own coarse timer.
4. API contract and the unpriced states (§3.6, §3.7).
5. Settings rates section, reading through its own module so it never contends with `queries.ts`.
6. Backfill script.

Steps 1–6 deliver a working home-charge cost and ship the `pending` flag. They have no dependency on the Tesla credential question.

7. **Owner decision:** which of §3.5's three credential exits.
8. One live `GET /api/1/dx/charging/history` call, once a credential exists — settles the scope and the pagination envelope.
9. Reconciliation job (§3.5), shaped by what step 8 found.

---

## 8. Testing

TDD throughout; the interesting cases:

- **`rateAt` boundaries** — a charge exactly on an `effective_from`, a charge before every row (null, not the oldest rate), the manual-beats-urdb tie.
- **URDB parser** — a flat Schedule 7 response parses; a two-period or two-tier structure throws; an unchanged value inserts no row.
- **Classification** — home by signal, home by coordinate fallback, Supercharger to `pending`, neither to `unknown`, and a session with `locatedAtHome` true on one sample among nulls.
- **Pricing** — rounding to cents, a null `energyKwh` giving a `home` basis with a null cost, no rate giving the same.
- **Matching** — greatest overlap wins, a below-threshold overlap stays pending, a tie stays pending, mixed currencies stay pending, multiple fees sum.
- **Give-up** — 45 days flips pending to unknown; 44 does not.
- **Gate** — no pending row makes zero HTTP calls (the assertion is on the fake client's call count); the same month twice runs once.
- **UI** — priced, pending, unknown and estimated states; the column appearing on a page of exclusively pending charges; the fee breakdown only when fees exceed one.
- **Contract invariants** — `costSource`, `costCurrency`, `costRatePerKwh` all null together with `cost`.
