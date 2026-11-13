#!/usr/bin/env bash
# Checks the published QuestFi NEAR entry from outside, read-only: no login,
# no account, no key, nothing installed but bash, curl, jq and the coreutils
# base64 and sha256sum (or shasum). It reads the contract over NEAR's public
# RPC, asks the game server for its open season, and checks that the site's
# three apps and its test-account endpoint answer. Nothing is signed or sent.
#
#   scripts/check-public.sh
#   SITE=https://questfi-near.vercel.app scripts/check-public.sh
#
# Prints one "ok" or "FAIL" line per step. Exit code 0 when every step
# passed, 1 when any failed. docs/try-it.md has each step as a plain command.
set -u

# What this repository says is deployed.
CONTRACT=pass.questfi.testnet
CODE_HASH=93fJ8Fv1HLottZXcAjsjkAj1Ty8ZrCKYH77biVJJ1hW4
WASM_SHA256=778bf52679a4c840a757b6d55057767bf2da49332b2588208b39d826ea59a565
COMMIT=1b1c088d08ee48ad756f95a07ed0da1f7dbf2ceb
OPERATOR=operator.questfi.testnet

# Where it runs. Override any of these from the environment.
SITE=${SITE:-https://near.questfi.ai}
GAME=${GAME:-https://quest-sim-near-production.up.railway.app}
RPC=${RPC:-https://test.rpc.fastnear.com}
SITE=${SITE%/}
GAME=${GAME%/}

for tool in curl jq base64; do
  command -v "$tool" >/dev/null || { echo "FAIL  needs $tool"; exit 1; }
done
if command -v sha256sum >/dev/null; then sha256() { sha256sum | cut -d' ' -f1; }
elif command -v shasum >/dev/null; then sha256() { shasum -a 256 | cut -d' ' -f1; }
else echo "FAIL  needs sha256sum or shasum"; exit 1
fi

failed=0
ok() { printf 'ok    %s\n' "$1"; [ $# -lt 2 ] || printf '        %s\n' "$2"; }
fail() { printf 'FAIL  %s\n' "$1"; [ $# -lt 2 ] || printf '        %s\n' "$2"; failed=1; }

# curl with a few retries on network errors. An HTTP error status is not
# retried: it is an answer.
fetch() { curl -sS --max-time 30 --retry 3 --retry-all-errors --retry-delay 2 "$@"; }

# NEAR JSON-RPC "query". $1 is the params object; prints the result.
rpc() {
  fetch "$RPC" -H 'Content-Type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":\"check\",\"method\":\"query\",\"params\":$1}" | jq -c '.result'
}
# A view method of the contract. $1 method, $2 JSON arguments.
view() {
  local args
  args=$(printf '%s' "$2" | base64 | tr -d '\n')
  rpc "{\"request_type\":\"call_function\",\"finality\":\"final\",\"account_id\":\"$CONTRACT\",\"method_name\":\"$1\",\"args_base64\":\"$args\"}" |
    jq -c '.result | implode | fromjson'
}
# jq with `near`: a yoctoNEAR string as NEAR, exact, at most 6 decimals.
NEAR='def near: tostring | ("0" * ([25 - length, 0] | max)) + . | .[:-24] + "." + .[-24:-18] | sub("0+$"; "") | sub("\\.$"; "");'
jqn() { jq -r "$NEAR $1"; }

echo "contract $CONTRACT  rpc $RPC"
echo "site     $SITE"
echo "game     $GAME"
echo

# The code on the account is the build this repository names.
account=$(rpc "{\"request_type\":\"view_account\",\"finality\":\"final\",\"account_id\":\"$CONTRACT\"}")
got=$(jq -r '.code_hash // empty' <<<"$account" 2>/dev/null)
if [ "$got" = "$CODE_HASH" ]; then ok "the contract's code hash is $CODE_HASH"
else fail "the contract's code hash" "expected $CODE_HASH, got ${got:-no answer}"
fi

# That hash is the SHA-256 of the wasm, which CI prints in hex.
got=$(rpc "{\"request_type\":\"view_code\",\"finality\":\"final\",\"account_id\":\"$CONTRACT\"}" |
  jq -r '.code_base64 // empty' | base64 -d 2>/dev/null | sha256)
if [ "$got" = "$WASM_SHA256" ]; then ok "the deployed wasm's SHA-256 is $WASM_SHA256"
else fail "the deployed wasm's SHA-256" "expected $WASM_SHA256, got ${got:-no answer}"
fi

# NEP-330 source metadata, embedded at build time, names the commit.
meta=$(view contract_source_metadata '{}' 2>/dev/null)
snap=$(jq -r '.build_info.source_code_snapshot // empty' <<<"$meta" 2>/dev/null)
image=$(jq -r '.build_info.build_environment // empty' <<<"$meta" 2>/dev/null)
if [ "${snap##*rev=}" = "$COMMIT" ] && [ -n "$image" ]; then
  ok "contract_source_metadata names commit $COMMIT" "build image ${image%%@*}"
else fail "contract_source_metadata names commit $COMMIT" "got ${snap:-no answer}"
fi

# The configuration the contract runs with.
config=$(view get_config '{}' 2>/dev/null)
if jq -e '.default_per_call_cap and .default_daily_limit and .mint_storage_fee and .min_bet and .claim_burn' <<<"$config" >/dev/null 2>&1; then
  ok "get_config answers" "$(jqn '"agent caps \(.default_per_call_cap | near) NEAR per call and \(.default_daily_limit | near) per day, mint fee \(.mint_storage_fee | near), min bet \(.min_bet | near), card burn \(.claim_burn | near)"' <<<"$config")"
else fail "get_config answers" "${config:-no answer}"
fi

# The game server is the contract's operator.
ops=$(view get_operators '{}' 2>/dev/null)
if jq -e --arg op "$OPERATOR" 'index($op) != null' <<<"$ops" >/dev/null 2>&1; then ok "the operator is $OPERATOR"
else fail "the operator is $OPERATOR" "get_operators: ${ops:-no answer}"
fi

# The house agents a pass can rent.
roster=$(view get_roster '{}' 2>/dev/null)
if jq -e 'length > 0' <<<"$roster" >/dev/null 2>&1; then
  ok "the roster has $(jq length <<<"$roster") house agents" "$(jqn '[.[] | "\(.name) \(.price | near)"] | join(", ") + " NEAR"' <<<"$roster")"
else fail "the roster has house agents" "get_roster: ${roster:-no answer}"
fi

# Passes are NEP-171 tokens.
nft=$(view nft_metadata '{}' 2>/dev/null)
supply=$(view nft_total_supply '{}' 2>/dev/null)
if [ "$(jq -r '.spec // empty' <<<"$nft" 2>/dev/null)" = "nft-1.0.0" ]; then
  ok "passes are NEP-171 tokens: $(jq -r '.name' <<<"$nft") ($(jq -r '.symbol' <<<"$nft")), $(jq -r . <<<"$supply") minted"
else fail "passes are NEP-171 tokens" "nft_metadata: ${nft:-no answer}"
fi

# The contract's books: it holds at least what it owes.
books=$(view get_accounting '{}' 2>/dev/null)
if jq -e '.solvent == true' <<<"$books" >/dev/null 2>&1; then
  ok "get_accounting: solvent" "$(jqn '"owes \(.owed_total | near) NEAR and holds \(.account_balance | near), of which \(.storage_reserved | near) pays for storage"' <<<"$books")"
else fail "get_accounting: solvent" "${books:-no answer}"
fi

# The contract account keeps a full-access key, so fixes can be deployed.
keys=$(rpc "{\"request_type\":\"view_access_key_list\",\"finality\":\"final\",\"account_id\":\"$CONTRACT\"}")
full=$(jq '[.keys[]? | select(.access_key.permission == "FullAccess")] | length' <<<"$keys" 2>/dev/null)
if [ "${full:-0}" -gt 0 ]; then ok "the contract account holds $full full-access key(s): its code can be redeployed"
else fail "the contract account's keys" "${keys:-no answer}"
fi

# The game server names the season open for entry, on this contract.
arena=$(fetch "$GAME/near/arena" 2>/dev/null)
season=$(jq -r '.world_id // empty' <<<"$arena" 2>/dev/null)
if jq -e --arg c "$CONTRACT" '.enabled == true and .contract_id == $c and .world_id != null' <<<"$arena" >/dev/null 2>&1; then
  ok "the game server's open season is $season" "$(jqn '"entry stake \(.entry_stake | near) NEAR, \(.lobby.seats_taken) of \(.lobby.seats_total) seats taken, waiting for \(.lobby.waiting_for); last season won by \(.last.winner_name // "nobody yet")"' <<<"$arena")"
else fail "the game server names an open season on $CONTRACT" "GET $GAME/near/arena: ${arena:-no answer}"
fi

# The contract has that season (unless the server is still opening it).
if [ -n "$season" ]; then
  chain=$(view get_season "{\"season_id\":\"$season\"}" 2>/dev/null)
  status=$(jq -r '.status // empty' <<<"$chain" 2>/dev/null)
  if [ "$status" = "Open" ] || [ "$status" = "Running" ]; then
    ok "season $season is $status on the contract" "$(jqn '"entry stake \(.entry_stake | near) NEAR, \(.entrants | length) entrants, pot \(.pot | near) NEAR"' <<<"$chain")"
  elif [ -z "$status" ] && [ "$(jq -r '.lobby.waiting_for' <<<"$arena")" = "chain" ]; then
    ok "season $season is being opened on the contract by the game server"
  else fail "season $season on the contract" "get_season: ${chain:-no answer}"
  fi
else fail "season on the contract" "no season named by the game server"
fi

# The site serves the three apps from one origin.
for app in "/|Agent Access|the start app" "/world/|Agent World|Agent World" "/island/|Agent Island|the island spectator"; do
  IFS='|' read -r path title name <<<"$app"
  page=$(fetch -w '\n%{http_code}' "$SITE$path" 2>/dev/null)
  code=${page##*$'\n'}
  if [ "$code" = "200" ] && grep -q "<title>[^<]*$title" <<<"$page"; then ok "$SITE$path serves $name"
  else fail "$SITE$path serves $name" "HTTP ${code:-no answer}"
  fi
done

# The start app on the site is built for this contract and game server.
bundle=$(fetch "$SITE/" 2>/dev/null | grep -o 'src="[^"]*assets/[^"]*\.js"' | head -1 | sed 's/^src="//; s/"$//; s#^\./##; s#^/##')
js=$(fetch "$SITE/$bundle" 2>/dev/null)
if [ -n "$bundle" ] && grep -q "$CONTRACT" <<<"$js" && grep -q "${GAME#https://}" <<<"$js"; then
  ok "the start app on the site calls $CONTRACT and ${GAME#https://}"
else fail "the start app on the site calls $CONTRACT and ${GAME#https://}" "bundle ${bundle:-not found}"
fi

# The test-account endpoint is up and configured. A malformed key is
# refused before anything happens, so this creates no account.
answer=$(fetch -X POST "$SITE/api/guest" -H 'Content-Type: application/json' -d '{"publicKey":"not-a-key"}' 2>/dev/null)
if [ "$(jq -r '.error // empty' <<<"$answer" 2>/dev/null)" = "bad_key" ]; then
  ok "$SITE/api/guest answers and checks the key it is given" "$(jq -r .message <<<"$answer")"
else fail "$SITE/api/guest answers" "${answer:-no answer}"
fi

echo
if [ "$failed" = 0 ]; then echo "all checks passed"; else echo "some checks FAILED"; fi
exit "$failed"
