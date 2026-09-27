# MaterialIQ — SIH Demo Fallback Plan (Step 26)

**Rule: never fake a live result.** If a live step fails, switch to the labelled
frozen evidence (screenshots / recorded run) and say so plainly.

## Risk matrix & responses

| Failure | Detection | Response |
|---|---|---|
| Demo server down | any page fails to load | Restart: `powershell -ExecutionPolicy Bypass -File .freebuff/step26-demo-data/start-server.ps1` (≈10 s). Verify `http://localhost:63030/api/health/live`. |
| Port 63030 occupied | EADDRINUSE in server log | Kill listener (`netstat -ano \| findstr :63030` → `taskkill /PID x /F`) and relaunch. |
| Database unavailable / corrupt | 500s, empty lists | Demo DB is an isolated file (`.freebuff/step26-demo-data/materialiq.db`, SHA-256 `cfaa694e…fd2fc87`). Restore = re-copy from `data/` + seed scripts (documented rebuild, ~1 min). Authoritative reference `data/materialiq.db` is never used live. |
| Import fails live | wizard error | Skip live import; show Import Center history + validation screenshots (11-import-center). Import was demonstrated in the build; the demo does not depend on a fresh import. |
| Network unavailable | nothing external loads | Fully local: app + SQLite + localhost server need no network. (Supabase is NOT used in the demo path.) |
| Browser issue | rendering broken | Chromium preview tab is the primary; fallback: any Chromium browser on the demo laptop at `http://localhost:63030`. |
| API timeout / slow | spinner > 5 s | All evidence endpoints are ~0.3–5 ms; if a page hangs, refresh once, then move to the screenshot for that step. |
| Governance/procurement page error | error box | Dataset is pre-verified (all 12 screens 200 OK on 2026-09-25); if a page errors after a demo decision, restart server — demo decisions are disposable. |

## Backup demo assets (offline-proof)

1. **Screenshots** (`.freebuff/step26-screenshots/`, 12 verified captures) — full
   walkthrough possible without a live server.
2. **Frozen evidence numbers** (SIH-FINAL-EVIDENCE-MANIFEST.md): evaluation
   metrics + md5, benchmark table, security suite 40/40, backup PASS.
3. **Known-good records** (verified against the frozen dataset):
   - WHY_MATCH: candidate **9947** (CP-1001 ↔ SL-7721, score 100)
   - WHY_REVIEW: candidate **4640** (CP-1001 ↔ BH-4410, 2RS vs ZZ, score 81)
   - Voltage conflict: candidate **10445** (CP-6005 ↔ BH-3005, 415 V vs 230 V)
   - Power conflict: candidate **10444** (CP-3001 ↔ BH-3005, 75 KW vs 30 KW)
   - Pressure class: candidate **9378** (BH-3002 ↔ NL-3307, 150# vs Class 300)
   - Assembly: candidate **9291** (CP-5001 WITH NUT ↔ NL-2214 bolts)
   - Cross-brand: candidate **9706** (SKF ↔ FAG, score 83 → review)
   - Low band: candidate **9280** (SL-9906 ↔ BH-4419, score 30)
   - CMI: **CMI-BRG-6205** (3 CPSEs, 7 records)
4. **Dataset restore**: `data/` copy + `scripts/seed.ts` + `scripts/seed-procurement.ts`
   with `DATA_DIR` pointing at the demo dir (documented, deterministic).

## Presentation rule

If a frozen/recorded result is shown instead of a live action, presenters say:
*"Recorded run — the live system produces the same output deterministically."*
Never present a screenshot as a live interaction.
