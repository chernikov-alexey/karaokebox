#!/bin/sh
# Запуск караоке: http://localhost:8765
# Разработка интерфейса с горячей перезагрузкой: ./run.sh и в другом окне cd frontend && npm run dev
set -e
cd "$(dirname "$0")"
if [ ! -x .venv/bin/python ]; then
  uv venv --python 3.12 .venv
  uv pip install --python .venv/bin/python -r backend/requirements.txt
fi
if [ ! -d frontend/node_modules ]; then
  (cd frontend && npm install)
fi
# пересобрать интерфейс, если исходники новее сборки
if [ ! -f frontend/dist/index.html ] || [ -n "$(find frontend/src frontend/index.html -newer frontend/dist/index.html 2>/dev/null | head -1)" ]; then
  (cd frontend && npm run build)
fi
cd backend
exec ../.venv/bin/python -m uvicorn app:app --host 127.0.0.1 --port "${PORT:-8765}"
