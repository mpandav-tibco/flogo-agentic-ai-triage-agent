#!/usr/bin/env bash
# ---------------------------------------------------------------
# BW6 AI Triage Demo — startup script
# Starts: mock-servicenow (8081)
# Expects already running (via Flogo VS Code extension):
#   bw6-sn-mcp-wrapper    -> :9090
#   bw6-ticket-triage-agent -> :8080
# ---------------------------------------------------------------
set -euo pipefail

DEMO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_DIR="$DEMO_DIR/../bin"
LOG_DIR="$DEMO_DIR/.logs"
PID_FILE="$DEMO_DIR/.pids"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
ok()   { echo -e "${GREEN}  ✔  $*${NC}"; }
warn() { echo -e "${YELLOW}  ⚠  $*${NC}"; }
err()  { echo -e "${RED}  ✘  $*${NC}"; }

mkdir -p "$LOG_DIR"
> "$PID_FILE"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "   BW6 AI Triage Demo — Environment Setup"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# ── 1. Prereq checks ──────────────────────────────────────────
echo "[ Checking prerequisites ]"

if ! command -v node &>/dev/null; then
  err "node not found. Install Node.js 18+ and retry."
  exit 1
fi
ok "node $(node --version)"

if ! command -v curl &>/dev/null; then
  err "curl not found."
  exit 1
fi
ok "curl $(curl --version | head -1 | awk '{print $2}')"

# ── 2. npm install (idempotent) ───────────────────────────────
echo ""
echo "[ Installing npm dependencies ]"

if [ ! -d "$DEMO_DIR/mock-servicenow/node_modules" ]; then
  echo "  Installing mock-servicenow deps..."
  (cd "$DEMO_DIR/mock-servicenow" && npm install --omit=dev --silent)
fi
ok "mock-servicenow deps ready"

if [ ! -d "$DEMO_DIR/bw6-error-simulator/node_modules" ]; then
  echo "  Installing bw6-error-simulator deps..."
  (cd "$DEMO_DIR/bw6-error-simulator" && npm install --silent)
fi
ok "bw6-error-simulator deps ready"

# ── 3. Flogo binaries check ───────────────────────────────────
echo ""
echo "[ Checking Flogo binaries ]"

check_port() {
  local name=$1 port=$2
  if lsof -iTCP:"$port" -sTCP:LISTEN -n -P &>/dev/null; then
    ok "$name is listening on :$port"
  else
    warn "$name is NOT running on :$port — start it via the Flogo VS Code extension"
  fi
}

check_port "bw6-ticket-triage-agent" 8080
check_port "bw6-sn-mcp-wrapper"      9090

# ── 4. Start mock-servicenow ──────────────────────────────────
echo ""
echo "[ Starting mock-servicenow ]"

if lsof -iTCP:8081 -sTCP:LISTEN -n -P &>/dev/null; then
  warn "mock-servicenow already running on :8081 — skipping"
else
  node "$DEMO_DIR/mock-servicenow/server.js" \
    > "$LOG_DIR/mock-servicenow.log" 2>&1 &
  SN_PID=$!
  echo "$SN_PID mock-servicenow" >> "$PID_FILE"

  # wait up to 5s for it to be ready
  for i in $(seq 1 10); do
    if curl -sf http://localhost:8081/health &>/dev/null; then
      ok "mock-servicenow started (PID $SN_PID) -> http://localhost:8081"
      break
    fi
    sleep 0.5
    if [ "$i" -eq 10 ]; then
      err "mock-servicenow failed to start. Check $LOG_DIR/mock-servicenow.log"
      exit 1
    fi
  done
fi

# ── 5. Open dashboard ─────────────────────────────────────────
echo ""
echo "[ Opening dashboard ]"
if command -v open &>/dev/null; then
  open "$DEMO_DIR/dashboard/index.html"
  ok "Dashboard opened in browser"
else
  warn "Open manually: $DEMO_DIR/dashboard/index.html"
fi

# ── 6. Summary ────────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "   Services"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
printf "   %-30s %s\n" "mock-servicenow"          "http://localhost:8081"
printf "   %-30s %s\n" "bw6-sn-mcp-wrapper (MCP)" "http://localhost:9090/mcp"
printf "   %-30s %s\n" "bw6-ticket-triage-agent"  "http://localhost:8080/triage"
printf "   %-30s %s\n" "dashboard"                "dashboard/index.html"
echo ""
echo "   Quick commands:"
echo "   Reset SN:  curl -s -X POST http://localhost:8081/api/now/reset"
echo "   Stats:     curl -s http://localhost:8081/api/now/stats"
echo "   Storm(50): cd bw6-error-simulator && npm run storm -- --count=50 --delayMs=200"
echo "   Edge:      cd bw6-error-simulator && npm run edge"
echo ""
echo "   To stop: ./stop.sh"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
