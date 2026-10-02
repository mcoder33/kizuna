#!/usr/bin/env bash
# Выкладка Кизуны на сервер. Код едет rsync-ом с этой машины: приватный
# репозиторий не требует ключа GitHub на сервере, где живёт не только наш
# проект.
#
#   ./deploy.sh
#
# Что НЕ уезжает и почему:
#   .env    — ключи на сервере свои (/opt/kizuna/.env, режим 600): там свой
#             порт, свой путь к базе и PAGENT_SECURE_COOKIES=on.
#   data/   — журнал живёт в /opt/kizuna/data, вне каталога кода, поэтому
#             --delete его не сотрёт.
set -euo pipefail

SERVER="${KIZUNA_SERVER:-root@193.8.215.89}"
REMOTE="${KIZUNA_PATH:-/opt/kizuna/app}"
RELEASE_SHA="${KIZUNA_RELEASE_SHA:-}"

echo "→ проверяю, что рабочее дерево чистое"
if [ -n "$(git status --porcelain)" ]; then
  echo "  есть незакоммиченные изменения — выкладываю их как есть:"
  git status --short | sed 's/^/    /'
fi

echo "→ гоню код на $SERVER:$REMOTE"
# Снимки экрана (*.png) на сервер не едут, а картинки из public/ — это
# раздаваемая статика (превью ссылки og.png): правило для них стоит раньше.
rsync -az --delete \
  --include='/public/*.png' \
  --include='/public/release-cards/*.png' \
  --exclude='.git' --exclude='node_modules' --exclude='data' --exclude='.env' \
  --exclude='test-results' --exclude='playwright-report' --exclude='.playwright-mcp' \
  --exclude='tmp' --exclude='*.png' --exclude='.serena' --exclude='deploy.sh' \
  ./ "$SERVER:$REMOTE/"

echo "→ зависимости и перезапуск"
# npm ci только при изменившемся package-lock: иначе каждый релиз тратит минуту
# на переустановку того же самого.
ssh "$SERVER" "bash -s" <<'REMOTE_STEPS'
set -e
cd /opt/kizuna/app
chown -R kizuna:kizuna /opt/kizuna/app
if ! cmp -s package-lock.json /opt/kizuna/.lock-deployed 2>/dev/null; then
  echo "  package-lock изменился — переустанавливаю зависимости"
  sudo -u kizuna npm ci --omit=dev --no-audit --no-fund >/dev/null
  cp package-lock.json /opt/kizuna/.lock-deployed
else
  echo "  зависимости не менялись"
fi
systemctl restart kizuna
REMOTE_STEPS

echo "→ жду, пока служба ответит кодом 200"
ssh "$SERVER" 'bash -s' <<'REMOTE_HEALTH'
set -euo pipefail
systemctl is-active --quiet kizuna || { echo "служба kizuna не активна" >&2; exit 1; }
code=000
for attempt in $(seq 1 20); do
  code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:3000/login || true)
  [ "$code" = 200 ] && break
  sleep 1
done
if [ "$code" != 200 ]; then
  echo "локальная проверка /login не прошла: HTTP $code" >&2
  exit 1
fi
REMOTE_HEALTH

echo "→ проверяю снаружи"
code=000
for attempt in 1 2 3; do
  code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 https://yourkizuna.com/login || true)
  [ "$code" = 200 ] && break
  sleep 2
done
if [ "$code" != 200 ]; then
  echo "внешняя проверка /login не прошла: HTTP $code" >&2
  exit 1
fi
echo "   https://yourkizuna.com/login → HTTP 200"

# GitHub Actions passes its immutable commit SHA. Record only after both health
# checks pass, outside the rsync-managed application directory.
if [ -n "$RELEASE_SHA" ]; then
  if ! [[ "$RELEASE_SHA" =~ ^[0-9a-f]{40}$ ]]; then
    echo "KIZUNA_RELEASE_SHA должен быть полным SHA-1 коммита" >&2
    exit 1
  fi
  ssh "$SERVER" "printf '%s\\n' '$RELEASE_SHA' > /opt/kizuna/.deployed-sha"
fi

echo "готово"
