#!/bin/bash
cd "$(dirname "$0")"
if ! command -v node >/dev/null; then echo "Installeer eerst Node.js (LTS) via https://nodejs.org"; open https://nodejs.org; read; exit; fi
while true; do
  [ -d node_modules ] || npm install --no-audit --no-fund
  node server.js
  code=$?
  if [ "$code" = "42" ]; then export TCG_RESTART=1; echo "Programma bijgewerkt, opnieuw starten..."; continue; fi
  break
done
