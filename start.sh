#!/usr/bin/env bash
# AIS Pluginpflege - Starter (macOS/Linux). Ausführbar machen: chmod +x start.sh
set -e
cd "$(dirname "$0")"

command -v node >/dev/null 2>&1 || { echo "Node.js >= 20 wird benötigt: https://nodejs.org"; exit 1; }
[ -d node_modules ] || { echo "Installiere Abhängigkeiten (npm install) ..."; npm install; }

echo
echo "  AIS Pluginpflege"
echo "  ================"
echo "   [1] Web-GUI starten (http://localhost:4317)"
echo "   [2] Repo scannen (read-only Analyse)"
echo "   [3] Plugin-Tests ausführen (alle verwalteten Plugins)"
echo
read -rp "  Auswahl [1/2/3]: " choice
case "$choice" in
  1) (sleep 2 && (command -v open >/dev/null && open http://localhost:4317 || xdg-open http://localhost:4317) ) >/dev/null 2>&1 &
     node start.js serve ;;
  2) read -rp "  Repo-Pfad (Enter = examples/sample-repo): " repo
     node start.js scan "${repo:-examples/sample-repo}" ;;
  3) node start.js test ;;
  *) echo "  Ungültige Auswahl." ;;
esac
