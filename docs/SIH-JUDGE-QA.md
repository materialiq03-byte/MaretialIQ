# MaterialIQ — SIH Judge Q&A (Step 26)

Short, defensible answers based on implemented functionality only.

**1. What problem are you solving?**
Public-sector enterprises (CPSEs) each maintain separate material masters. The
same physical item exists under different codes and descriptions across
organizations, blocking cross-CPSE demand aggregation, duplication removal, and
procurement intelligence. MaterialIQ discovers those duplicates, explains them,
and governs harmonization by humans.

**2. Why is this problem important?**
Fragmented material data means repeated procurement, uncomparable demand, and no
shared technical visibility across CPSEs. A trusted, explainable harmonization
layer is a prerequisite for any national material-intelligence effort. (We state
the mechanism, not invented savings figures.)

**3. Why can't simple string matching solve it?**
"SKF BALL BEARING 6205-2RS" vs "SKF DEEP GROOVE BRG 6205 2RS" share few literal
tokens but are the same item; conversely "HEX BOLT M20X80 SS304" vs "HEX BOLT
M20X80 SS304 WITH NUT" are textually near-identical but different procurements.
String matching produces both false negatives and false positives; you need
normalized semantics + technical attributes + rules.

**4. How do you detect technical conflicts?**
Category-aware critical attribute comparison: each category (bearings, valves,
motors, pumps, fasteners) declares critical attributes (seal_type, pressure_class,
voltage_rating, series…). Values are compared with explicit strategies — nominal
identifiers (series, class, thread, DN) require exact identity; measured numerics
allow the configured tolerance — and mismatches become structured conflicts with
criticality.

**5. What happens when two materials look similar but aren't equivalent?**
High textual similarity does NOT auto-merge. A critical conflict forces
NEEDS_TECHNICAL_REVIEW regardless of score (demo: CP-1001 ↔ BH-4410, 94+ textual
agreement, seal 2RS vs ZZ → review). Only humans can approve a match.

**6. Why is human review necessary?**
Seal type, voltage class, or a kit component change procurement identity in ways
only an engineer can judge. The system surfaces evidence and enforces process
(stale-decision protection, separation of duties, audit); the reviewer owns the
decision.

**7. How is your system explainable?**
Every candidate persists a structured evidence document: per-component scores with
weights, an attribute-by-attribute comparison matrix (EXACT/NORMALIZED/CLOSE/
MISSING/CONFLICT + importance + basis), conflicts, missing evidence, assembly and
manufacturer relationships, the applied decision rule. Judge Mode renders this as
WHY MATCH / WHY REVIEW / WHY NOT with a decision trace — deterministically, no
generated text.

**8. Is this an LLM?**
No. Deliberately not. The intelligence is deterministic: trigram-hashed semantic
representation, cosine similarity, token-level fuzzy matching, rule-based technical
comparison. Same input always produces the same output — auditable and reproducible.

**9. What exactly is your AI component?**
"AI-assisted deterministic material similarity and technical rule analysis":
the semantic representation + multi-signal scoring + category-aware rule engine.
We claim nothing neural.

**10. How did you evaluate it?**
50 hand-labelled synthetic cross-CPSE pairs (labelled from technical attributes,
never engine output) run through the exact production pipeline: accuracy 0.84,
macro F1 0.8327, weighted F1 0.8375, technical-conflict detection 20/20, FP 0,
FN 0. The run is append-only history and byte-reproducible (md5-verified).

**11. Why only 50 labelled pairs?**
Hand-labelling is expert work; 50 pairs × 3 classes is enough to validate the
scoring bands and conflict detection deterministically. The harness itself is
dataset-size agnostic — expanding labels is data work, not code work. We do not
extrapolate production accuracy from it.

**12. Is the data real CPSE data?**
No. All data is synthetic, created for SIH prototype evaluation, and labelled as
such in the UI and documents. Organization names (CPCL/NTPC/BHEL/NLC/SAIL) are
representative of the PS domain; no proprietary schemas are copied.

**13. How would you integrate with SAP/ERP?**
The Step 22 integration layer is the seam: a source adapter declares field
mappings → canonical contract → existing import pipeline. A real SAP connector
would be another adapter (RFC/OData/flat-file) — no core change. We built and
demonstrated the abstraction with five synthetic adapters; no live ERP connection
is claimed.

**14. How do you prevent duplicate harmonization?**
Source identity is (CPSE + source system + source record id) — never the
description. Re-ingestion is idempotent (existing UNIQUE(organization, code) net);
CMI creation is a separate governed workflow after human approval; the system
never auto-creates identities.

**15. How do you handle UOM differences?**
Two layers: SYSTEM conversion rules (7 rules, e.g. MM→CM) plus governed
material-specific domain rules that require proposal → approval (separation of
duties), versioned content, immutable history, and a steward dashboard. Quantities
aggregate per UOM only where an explicit active rule exists — otherwise kept
separate. No silent conversion.

**16. How do you handle rule changes?**
UOM domain rules are versioned: an amendment creates a new version, approval
follows separation of duties, history is append-only, and a reconciliation view
detects drift between history and versions. Effective/pending pointers make rule
changes auditable over time.

**17. How do you prevent unauthorized decisions?**
Server-side permission check (REVIEW_MATCHES) + organization scoping (a CPSE
reviewer can only decide pairs touching their org) + pending-state guard +
optimistic concurrency (expectedStatus → 409 when stale) + duplicate-decision
block + full audit attribution. UI visibility is never the security boundary.

**18. How do you handle multiple CPSEs?**
Organization is a first-class dimension: data is scoped per org end-to-end (imports,
candidates, procurement), adapters enforce CPSE identity fail-closed, review pairs
are explicitly cross-CPSE (LEFT ↔ RIGHT shown in UI), and read-scoping restricts
users to their organization while authority roles get read-only oversight.

**19. How does the system scale?**
Architecture choices that scale: inverted-index retrieval (no all-pairs scoring),
cheap prefilter before expensive scoring, chunked async jobs (5,000/tx) with
heartbeat recovery, indexed access everywhere (EXPLAIN-verified; judge brief
0.3 ms at 100k candidates), bounded requests/uploads. Benchmarks are
environment-specific; we claim measured results, not enterprise guarantees.

**20. How do you protect sensitive procurement data?**
RBAC + organization isolation on every endpoint, TLS-verified PostgreSQL (pinned
CA), session security (HttpOnly/SameSite/12h), rate limiting, CSRF origin checks,
security headers, bounded bodies, audited mutations, secret redaction in logs,
and a verified backup/restore procedure. Prototype-grade, documented honestly
(see SECURITY.md), no compliance claims.

**21. What happens when the model is uncertain?**
Uncertainty is surfaced, not hidden: mid-band scores route to NEEDS_TECHNICAL_
REVIEW, missing critical evidence is an explicit review trigger (missing ≠ equal,
missing ≠ conflict), and legacy/limited-evidence candidates are labelled LIMITED
in Judge Mode rather than given fabricated explanations.

**22. What is CMI?**
Common Material Identity — a governed prototype identifier ("CMI-BRG-6205")
created only after a human-approved match. It links each CPSE's original record
(codes preserved) into one technical identity, enabling cross-CPSE demand/spend
views. Prototype identifier, explicitly not an official national material code.

**23. Does MaterialIQ replace SAP?**
No. It is a harmonization and intelligence layer over material masters. ERPs stay
the system of record; MaterialIQ ingests via adapters, harmonizes under governance,
and can return mapping intelligence — a complementary layer.

**24. What is your biggest current limitation?**
Evaluation scale: 50 synthetic labelled pairs validate the approach but are not
production accuracy. (Runner-up: single-instance in-memory rate limiting, and no
live ERP connectivity — all documented in SECURITY.md/THREAT-MODEL.md.)

**25. What would you build next?**
1) A labelling workspace to grow ground truth (and a learned re-ranker only if it
beats the deterministic engine on held-out labels); 2) real SAP/ERP adapters on the
existing integration seam; 3) multi-instance deployment hardening (shared rate
limit store, DB-level isolation). The premium UI phase is planned separately.
