#!/bin/bash
# bitmagnet 健康概览：DHT 节点状态 + 库内种子/分类计数
# 需要当前用户能免密执行 docker：加入 docker 组即可（sudo usermod -aG docker $USER）
set -u
CONTAINER=${BITMAGNET_CONTAINER:-bitmagnet-postgres}
GRAPHQL=${BITMAGNET_GRAPHQL:-http://localhost:3333/graphql}

STATUS=$(curl -s "$GRAPHQL" -H "Content-Type: application/json" \
  -d '{"query":"{ health { checks { key status } } }"}' 2>/dev/null)
DHT=$(echo "$STATUS" | python3 -c "import sys,json;d=json.load(sys.stdin);print([c['status'] for c in d['data']['health']['checks'] if c['key']=='dht'][0])" 2>/dev/null)
TORRENTS=$(docker exec "$CONTAINER" psql -U postgres -d bitmagnet -t -c 'SELECT count(*) FROM torrents;' 2>/dev/null | tr -d '[:space:]')
CLASSIFIED=$(docker exec "$CONTAINER" psql -U postgres -d bitmagnet -t -c 'SELECT count(*) FROM torrent_contents;' 2>/dev/null | tr -d '[:space:]')
echo "DHT:${DHT:-unknown} torrents:${TORRENTS:-0} classified:${CLASSIFIED:-0}"
