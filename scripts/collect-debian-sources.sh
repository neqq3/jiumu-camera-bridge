#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Run in a disposable copy of the exact runtime image. Download; never build sources.
set -eu
test -f /out/source-packages.tsv
mkdir -p /out/debian
sed -i 's/^Types: deb$/Types: deb deb-src/' /etc/apt/sources.list.d/debian.sources
apt-get update > /out/apt-update.log 2>&1
failed=0
tab=$(printf '\t')
while IFS="$tab" read -r package version; do
  case "$package" in ''|*[!a-z0-9+.-]*) echo 'Invalid source package'; exit 1 ;; esac
  case "$version" in ''|*[!a-zA-Z0-9.+:~_-]*) echo 'Invalid source version'; exit 1 ;; esac
  mkdir -p "/out/debian/$package"
  if (cd "/out/debian/$package" && timeout --kill-after=5s 120s apt-get source --download-only --only-source "$package=$version") > "/out/debian/$package/download.log" 2>&1; then
    printf 'source ready: %s\n' "$package"
  else
    printf '%s\t%s\n' "$package" "$version" >> /out/missing-sources.tsv
    printf 'source unavailable: %s\n' "$package"
    failed=1
  fi
done < /out/source-packages.tsv
exit "$failed"
