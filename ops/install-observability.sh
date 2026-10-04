#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
# LogNamespace was added in systemd 245. Fail before restarting the app if the
# host cannot isolate and bound its journal; do not change the global journal.
version=$(systemctl --version | sed -n '1s/[^0-9]*\([0-9]*\).*/\1/p')
if [[ ! "$version" =~ ^[0-9]+$ ]] || (( version < 245 )); then
  echo 'Для ограниченного журнала Kizuna требуется systemd >=245.' >&2
  exit 1
fi
install -d -m 0700 -o kizuna -g kizuna /opt/kizuna/data/logs
install -d -m 0755 /etc/systemd/system/kizuna.service.d /etc/systemd/journald@kizuna.conf.d
install -m 0644 kizuna-observability.conf /etc/systemd/system/kizuna.service.d/observability.conf
install -m 0644 kizuna-journal-limits.conf /etc/systemd/journald@kizuna.conf.d/limits.conf
systemctl daemon-reload
# Apply new limits on later deployments too, before the application restarts.
systemctl try-restart systemd-journald@kizuna.service
