#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ $(id -u) == 0 && $(uname -s) == Linux ]] || { echo 'Запуск от root на сервере мониторинга после одобрения.' >&2; exit 1; }
cd "$(dirname "$0")"
root=/opt/kizuna-monitoring
image="$root/monitoring-data.ext4"
data="$root/data"
# A real reserved 6 GiB filesystem caps TSDB + WAL + compaction + Grafana + AM.
# Retention.size alone does not cap the Prometheus head/WAL.
install -d -m 0755 "$root" "$data"
if mountpoint -q "$data"; then
  source=$(findmnt -n -o SOURCE --target "$data")
  [[ "$source" == /dev/loop* ]] || { echo 'Ожидался отдельный loop filesystem; проверьте существующий mount.' >&2; exit 1; }
  [[ $(realpath "$(losetup -n -O BACK-FILE "$source")") == "$image" ]] || { echo 'Этот mount принадлежит другому образу. Ничего не меняю.' >&2; exit 1; }
elif [[ -e "$image" ]]; then
  echo 'Образ уже существует, но не смонтирован. Проверить mount unit вручную; форматирование запрещено.' >&2
  exit 1
else
  [[ -z $(find "$data" -mindepth 1 -maxdepth 1 -print -quit) ]] || { echo 'Каталог данных не пуст. Не монтирую поверх существующих данных.' >&2; exit 1; }
  free=$(df -B1 --output=avail "$root" | tail -n 1 | tr -d ' ')
  (( free >= 10737418240 )) || { echo 'Нужно минимум 10 ГиБ доступного места до резервирования 6 ГиБ.' >&2; exit 1; }
  fallocate -l 6G "$image"
  mkfs.ext4 -q -E nodiscard -m 0 "$image"
  unit=$(systemd-escape --path --suffix=mount "$data")
  cat > "/etc/systemd/system/$unit" <<EOF
[Unit]
Description=Bounded Kizuna monitoring data (6 GiB)
[Mount]
What=$image
Where=$data
Type=ext4
Options=loop,nodev,nosuid,noexec
[Install]
WantedBy=local-fs.target
EOF
  systemctl daemon-reload
  systemctl enable --now "$unit"
fi
# Formatting must preserve the reservation. Also repair images created by
# older installers whose default mkfs discard punched holes in the backing file.
# fallocate allocates holes without changing existing filesystem contents.
allocated=$(( $(stat -c %b "$image") * 512 ))
if (( allocated < 6442450944 )); then
  missing=$(( 6442450944 - allocated ))
  free=$(df -B1 --output=avail "$root" | tail -n 1 | tr -d ' ')
  (( free >= missing + 536870912 )) || { echo 'Недостаточно места для резервирования образа с запасом 512 МиБ.' >&2; exit 1; }
  fallocate -l 6G "$image"
fi
(( $(stat -c %b "$image") * 512 >= 6442450944 )) || { echo 'Образ не зарезервирован полностью.' >&2; exit 1; }
chown root:root "$image"
chmod 600 "$image" # Raw ext4 bytes contain private cache/Grafana state too.
install -d -m 0750 -o 65534 -g 65534 "$data/prometheus" "$data/alertmanager"
install -d -m 0700 -o 65534 -g 65534 "$data/admin-sync"
install -d -m 0755 "$root/config"
install -d -m 0750 -o 65534 -g 65534 "$root/config/alertmanager"
install -d -m 0750 -o 472 -g 472 "$data/grafana"
install -d -m 0755 /etc/systemd/journald@kizuna-monitoring.conf.d
install -m 0644 journald-monitoring.conf /etc/systemd/journald@kizuna-monitoring.conf.d/limits.conf
systemctl daemon-reload
systemctl try-restart systemd-journald@kizuna-monitoring.service
