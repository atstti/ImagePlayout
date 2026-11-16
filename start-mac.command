#!/bin/bash
cd "$(dirname "$0")" || exit 1
command -v node >/dev/null || { echo 'Node.js 22以降をインストールしてください'; read -r; exit 1; }
npm ci && npm start
read -r -p '終了しました。Enterで閉じます。'
