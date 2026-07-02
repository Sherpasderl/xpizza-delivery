# Assignment Optimization Roadmap (propose-first)

_Status: DRAFT rev-3 — addresses the 15 Codex round-1 findings + bakes in Sheng/Liu §5, OrderStacking §4–5, Meituan dispatch-system, Liu/He/Shen "On-Time LMD", and DoorDash switchback experimentation. Each PHASE gets its own propose-first design + gate + build; this doc is the committed sequence so the optimization is a tracked workstream, not left at "greedy is good enough."_
_Grounded in `/downloads/lmd algorithm docs/`: Meituan (Informs 2024), processes-13-03211 (MIP), OrderStacking, Sheng/Liu (data-driven DRO), Liu/He/Shen On-Time LMD (2021), RL-dispatching, GA-bundling; + DoorDash "Iterating Real-time Assignment Algorithms Through Experimentation" (Lin & Sun, 2020 — read from the saved `.rtfd`: switchback experiments + experiment-in-production, since offline simulation is infeasible)._

## Why this exists

The pickup-hub work (S1–S3) built the **substrate** the optimization runs on — correct mutual-exclusion assignment (universal delivery-CAS), hub-aware routing, safe stacking mechanics. It is **not** the optimization the OFD literature describes. Today's assignment is a greedy heuristic:

```
pickEligibleDriver (index.js:2862): filter [status!=off_shift, push-reachable, not in timeout cooldown,
  under stacking cap] → sort [orderCount asc, statusPriority, straight-line haversine distance].
```
No prediction, no wait/delay objective, no tour estimation, no stacking economics. Sound *foundation*, but **several** docs (Meituan, GA, MIP) identify prep/ready time — and Sheng/Liu identify **service time + tour length** — as the material levers, none of which is wired. (OrderStacking abstracts prep away; Sheng/Liu treat prep as an out-of-scope operations input — so "unanimous" would overstate it.) This roadmap stages the leverage in, robustly.

## The core sequencing principle

Optimize on predictions only once (a) assignment is correct — **done** — and (b) we **measure** the inputs. So: **foundation → data → prediction → objective-based matching → stacking economics.** Hard dependency graph (not a rigid chain):

```
Phase 0 (ship now) ──▶ Phase 1 (ready-time)  ─┐
                   └──▶ Phase 2 (tour/travel) ─┴─▶ Phase 3 (objective assignment) ──▶ Phase 4 (stacking economics)
```
Phases 1 and 2 are **independent** and can proceed in parallel after 0. Phase 3 needs **both** 1 and 2. Phase 4-v1 needs 1+2; 4-v2 (batch bundling) needs Phase-3's batch assignment.

## Doc → capability → our code

| Doc insight | Capability | Replaces / adds in our code | Phase |
|---|---|---|---|
| Prep-time material (Meituan, GA, MIP) | Capture prep-time + ephemeral context | new `order_events`/`order_timelines` (observer) | **0** |
| " → predict it | Ready-time predictor | new: `predictReadyAt(order)` | **1** |
| **Sheng/Liu §4–5: `l(y_k)` tour-length LASSO** · Liu On-Time: predict-then-optimize + learn driver routing behavior | Predicted tour/travel time | replaces haversine `distanceKm` (index.js:2955) | **2** |
| **Sheng/Liu §5: min expected delay past τ; SAA/DRO** · Liu On-Time: on-time-*rate* service level + two-stage · Meituan MD-score (matching-degree) · MIP (min unmet-demand + courier count) | Objective-based matching | replaces the greedy sort (index.js:2968) | **3** |
| **DoorDash: switchback experiment + experiment-in-production** (offline sim infeasible; OR owns the experiment) | Rollout evaluation for dispatch changes | Evaluation & rollout safety § | **eval** |
| OrderStacking §4–5 (unimodal optimal stacking *level*, customer-wait ceiling, party-optimal ordering) · GA / Meituan OA (concrete bundle selection) | Stacking economics + bundling | evolves the cap policy (see below) | **4** |
| Meituan (regular ~30s OA cadence + separate abnormal-case reassignment); RL | Continuous re-optimization (non-myopia direction) | new re-eval loop | **5 (aspirational)** |

*Attribution notes (Codex #6/#7/#8): Meituan's XGBoost is for predicting whether batched groups survive to the final solution (ML-assisted batching), NOT ready-time. Meituan MD-score, MIP (min unmet-demand+couriers under time windows), and Sheng/Liu DRO (worst-case delay under service-time ambiguity) are **distinct** objectives — cited as partial inspiration, with our own objective stated explicitly in Phase 3. OrderStacking derives an economic optimal stacking **level** + market effects, not a pairing algorithm.*

---

## Phase 0 — Ready-time instrumentation (data capture) — BUILT
- **Goal:** capture `prep_time = ready_at − new_at` + the ephemeral predictors (kitchen load, driver supply) that are **unrecoverable if not logged live**.
- **Status:** design Codex-APPROVED (`READY_TIME_PHASE0.md`, df565bd); **implementation built + layered-gated 2026-07-02** (emulator 12/12 + Codex-on-diff APPROVED); pending the `drivers_available`/`drivers_on_shift` enrichment + the 30→31 prune-safe deploy.
- **Why first + early:** every day undeployed is training data lost. Also the **baseline measurement** substrate for every later phase's evaluation.
- **§5 tie-in:** to feed Phase 2's `l(y_k)` and Phase 3's `t̃_i`, extend capture (Phase 0.x) with **per-location service/handoff time** and **delivery-tour geometry** (see Phase 2 prereq).

## Phase 1 — Ready-time predictor
- **Goal:** `predictReadyAt(order)` → expected ready timestamp, per-restaurant. Feeds Phase 3's target window `τ`.
- **Draws from:** prep-time as the material stochastic input (Meituan/GA/MIP).
- **v1 (heuristic):** per-restaurant rolling prep-time by hour-of-day × item-count × current `kitchen_load_ahead` percentile. **v2 (learned):** gradient-boosting once enough Phase-0 data.
- **v2 data path (Codex #3):** requires a minimal offline **training + out-of-sample evaluation + prediction-serving + prediction-logging (predicted vs actual)** design — specified in Phase-1's own doc before v2, not hand-waved.
- **Prereq:** Phase 0 banking data. **Success:** predicted `ready_at` MAE beats the naive fixed-prep-constant baseline.

## Phase 2 — Travel / tour-time prediction (Sheng/Liu §4–5)
- **Goal:** replace straight-line haversine with expected **tour time**; for a driver's assigned set `y_k`, predict the route length.
- **Adopt Sheng/Liu's `l(y_k)`** (their eq. 3): a LASSO **linear in geometric features** — depot→closest-customer distance `d`, max latitudinal/longitudinal spread `a,b`, `√(stops−1)` interaction terms, and stop count — then travel time `= l(y_k)/v`. Chosen for their stated reasons: **accuracy** (beat TSP + the naive baseline on real data), **interpretability** (linear), **tractability** (keeps Phase-3 a solvable MIP). v2: heterogeneous speed `v_k` / traffic, or a learned tour model.
- **PREREQ (Codex #2 — the real gap):** `l(y_k)` needs **delivery-tour geometry + actual tour length** — customer locations per tour + realized route length/time. Phase-0 `order_events` gives assigned→picked→delivered *timestamps* but **not the road path**. So Phase 2 requires either a **light GPS/leg-trace capture** (a Phase-0.x add) or a **routing/ETA API** as the v1 tour-time source. Pick one in Phase-2's design; don't assume Phase-0 already has it.
- **Predict-then-optimize + capture the driver's *actual* routing behavior (Liu/He/Shen "On-Time LMD", 2021):** the driver's routing decision is unobservable/intricate to model directly — so the predictor's job is to **learn the driver's realized routing behavior from data** and plug that into the optimization (a two-stage structure: assignment outer, driver routing inner, captured by the predictor). **Headline managerial insight to respect: "a large sample size does NOT compensate for misspecification of the driver's routing behavior"** — getting the behavioral form right matters *more* than data volume. → Phase 2 must train `l(y_k)` on **real driver routes** (not assumed TSP-optimal or straight-line), and validate against behavioral misspecification, not just sample-size/MAE.
- **Anti-band-aid (Codex #15):** a v1 distance→time calibration must monitor **calibration error by zone/hour/driver-status** and carry a **stated cutoff** to graduate to `l(y_k)` / a learned tour model — so the stopgap can't entrench.
- **Prereq:** Phase-0 timestamps + the tour-geometry source. **Success:** predicted tour time correlates with actual materially better than haversine — evaluated for behavioral fidelity, not just aggregate error.

## Phase 3 — Objective-based assignment (Sheng/Liu §5 objective + our terms)
- **Goal:** replace the greedy sort with an assignment that minimizes a **stated objective**, combining predicted `ready_at` (Phase 1), predicted tour time `l(y_k)/v` (Phase 2), and driver load.
- **Our objective, stated explicitly (Codex #7):** minimize **expected total customer delay past the delivery deadline** — Sheng/Liu §5's `min Σ_k E_P[(Σ_i t̃_i·y_ik + l_k/v − τ_k)^+]`. In Sheng/Liu `τ` is the **delivery target/window**, NOT `ready_at`; here **`τ_k` is the delivery-deadline budget** — e.g. `promised_delivery_at − max(now, predicted_ready_at)` — so Phase-1 `ready_at` gates route-start/pickup availability + the remaining slack, while `l_k/v` is Phase-2's tour time and `t̃_i` the (uncertain) per-location service time. This is the *concrete* replacement for "customer wait + system cost." Related-but-distinct: Meituan MD-score (multi-stakeholder matching-degree) and the MIP (min unmet-demand + courier count under windows) are cited as **partial inspiration**, not adopted wholesale.
- **On-time *rate* as the service-level framing (Liu/He/Shen "On-Time LMD"):** the same delay-past-deadline `(·)^+` metric, but the target the platform *promises* is **on-time performance** — the fraction of orders delivered by their deadline — not just average delay. Their real-world baseline: **20.4% of orders late, 13.9% late by >10 min** — the improvement headroom. Frame Phase-3 evaluation around **on-time rate** (a reliability/SLA metric customers & merchants actually feel), with average delay as secondary. Structurally it's a **two-stage stochastic program** (assign orders→batches outer; driver routing inner, captured by the Phase-2 predictor), solvable via branch-and-price; the objective plugs the Phase-2 travel-time predictor directly into the optimization (predict-then-optimize).
- **v1:** a weighted scalar of the objective over the **existing greedy candidate set** (keeps the CAS/eligibility substrate; only the *ranking* changes → low-risk, behavior-bounded). **v2:** batch/global assignment as a MIP over the pending set, with **SAA** (sample-average over historical `t̃_i`) and, per Sheng/Liu §5.2–5.3, a **DRO** worst-case variant robust to service-time distribution ambiguity + uncertain travel time.
- **Driver fairness/earnings as a first-class term (Codex #13):** Meituan and the MIP paper weight courier income, workload, and unpaid idle/wait time. Phase 3's objective **must include** driver earnings/workload/fairness (and unpaid wait), not optimize customer/system delay alone — else it starves slower/farther drivers.
- **Multi-stakeholder MD-score + adaptive weights (Meituan §dispatch-system):** Meituan encodes the four stakeholders — **consumer** (on-time/intact), **merchant** (served fresh), **courier** (enough orders/less labor), **platform** (efficiency) — into a per-(order,courier) **MD "matching-degree" score** (a component: the marginal route-distance increase of adding the order). Two lessons we adopt: (1) our objective is explicitly **these four stakeholders**, not customer+system alone (reinforces the fairness term above); (2) **a static weighted scalarization is insufficient** — Meituan reports the relative scales shift *intraday*, so the weights must be **adaptively updated** (there's no clean theory for the weights → treat weight-calibration as a real sub-problem, not a constant). Our v1 weighted scalar must therefore log its weights + support re-tuning, and graduate toward adaptive/learned weights.
- **v2 architecture — the 3-stage decomposition (Meituan) + real-time bound:** behavior estimation (≈ Phase 2 courier tour/travel prediction) → candidate evaluation (score + **prune** which order-combinations to consider) → OA generation (solve the global many-to-one assignment). The assignment is **NP-hard and large** (couriers take 5+ orders at peak → ~N^6 vars for 5-to-1) and must solve in **~10 s** to keep courier status consistent — so v2 leans on candidate pruning, not brute force.
- **Prereq:** Phases 1 + 2. **Success:** lower avg customer delay-past-τ **and** improved driver-earnings fairness vs the greedy baseline (measured via Phase-0 + the eval harness).

## Phase 4 — Stacking economics + bundling
- **Goal:** decide **when** stacking helps (vs added delay) and **which** orders to bundle — past the fixed cap + same-hub gate. Current effective policy (Codex #10): `reassertAssignable` caps a **zero-order driver at 1** and allows a **2nd only in pre-departure stacking** (`STACKABLE_STATUSES = available|assigned|at_restaurant`); otherwise full. So it's "max two, pre-departure only."
- **Economic frame — OrderStacking §4–5 (baked in):** stacking level `L` is a **first-class decision with an interior optimum**, not a fixed cap or "stack-maximally":
  - **Unimodal surplus (§5, Thm 1–2):** every party's surplus + social welfare is **quasi-concave in `L`** — rises then falls. So there is an *optimal* stacking level; over-stacking destroys value. Phase-4 targets that interior optimum, not a hard cap of 2.
  - **Customer-wait ceiling (§4, market condition):** the market breaks down past `L̂ = (2V+dδ)/(dδ)` — beyond a wait bound, customers stop ordering. → a **hard max-customer-delay constraint** on stacking (this is the ceiling in Success, made concrete).
  - **Party-optimal levels are ordered (§5.2, Thm 2):** `L*_customer > L*_platform > L*_restaurant > L*_driver` — the **platform-optimal level over-stacks relative to drivers.** → Phase-4's objective must **weight driver surplus/earnings** (ties to Codex #13), not chase platform throughput alone.
  - OrderStacking is a **stylized economic model** (equilibrium, continuous mass) → it supplies the **objective + constraints** (interior optimum, wait ceiling, driver-weight), NOT the operational algorithm.
- **Non-additivity (Meituan) — why greedy stacking is wrong:** the MD score of assigning several orders *together* to a courier **≠ the sum** of assigning them separately — bundle value is non-additive. So stacking can't be decided order-by-order greedily; it must **evaluate the combination** (Meituan's candidate-evaluation prunes which combinations to score). This is the operational complement to OrderStacking's economic frame.
- **Operational algorithm — for the *which*:** GA order-bundling + Meituan OA/candidate-evaluation (concrete bundle selection + pruning over the pending set). A simple, effective batching primitive from Liu On-Time: **group orders sharing a (rounded) delivery deadline** into a candidate batch, then let the objective decide whether to keep the stack.
- **v1:** a wait/delay-cost gate on the existing same-hub stack (stack only when predicted marginal delay keeps the bundle under the customer-delay ceiling AND net surplus — customer + driver-weighted — is positive). **v2:** bundle optimization over the pending set.
- **Anti-band-aid (Codex #14):** v1 is **time-boxed** with graduation criteria — volume threshold, **regret vs a replay/backtest optimizer**, and a cap on manual threshold tuning — so the heuristic can't become permanent.
- **Prereq:** **v1 — Phases 1+2** (needs ready-time + tour-time to price marginal delay); **v2 — Phase-3 batch/global assignment.** **Success:** stacking raises throughput without breaching the customer-delay ceiling **and** without eroding driver earnings below the no-stacking baseline.

## Phase 5 — Continuous re-optimization (aspirational)
Periodically re-evaluate open assignments as state changes. Meituan runs its **regular OA at a fixed cadence (~30s, city-level)** and, *separately*, reassigns not-yet-picked orders only in **abnormal scenarios** via route-prediction checks (~every minute) — the two are distinct, not one 30s re-dispatch loop. The motivating concern is **non-myopia**: each dispatch moment's decision affects later ones, so a purely greedy/one-shot assignment can forgo long-term optima. But the paper is explicit that the future is stochastic and hard to predict (a precise simulator is too expensive) — so re-optimization is a *direction*, not a solved mechanism, and no clean "look-ahead recovers the global optimum" is claimed. A related non-myopic **supply** trade-off (Liu On-Time): dispatching *more* drivers improves the current batch's on-time rate but consumes capacity for later batches — so even the "how many drivers to deploy now" decision is inter-temporal, and Phase-0's `drivers_on_shift`/`drivers_available` signal feeds it. **Only if** volume/economics justify the complexity; RL dispatching is the far end. Explicitly out of near-term scope.

---

## Evaluation & rollout safety (Codex #11–12 + DoorDash's real-time-experimentation framework)

Two hard truths for real-time dispatch: (a) **shadow logging alone is biased** — the unchosen path never happened, so you can't measure what the new objective *would* have done; (b) **a faithful offline simulator is infeasible** — DoorDash reports building one is *"as hard as solving the logistics problem itself"* (continuous decisions, driver accept/decline, each decision shapes the future). So offline methods are **idea-filters, not the verdict** — the accurate measure is a **production switchback experiment.** (This tempers a pure "backtest first" stance: replay has limited fidelity here.)

**Preliminary filters (cheap, low-fidelity — screen ideas, don't trust as the verdict):**
1. **Offline replay / backtest** on Phase-0 `order_events` — new-vs-greedy-vs-oracle regret; catches obviously-bad ideas (can't replay counterfactual driver behavior).
2. **Emulator scenario tests** — deterministic correctness/edge cases (this repo's Java-lane authority).
3. **Shadow mode** — log the new decision beside greedy; analyze disagreement rate + magnitude.

**The accurate measure — switchback experiment in production (DoorDash):**
- Dispatch changes have **interference** (shared driver pool) → per-order/per-driver A/B is confounded, and pre/post observational studies carry confounds (Kohavi, Tang & Xu, *Trustworthy Online Controlled Experiments*, ch. 11). Instead **randomize control (incumbent) vs treatment by region × short time-window** (a few hours); the ~1 h delivery lifespan means results land in ~2 weeks.
- **Implement the change AS the experiment, owned end-to-end by the algorithm designer** (not handed to SWE): small implementation differences have *dramatic* assignment-quality consequences, so the owner's intent must be exactly reflected — this also eliminates the validated-vs-productionized gap and makes rollout trivial (the experiment path *is* the production path). SWE steps in only for complex changes; rigorous code review holds. (DoorDash frames this as a DevOps extension for OR — the model owner works inside the production system.)
- **Change types it covers** (DoorDash's own list, mapped to our phases): input-data prep, MIP objective/constraints (Phase 3), new information for decisions (Phases 1–2), output execution, engineering-design changes that hurt solution quality.
- **Guardrails + rollback:** pre-defined success/failure thresholds on on-time rate, customer delay-past-τ, driver earnings/fairness, unassigned rate, timeout/reassign churn; automatic rollback.
- **Small-fleet caveat:** short windows on the busiest region; as gains shrink (diminishing returns), **experiment power** must grow (longer/more windows + variance reduction) to detect smaller improvements — plan for it.

Only after the switchback clears its thresholds does the policy drive assignments fleet-wide.

## Dependencies & guardrails
- Graph: **0 → {1, 2}; 3 needs 1+2; 4-v1 needs 1+2; 4-v2 needs Phase-3 batch.**
- **Behavior-bounded:** the CAS/eligibility substrate (S1–S3) is preserved — the optimization changes only *ranking/decision*, never the mutual-exclusion or hub-safety guarantees already proven live.
- Each phase = its own propose-first design → Codex gate → emulator/replay/shadow validation → gated deploy. This doc is the frame, not a license to skip per-phase rigor.

## Out of scope (this doc)
Model-training infra, the specific ML stack, per-phase implementation detail, and the RL/continuous-reopt endgame — each belongs to its own phase design.
