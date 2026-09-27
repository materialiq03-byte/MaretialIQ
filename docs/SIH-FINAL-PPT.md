# MaterialIQ — SIH Final PPT (14-slide content spec, Step 26)

Slide-by-slide content, each backed by the evidence manifest. Speaker notes kept
terse; every number traces to a verified artifact.

---

### SLIDE 1 — Title
**MaterialIQ** — AI-Powered Material Intelligence & Harmonization
Team name · Problem Statement 26099 · Theme: Smart Automation
Footer: *"Prototype · synthetic demonstration data"* · screenshot: 01-dashboard

### SLIDE 2 — The Problem
Visual: CPCL `CP-1001` "SKF BALL BEARING 6205-2RS" **vs** NTPC `NT-8821`
"SKF DEEP GROOVE BRG 6205 2RS" — different codes, different descriptions,
**same technical material**.
Bullets: 5 CPSEs × separate masters → hidden duplicates, uncomparable demand, no
shared intelligence. Cost/governance framing only — **no invented figures**.

### SLIDE 3 — Our Solution
Pipeline strip: **Import → Normalize → Discover → Compare → Explain → Review →
Harmonize → Govern**. One line under it: "Similarity discovers candidates;
technical governance decides."

### SLIDE 4 — How It Works
Architecture diagram (docs/SIH-ARCHITECTURE.md). Caption: deterministic,
explainable intelligence — "AI-assisted deterministic material similarity and
technical rule analysis" (no LLM claims).

### SLIDE 5 — Matching Intelligence
Component bars: **Semantic 30% · Fuzzy 20% · Technical 30% · Rules 20%**.
Verdict bands: ≥80 high-confidence (no critical conflict, same manufacturer) ·
60–79 review · <30 not-a-match. Message: *"The score is one input — evidence and
rules decide."*

### SLIDE 6 — Technical Intelligence (the money slide)
Side-by-side: CP-1001 **6205-2RS** vs BH-4410 **6205-ZZ** (screenshot 03).
Seal Type → CRITICAL conflict → NEEDS_TECHNICAL_REVIEW at 81% similarity.
Message: "Similarity discovers; conflicts gate."

### SLIDE 7 — Explainability / Judge Mode
Three panels (screenshots 05/05b): **WHY MATCH** (CP-1001↔SL-7721) ·
**WHY REVIEW** (2RS vs ZZ) · **WHY NOT** (low band 30). Show score decomposition +
technical matrix + decision trace. Caption: *"Every conclusion has an evidence
trail — deterministic, reproducible, no generated text."*

### SLIDE 8 — Human-in-the-Loop Governance
Flow: Candidate → Evidence → Reviewer (Accept/Reject/Defer) → CMI → Mapping
(screenshots 07, 08). Stale-decision protection + separation of duties + audit.
Message: *"MaterialIQ assists reviewers; it never replaces engineering approval."*

### SLIDE 9 — Enterprise Governance
Screenshots 09 / 10b / 10: Governance Cockpit (unified human work queue), UOM
stewardship (versioned rules, immutable history), CPSE Integration Center
(5 adapters, one canonical contract), Procurement demand per CMI.

### SLIDE 10 — Security
Control grid (verified): sessions (scrypt, HttpOnly/SameSite) · RBAC · org
isolation · IDOR scoping · CSRF origin checks · rate limiting · security headers ·
bounded bodies/uploads · CSV-injection-safe exports · parameterized SQL ·
audit trail · TLS verify-full · production boot guard · verified backup/restore.
**Honest disclosure box:** *"Our own hardening audit found 2 IDOR gaps — both
fixed and regression-tested."* No pen-test/compliance claims.

### SLIDE 11 — Evaluation
Dataset: **50 hand-labelled synthetic cross-CPSE pairs** (18 MATCH / 13 REVIEW /
19 NOT). Metrics: accuracy **0.84** · macro P **0.8730** · macro R **0.8596** ·
macro F1 **0.8327** · weighted F1 **0.8375** · conflict detection **20/20** ·
FP **0** · FN **0**. Big label: **"Prototype evaluation on synthetic data."**
Byte-reproducible (md5-verified).

### SLIDE 12 — Performance / Scalability
"Measured in the prototype test environment": Judge brief 0.3 ms @ 100k candidates
(EXPLAIN: PK search) · evidence detail 0.26 ms · decision 1.2 ms · queue ~20 ms @
10k via covering index · API 3.8–5.2 ms through the full security middleware ·
chunked async imports (5,000/tx, heartbeat recovery) · adapter overhead ~4% @ 100k.

### SLIDE 13 — Impact / Future Expansion
Implemented: harmonization workflow, explainability, governance, integration
abstraction. Future (labelled): CPSE-wide rollout, SAP/ERP adapters on the
existing integration seam, labelling workspace for larger ground truth, learned
re-ranking only if it beats the deterministic engine, multi-instance hardening.

### SLIDE 14 — Closing
**"Different codes. Different descriptions. One explainable material intelligence
layer."** + dashboard screenshot. Line: deterministic, governed, auditable — built
for the PS 26099 workflow end to end.

---

## 3-minute pitch (interrupt-safe)

- **0:00 Problem** — "Five CPSEs, five material masters, the same bearing bought
  five ways. Duplication and zero shared visibility."
- **0:30 Solution** — "MaterialIQ: governed ingestion → deterministic matching →
  explainable evidence → human-governed harmonization. Imports via source
  adapters, one canonical contract."
- **1:00 Live matching example** — open candidate 9947: CP-1001 ↔ SL-7721.
  "Text differs; technical attributes agree: semantic 30%, fuzzy 20%, technical
  30%, rules 20% → 100, HIGH_CONFIDENCE_MATCH."
- **1:40 Technical conflict** — candidate 4640: 2RS vs ZZ at 81 similarity.
  "Critical conflict → review. The system refuses to auto-merge."
- **2:00 Judge Mode** — "WHY? Here is every attribute, every rule, every score —
  deterministic, no black box."
- **2:20 Governance/security** — "Human decision is attributable and stale-proof;
  CMI is created only after approval; RBAC + org isolation + audited mutations."
- **2:40 Evaluation** — "50 labelled synthetic pairs: accuracy 0.84, conflicts
  20/20, zero false positives. Prototype evaluation, honestly labelled."
- **2:55 Closing** — "Different codes. Different descriptions. One explainable
  material intelligence layer."

(If interrupted at any point: each beat stands alone; jump to Judge Mode
screenshot 05 — it is the strongest artifact.)
