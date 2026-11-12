#!/usr/bin/env python
"""Check the NEAR settlement settings against the chain, with the same
client the server uses.

    python scripts/near_smoke.py                    # read-only checks
    python scripts/near_smoke.py --send             # + one signed create_season
    python scripts/near_smoke.py --send --method cancel_season \\
        --args '{"season_id": "smoke-1731400000"}'

Reads QUEST_SIM_NEAR_CONTRACT_ID, _OPERATOR_ID, _OPERATOR_KEY, _RPC_URL and
_ENTRY_STAKE from the environment or .env (QUEST_SIM_NEAR_ENABLED is not
needed). Read-only by default: it looks up the operator key's access key
record and makes one view call. Only with --send does it sign and send a
transaction, and it prints the transaction hash and outcome. The secret
key is never printed; the public key is, so you can check which one is in
use.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from quest_sim.config import Settings
from quest_sim.near.client import ContractError, NearError
from quest_sim.near.rpc import NearRpcClient


def _explorer(rpc_url: str, tx_hash: str) -> str:
    host = "testnet.nearblocks.io" if "testnet" in rpc_url else "nearblocks.io"
    return f"https://{host}/txns/{tx_hash}"


def _json_arg(text: str) -> dict:
    value = json.loads(text)
    if not isinstance(value, dict):
        raise argparse.ArgumentTypeError("arguments must be a JSON object")
    return value


async def run(args: argparse.Namespace) -> int:
    settings = Settings()
    if not settings.near_contract_id:
        print("QUEST_SIM_NEAR_CONTRACT_ID is not set")
        return 2
    secret = settings.near_operator_key.get_secret_value() if settings.near_operator_key else None
    try:
        client = NearRpcClient(
            rpc_url=settings.near_rpc_url,
            contract_id=settings.near_contract_id,
            account_id=settings.near_operator_id,
            secret_key=secret,
        )
    except ValueError as e:
        print(f"QUEST_SIM_NEAR_OPERATOR_KEY is not usable: {e}")
        return 2

    print(f"rpc       {settings.near_rpc_url}")
    print(f"contract  {settings.near_contract_id}")
    print(f"operator  {settings.near_operator_id or '(not set)'}")
    print(f"key       {client.public_key or '(not set)'}")
    status = 0
    try:
        if client.public_key and settings.near_operator_id:
            try:
                key = await client.access_key()
                print(f"access key: nonce {key['nonce']}, permission {json.dumps(key['permission'])}")
            except NearError as e:
                print(f"access key: NOT USABLE: {e}")
                status = 1

        view_args = args.view_args if args.view_args is not None else {}
        try:
            got = await client.view(args.view, view_args)
            print(f"view {args.view}({json.dumps(view_args)}) -> {json.dumps(got, indent=2)}")
        except NearError as e:
            print(f"view {args.view} failed: {type(e).__name__}: {e}")
            status = 1

        if not args.send:
            print("\nread-only run; pass --send to sign and send one call")
            return status
        if not (client.public_key and settings.near_operator_id):
            print("--send needs QUEST_SIM_NEAR_OPERATOR_ID and QUEST_SIM_NEAR_OPERATOR_KEY")
            return 2

        method = args.method
        call_args = args.args
        if call_args is None:
            if method != "create_season":
                print("--args is required for any method other than create_season")
                return 2
            call_args = {
                "season_id": f"smoke-{int(time.time())}",
                "entry_stake": str(settings.near_entry_stake or 0),
            }
        print(f"\nsending {method}({json.dumps(call_args)}) deposit={args.deposit} yocto ...")
        try:
            result = await client.call(method, call_args, deposit_yocto=args.deposit)
        except ContractError as e:
            print(f"REJECTED by the contract: {e}")
            if e.tx_hash:
                print(f"tx        {e.tx_hash}\nexplorer  {_explorer(settings.near_rpc_url, e.tx_hash)}")
            return 1
        except NearError as e:
            print(f"NOT CONFIRMED: {type(e).__name__}: {e}")
            if e.tx_hash:
                print(f"tx        {e.tx_hash} (outcome unknown; look it up before retrying)")
            return 1
        print("ok")
        print(f"tx        {result.tx_hash}")
        print(f"explorer  {_explorer(settings.near_rpc_url, result.tx_hash)}")
        print(f"returned  {json.dumps(result.value)}")
        for line in result.logs:
            print(f"log       {line}")
        if method == "create_season" and args.args is None:
            season = await client.view("get_season", {"season_id": call_args["season_id"]})
            print(f"get_season -> {json.dumps(season, indent=2)}")
            print(
                "\nThat season is a test entry; cancel it with:\n"
                f"  python scripts/near_smoke.py --send --method cancel_season "
                f"--args '{json.dumps({'season_id': call_args['season_id']})}'"
            )
        return status
    finally:
        await client.aclose()


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--view", default="get_config", help="view method (default get_config)")
    parser.add_argument("--view-args", type=_json_arg, default=None, help="JSON object")
    parser.add_argument("--send", action="store_true", help="sign and send one call")
    parser.add_argument("--method", default="create_season", help="method for --send")
    parser.add_argument("--args", type=_json_arg, default=None, help="JSON object for --send")
    parser.add_argument("--deposit", type=int, default=0, help="yoctoNEAR to attach")
    return asyncio.run(run(parser.parse_args()))


if __name__ == "__main__":
    raise SystemExit(main())
