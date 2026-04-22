#!/usr/bin/env bash
# ---------------------------------------------------------------
# BW6 AI Triage Demo — stop script
# Stops services started by start.sh (mock-servicenow).
# Flogo binaries are managed by VS Code — stop them there.
# ---------------------------------------------------------------
DEMO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PID_FILE="$DEMO_DIR/.pids"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
ok()   { echo -e "${GREEN}  ✔  $*${NC}"; }
warn() { echo -e "${YELLOW}  ⚠  $*${NC}"; }

echo ""
echo "[ Stopping demo services ]"

if [ -f "$PID_FILE" ]; then
  while read -r pid name; do
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" && ok "Stopped $name (PID $pid)"
    else
      warn "$name (PID $pid) was not running"
    fi
  done < "$PID_FILE"
  rm -f "$PID_FILE"
else
  # Fallback: kill by port
  for port in 8081; do
    pid=$(lsof -iTCP:"$port" -sTCP:LISTEN -n -P 2>/dev/null | awk 'NR>1{print $2}')
    if [ -n "$pid" ]; then
      kill "$pid" && ok "Stopped process on :$port (PID $pid)"
    fi
  done
fi

echo ""
warn "bw6-sn-mcp-wrapper (:9090) and bw6-ticket-triage-agent (:8080) are Flogo processes — stop them via VS Code."
echo ""
