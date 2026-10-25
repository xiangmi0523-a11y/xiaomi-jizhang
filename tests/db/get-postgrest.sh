#!/usr/bin/env bash
# 下载测试用的 PostgREST（固定版本 + 校验和），放在仓库外的缓存目录
set -euo pipefail
VER=v12.2.3
SHA=9f71269e61ac3a940281e93ff415760f5957e430e475ba4c3889f3ede7d5527c
DIR="${XM_CACHE_DIR:-$HOME/.cache/xm-tests}"
BIN="$DIR/postgrest"
if [ -x "$BIN" ] && "$BIN" --version | grep -q "${VER#v}"; then echo "$BIN"; exit 0; fi
mkdir -p "$DIR"
curl -sSfL -o "$DIR/pgrst.tar.xz" "https://github.com/PostgREST/postgrest/releases/download/$VER/postgrest-$VER-linux-static-x64.tar.xz"
echo "$SHA  $DIR/pgrst.tar.xz" | sha256sum -c - >&2
tar -xJf "$DIR/pgrst.tar.xz" -C "$DIR"
echo "$BIN"
