#!/usr/bin/env bash
# One command: create the virtualenv, install, start the server.
set -euo pipefail
cd "$(dirname "$0")"

PY="${PYTHON:-python3}"
if [ ! -x .venv/bin/python ]; then
  "$PY" -m venv .venv
fi
if [ ! -f .venv/.installed ] || [ requirements.txt -nt .venv/.installed ]; then
  .venv/bin/python -m pip install -q -r requirements.txt
  touch .venv/.installed
fi
if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env from .env.example. Add LLM_API_KEY and TAVILY_API_KEY to it, then re-run ./run.sh"
  exit 1
fi

PORT="${PORT:-$(grep -E '^PORT=' .env | tail -1 | cut -d= -f2 || true)}"
PORT="${PORT:-8000}"
echo "Chronos is starting on http://localhost:${PORT}"
exec .venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port "${PORT}"
