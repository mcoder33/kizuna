#!/usr/bin/env bash
set -euo pipefail
[[ $(id -u) == 0 && $(uname -s) == Linux ]] || { echo 'Запуск от root на Linux VM после одобренного релиза.' >&2; exit 1; }
cd "$(dirname "$0")"
bash ../install-observability.sh
version=1.12.1
case "$(uname -m)" in x86_64) arch=amd64;; aarch64) arch=arm64;; *) echo 'Неподдерживаемая архитектура.' >&2; exit 1;; esac
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
archive="node_exporter-${version}.linux-${arch}.tar.gz"
base="https://github.com/prometheus/node_exporter/releases/download/v${version}"
curl --fail --location --proto '=https' --tlsv1.2 "$base/$archive" -o "$scratch/$archive"
curl --fail --location --proto '=https' --tlsv1.2 "$base/sha256sums.txt" -o "$scratch/checksums"
(cd "$scratch"; awk -v archive="$archive" '$2 == archive { print }' checksums > expected; [[ -s expected ]]; sha256sum --check expected)
tar -xzf "$scratch/$archive" -C "$scratch"
id kizuna-exporter >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin kizuna-exporter
install -m 0755 "$scratch/node_exporter-${version}.linux-${arch}/node_exporter" /usr/local/bin/kizuna-node-exporter
install -m 0644 kizuna-node-exporter.service /etc/systemd/system/kizuna-node-exporter.service
systemctl daemon-reload
systemctl enable --now kizuna-node-exporter.service
systemctl restart kizuna-node-exporter.service
