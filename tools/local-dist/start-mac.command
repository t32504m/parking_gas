#!/bin/bash
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js が見つかりません。README.txt の「用意するもの」を見て、Node.js を入れてください。"
  read -n 1
  exit 1
fi
LOCAL_OPEN=1 node tools/serve-local.js
