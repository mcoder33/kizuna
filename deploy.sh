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

echo "→ жду, пока служба ответит"
ssh "$SERVER" 'i=0; until curl -fsS -o /dev/null http://127.0.0.1:3000/login || [ $i -ge 20 ]; do sleep 1; i=$((i+1)); done; systemctl is-active kizuna'

echo "→ проверяю снаружи"
# Сразу после перезапуска первое соединение иногда обрывается на установке TLS,
# поэтому спрашиваем трижды и верим последнему внятному ответу.
for attempt in 1 2 3; do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 https://kizuna.agent-hub.space/login || true)
  [ "$code" != "000" ] && break
  sleep 2
done
echo "   https://kizuna.agent-hub.space/login → $code (401 = басик-авторизация на месте, как и должно быть)"

echo "готово"
