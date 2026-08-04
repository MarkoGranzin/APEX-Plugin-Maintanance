#!/usr/bin/env bash
# Plugin Maintenance - launcher (macOS/Linux). Make executable: chmod +x start.sh
set -e
cd "$(dirname "$0")"

command -v node >/dev/null 2>&1 || { echo "Node.js >= 20 is required: https://nodejs.org"; exit 1; }
[ -d node_modules ] || { echo "Installing dependencies (npm install) ..."; npm install; }

echo
echo "  Plugin Maintenance"
echo "  ================"
echo "   [1] Start web GUI (http://localhost:4317)"
echo "   [2] Scan repo (read-only analysis)"
echo "   [3] Run plugin tests (all managed plugins)"
echo
read -rp "  Choice [1/2/3]: " choice
case "$choice" in
  1) (sleep 2 && (command -v open >/dev/null && open http://localhost:4317 || xdg-open http://localhost:4317) ) >/dev/null 2>&1 &
     node start.js serve ;;
  2) read -rp "  Repo path (Enter = examples/sample-repo): " repo
     node start.js scan "${repo:-examples/sample-repo}" ;;
  3) node start.js test ;;
  *) echo "  Invalid choice." ;;
esac
