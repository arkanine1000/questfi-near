#!/usr/bin/env bash
# Seeds a deployed QuestFi contract on NEAR testnet, so a season can run:
#
#   1. registers the game server's account as an operator
#   2. lists the four house agents for rent
#   3. mints one house pass per hosted agent from the operator account, funds
#      it, and lifts its caps (the operator enters these passes itself)
#   4. writes the agent name -> pass id map the game server reads
#
# It can be run again: each step looks at the contract first and does only
# what is missing.
#
#   CONTRACT=<contract> OWNER=<contract owner> OPERATOR=<game server account> \
#     scripts/seed-testnet.sh
#
# Needs near-cli-rs (`near`), curl and jq. The owner's and the operator's keys
# are read from the legacy keychain (~/.near-credentials).
set -euo pipefail

: "${CONTRACT:?set CONTRACT to the contract account}"
: "${OWNER:?set OWNER to the contract owner account}"
: "${OPERATOR:?set OPERATOR to the game server account}"
RPC=${RPC:-https://test.rpc.fastnear.com}
# The near-cli-rs network connection to send through.
NETWORK=${NETWORK:-testnet}
OUT=${OUT:-server/quest-sim/near_passes.json}

# Rental prices, in yoctoNEAR (0.04 and 0.06 NEAR).
PRICE_LOW=${PRICE_LOW:-40000000000000000000000}
PRICE_HIGH=${PRICE_HIGH:-60000000000000000000000}
# What each house pass is minted with: the mint fee plus its starting balance.
HOUSE_DEPOSIT=${HOUSE_DEPOSIT:-0.25 NEAR}
# Caps for house passes, in yoctoNEAR (10 and 1000 NEAR): the operator plays
# them in every season, so the daily limit of a visitor's pass would stop it.
HOUSE_PER_CALL=${HOUSE_PER_CALL:-10000000000000000000000000}
HOUSE_DAILY=${HOUSE_DAILY:-1000000000000000000000000000}
# The game server's hosted cast, in the order it fills seats.
HOUSE_AGENTS=${HOUSE_AGENTS:-Kell Marra Dain Vex Bren Sorsha Tamsin Aldric Grix Yara}

view() { # view <method> <json args> -> the JSON the contract returns
  local args
  args=$(printf '%s' "$2" | base64 | tr -d '\n')
  curl -sS "$RPC" -H 'Content-Type: application/json' -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"call_function\",\"finality\":\"final\",\"account_id\":\"$CONTRACT\",\"method_name\":\"$1\",\"args_base64\":\"$args\"}}" \
    | jq -e -r '.result.result | implode | fromjson'
}

call() { # call <signer> <method> <json args> [deposit]
  local out attempt
  for attempt in 1 2 3; do
    if out=$(near contract call-function as-transaction "$CONTRACT" "$2" json-args "$3" \
      prepaid-gas '50 Tgas' attached-deposit "${4:-0 NEAR}" \
      sign-as "$1" network-config "$NETWORK" sign-with-legacy-keychain send 2>&1); then
      sleep 2 # let the change reach a final block before the next read
      return 0
    fi
    sleep 3
  done
  echo "$2 failed:" >&2
  echo "$out" | tail -n 12 >&2
  return 1
}

echo "contract $CONTRACT"

# 1. operator
if view get_operators '{}' | jq -e --arg a "$OPERATOR" 'index($a) != null' >/dev/null; then
  echo "operator  $OPERATOR (already registered)"
else
  call "$OWNER" add_operator "{\"account_id\":\"$OPERATOR\"}"
  echo "operator  $OPERATOR registered"
fi

# 2. roster
roster() { # roster <id> <name> <price> <blurb>
  if view get_roster '{}' | jq -e --arg id "$1" --arg price "$3" 'any(.[]; .roster_id == $id and .price == $price)' >/dev/null; then
    echo "roster    $2 (already listed)"
  else
    call "$OWNER" set_roster "$(jq -cn --arg id "$1" --arg name "$2" --arg blurb "$4" --arg price "$3" '{roster_id: $id, name: $name, blurb: $blurb, price: $price}')"
    echo "roster    $2 listed"
  fi
}
roster mimir MIMIR "$PRICE_LOW" 'Market oracle. Plays the odds, loots late.'
roster cassandra CASSANDRA "$PRICE_LOW" 'Sees the loss coming. Goes in anyway.'
roster roko ROKO "$PRICE_HIGH" 'Berserker. First into every dungeon.'
roster aegis AEGIS "$PRICE_HIGH" 'Armoured and patient. Wins by outlasting.'

# 3. house passes
read -r -a agents <<<"$HOUSE_AGENTS"
owned() { view nft_tokens_for_owner "{\"account_id\":\"$OPERATOR\",\"from_index\":\"0\",\"limit\":100}" | jq -c '[.[].token_id]'; }
have=$(owned | jq 'length')
while [ "$have" -lt "${#agents[@]}" ]; do
  call "$OPERATOR" mint_pass '{}' "$HOUSE_DEPOSIT"
  have=$(owned | jq 'length')
  echo "pass      minted ($have of ${#agents[@]})"
done
ids=$(owned)
for i in "${!agents[@]}"; do
  id=$(jq -r --argjson i "$i" '.[$i]' <<<"$ids")
  if view get_pass "{\"pass_id\":\"$id\"}" | jq -e --arg d "$HOUSE_DAILY" '.policy.daily_limit == $d' >/dev/null; then
    continue
  fi
  call "$OPERATOR" set_policy "{\"pass_id\":\"$id\",\"per_call_cap\":\"$HOUSE_PER_CALL\",\"daily_limit\":\"$HOUSE_DAILY\"}" '1 yoctoNEAR'
  echo "pass      #$id caps lifted for ${agents[$i]}"
done

# 4. the map the game server reads
jq -n --argjson ids "$ids" --args '[$ARGS.positional, $ids] | transpose | map({(.[0]): .[1]}) | add' "${agents[@]}" >"$OUT"
echo "wrote     $OUT"
jq -c . "$OUT"
