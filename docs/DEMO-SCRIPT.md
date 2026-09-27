# MaterialIQ — SIH Demo Script (Step 26 FREEZE edition)

**Demo server:** `.freebuff/step26-demo-data/start-server.ps1` → `http://localhost:63030`
**Dataset:** isolated copy of the reference (SHA-256 `cfaa694e…fd2fc87`), migrated
to schema v19 + procurement seeds — SYNTHETIC demonstration data for SIH prototype
evaluation. Reference `data/materialiq.db` is never used live.
**Pre-flight (2 min before demo):** run launcher → `curl http://localhost:63030/api/health/live` →
open `/` → open candidate 4640 → done. Full fallback: docs/SIH-DEMO-FALLBACK.md.

**All scenario IDs verified against the frozen dataset on 2026-09-25.**

| # | Time | Scenario | Where | What to show |
|---|---|---|---|---|
| 0 | 00:00–01:00 | Problem framing | Slide 2 → Dashboard `/` | "Same bearing, five masters." Dashboard KPIs (real counts). |
| 1 | 01:00–02:00 | Duplicate discovery | candidate **9947** via `/proposals` → search CP-1001 | CP-1001 ↔ NT-8821: normalized terminology, attributes, 4 score components, HIGH_CONFIDENCE_MATCH. "Different descriptions, same technical material." |
| 2 | 02:00–02:40 | Cross-CPSE harmonization | same search → **SL-7721** pair | CPCL ↔ SAIL: two organizations, technical agreement → candidate. |
| 3 | 02:40–04:00 | Technical conflict | `/matching/4640` | CP-1001 ↔ BH-4410: 6205-2RS vs 6205-ZZ, seal_type CRITICAL conflict at 81 → NEEDS_TECHNICAL_REVIEW. Original descriptions never mutated. **"Similarity discovers candidates; technical governance decides."** |
| 4 | 04:00–04:40 | Nominal spec conflict | candidate **9378** (BH-3002 ↔ NL-3307) | pressure_class 150# vs Class 300 → nominal identity, CONFLICT not CLOSE, review required. |
| 5 | 04:40–05:20 | Motor voltage conflict | candidate **10445** (CP-6005 ↔ BH-3005) | voltage_rating 415 V vs 230 V — conflict visible, not hidden by score. |
| 6 | 05:20–05:50 | Assembly detection | candidate **9291** (CP-5001 ↔ NL-2214) | "HEX BOLT M20X80 SS304 WITH NUT" vs "HEX BOLTS M20X80 SS304" — assembly evidence, descriptions shown verbatim, review required. |
| 7 | 05:50–06:20 | Cross-brand review | candidate **9706** (SKF ↔ FAG, 83) | manufacturer relationship → review, never auto-merge. |
| 8 | 06:20–06:50 | Not a match | candidate **9280** (SL-9906 ↔ BH-4419, 30) | low band — excluded from equivalence. |
| 9 | 06:50–08:10 | **Judge Mode** | `/matching/9947/judge` then `/matching/4640/judge` | WHY_MATCH and WHY_REVIEW: headline, score decomposition, technical matrix, conflicts, applied rules, decision trace, decision history, CMI state, source traceability. "Every conclusion has an explainable evidence trail." |
| 10 | 08:10–09:00 | Human governance | workbench decision panel → `/cross-reference` | Accept/Reject/Defer (stale-protected, audited) → CMI-BRG-6205 view: 3 CPSEs, legacy codes preserved, linked procurement demand. "MaterialIQ assists authorized reviewers; it does not replace engineering approval." |
| 11 | 09:00–09:40 | Governance + intelligence | `/procurement/governance` + `/procurement` | Unified human work queue (1,279 open), UOM stewardship, per-CMI demand/spend (synthetic, labelled). |
| 12 | 09:40–10:00 | Close | Slide 13/14 | Security controls one-liner + evaluation slide (50 pairs, 0.84, conflicts 20/20) → closing line. |

**Timing pressure?** Drop scenarios 4–8 (keep 1, 3, 9, 10) — that is the 5-minute
version with the strongest evidence.

**Demo etiquette:** every decision you make live is disposable (isolated dataset);
if anything degrades, restart the server — the dataset resets on rebuild.
