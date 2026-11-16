#!/bin/sh
# The Cloudflare Workers example (examples/workers, docs/WORKERS.md), end to end: build the client
# and the subset, bundle the Worker as wrangler deploys it (its size), serve it with `wrangler dev`
# (workerd) and request a page, the page again, an address that names nothing and the stylesheet.
#   scripts/workers-check.sh [port]
set -e
cd "$(dirname "$0")/.."
port=${1:-8799}
npx vite build --config examples/hello/vite.config.ts --logLevel warn
mkdir -p examples/workers/build
node bin/semblance.mjs subset --config examples/hello/semblance.config.ts --out examples/workers/build/ontology.ttl
out=$(mktemp -d)
npx -y wrangler@4 deploy --dry-run --config examples/workers/wrangler.jsonc --outdir "$out" > "$out/deploy.log" 2>&1 || { cat "$out/deploy.log"; exit 1; }
grep -E "Total Upload" "$out/deploy.log" || true
npx -y wrangler@4 dev --config examples/workers/wrangler.jsonc --port "$port" --ip 127.0.0.1 > "$out/dev.log" 2>&1 &
dev=$!
trap 'kill $dev 2>/dev/null; pkill -P $dev 2>/dev/null || true' EXIT
for _ in $(seq 1 90); do grep -q "Ready on" "$out/dev.log" && break; sleep 1; done
fail=0
check() { # url status text
  got=$(curl -s -o "$out/page" -w "%{http_code} %{time_total}" "http://127.0.0.1:$port$1")
  echo "$1 -> $got"
  [ "${got%% *}" = "$2" ] || fail=1
  [ -z "$3" ] || grep -q "$3" "$out/page" || { echo "  missing: $3"; fail=1; }
}
check / 200 '<strong>0 cups</strong>'
check / 200 '<strong>0 cups</strong>'
check /nowhere/ 404
check /semblance.css 200 'ex-tally'
exit $fail
