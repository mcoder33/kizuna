#!/usr/bin/env bash
set -euo pipefail
[[ $(id -u) == 0 && $(uname -s) == Linux ]] || { echo 'Запуск от root на сервере мониторинга после одобрения.' >&2; exit 1; }
command -v openssl >/dev/null
command -v htpasswd >/dev/null # apache2-utils: CLI only, no Apache server needed.
secrets=/etc/kizuna-monitoring/secrets
install -d -m 0700 "$secrets"
umask 077
for name in web_password admin_recipients_token grafana_password; do
  if [[ ! -e "$secrets/$name" ]]; then openssl rand -hex 32 > "$secrets/$name"; fi
  [[ -s "$secrets/$name" ]] || { echo "Пустой secret: $name" >&2; exit 1; }
done
# Password never appears in argv, environment or stdout. Preserve credentials
# on repeated installs; rehashing only refreshes the bcrypt salt.
hash=$(htpasswd -niB kizuna-monitoring < "$secrets/web_password" | cut -d: -f2)
temporary=$(mktemp "$secrets/web.yaml.XXXXXX")
trap 'rm -f "$temporary"' EXIT
printf '{"basic_auth_users":{"kizuna-monitoring":"%s"}}\n' "$hash" > "$temporary"
chown 65534:65534 "$temporary"
chmod 600 "$temporary"
mv "$temporary" "$secrets/web.yaml"
[[ -e "$secrets/telegram_bot_token" ]] || : > "$secrets/telegram_bot_token"
chown root:65534 "$secrets/web_password"
chmod 640 "$secrets/web_password" # Grafana gets supplementary group 65534.
chown 65534:65534 "$secrets/admin_recipients_token" "$secrets/telegram_bot_token"
chmod 600 "$secrets/admin_recipients_token" "$secrets/telegram_bot_token"
chown 472:472 "$secrets/grafana_password"
chmod 600 "$secrets/grafana_password"
echo 'Secrets готовы. Recipient token нужно установить на Kizuna VM; токены не выведены.'
