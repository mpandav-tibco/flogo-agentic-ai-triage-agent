# 🎬 Demo Script — BW6 AI Triage

Total runtime: **~5 minutes**. Keep the dashboard visible the whole time.

---

## Pre-flight (once)

```bash
cd bw6-ai-triage-demo
# Install deps (first time only)
(cd mock-servicenow && npm install)
(cd bw6-error-simulator && npm install)
```

Open **2 terminals**:

| Terminal | Command |
|---|---|
| T1 — Mock ServiceNow | `cd mock-servicenow && npm start` |
| T2 — Simulator (run on demand) | `cd bw6-error-simulator` |

Open the dashboard: `open dashboard/index.html` (or double-click it). It polls `http://localhost:8081` every 2s.

---

## Act 1 — "The noise problem" (60s)

**Talk track:** *"Today, every BW6 error becomes a ServiceNow ticket. Watch what happens with 50 events."*

```bash
# T3
npm run storm -- --bypass --count=50 --delayMs=50
```

Point at the dashboard: **50 incidents**. "Most of these are duplicates. This is the customer's daily pain."

Reset:
```bash
curl -s -X POST http://localhost:8081/api/now/reset
```

---

## Act 2 — "Turn on the AI agent" (30s)

**Talk track:** *"Now the same events, but routed through the Flogo AI Agent."*

```bash
# T3
npm run storm -- --count=50 --delayMs=100
```

Watch the dashboard update live. Expect roughly:

| Metric | Value |
|---|---|
| Created (unique) | **3** |
| Duplicates merged | **~45** |
| Bad data rejected | **2** |
| Noise reduction | **~94%** |

Let the audience absorb this for ~10 seconds.

---

## Act 3 — "Inspect one decision" (60s)

Pick one of the 3 created incidents, show its `work_notes` — highlight the agent's reason string, e.g.
> *"Rules: same BW-JDBC-100014 on OrderService matching INC0001001 within 15 min"*

Then open the same incident's occurrence count (`u_occurrence_count ≈ 15`). "Instead of 15 tickets, we have 1 ticket with 15 linked occurrences."

---

## Act 4 — "Sneaky new one" (45s)

Reset and run edge cases:
```bash
curl -s -X POST http://localhost:8081/api/now/reset
npm run edge
```

Point out in the dashboard:
- First JDBC timeout on `OrderService` → **NEW**
- Second same event → **merged** (occurrence=2)
- Same errorCode but on `PaymentService` → **NEW** ✅
  *"This is what rule engines get wrong. The agent understands that 'same error on a different app' is a different incident."*

---

## Act 5 — "Human-in-the-loop guardrail" (30s)

Still on the edge run, show the REST 500 pair:
- First is `NEW`.
- Second is a borderline duplicate (slightly different message).

Depending on model/rule confidence, you may see either a merge *or* a low-confidence new-ticket with a `possible duplicate of INCxxxxx` work note on the original.

**Talk track:** *"When the agent isn't sure, it errs on the side of creating a new ticket and leaves a suggestion for the on-call engineer. This protects SLA on genuine P1s."*

---

## Closer (15s)

- The **Flogo app** (`bw6-ticket-triage-agent.flogo`) is the shape they'd open in Flogo designer.
- The only piece to swap when going from this demo to production is the **`AgenticAIDecision` activity** → their preferred LLM (OpenAI, Azure OpenAI, Claude, local) via the OOTB Agentic AI connector, and the **mock ServiceNow base URL** → real ServiceNow instance.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Dashboard empty | Check `curl http://localhost:8081/health` |
| Agent errors | Check T2 logs; unset `OPENAI_API_KEY` to use deterministic fallback |
| Ports busy | `PORT=8082 npm start` for the agent, update `TARGET` when running simulator |
| CORS issue in browser | The mock SN already enables `cors()`; hard-refresh |

---

## One-shot smoke test (no storm)

```bash
# Single event through the agent
curl -s -X POST http://localhost:8080/triage -H 'Content-Type: application/json' -d '{
  "timestamp":"2026-04-21T09:00:00Z","appName":"OrderService","appNode":"orderservice-appnode-1",
  "processName":"OrderProcessing.process.FetchOrders","activityName":"JDBCQuery",
  "errorCode":"BW-JDBC-100014","errorMsg":"JDBC connection timeout","severity":"2 - High","correlationId":"test-1"
}' | jq
```
