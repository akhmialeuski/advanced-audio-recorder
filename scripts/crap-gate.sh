#!/usr/bin/env bash
# Score the CRAP of every src/ function from the last Jest coverage run, against crap-baseline.json.
# Coverage itself stays with scripts/coverage-diff.mjs, so the gate checks CRAP only (--skip-coverage).
# Run npm run test:coverage first. Pass --update-baseline after a green run to record improvements.
set -euo pipefail

root="$(git rev-parse --show-toplevel)"
cd "${root}"

coverage="coverage/coverage-final.json"
if [[ ! -f ${coverage} ]]; then
  echo "crap-gate: ${coverage} is missing. Run npm run test:coverage first." >&2
  exit 2
fi

work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT

# complexity at 0 reports every function with its score. An empty suppressions file keeps the
# size-limit baseline in eslint-suppressions.json from hiding any of those reports.
echo '{}' >"${work}/no-suppressions.json"
npx eslint src --suppressions-location "${work}/no-suppressions.json" \
  --rule '{"complexity": ["error", 0]}' --format json >"${work}/eslint.json" || true

python3 scripts/crap_gate.py crap --eslint-json "${work}/eslint.json" --istanbul "${coverage}" \
  --threshold 8 --skip-coverage --baseline crap-baseline.json "$@"
