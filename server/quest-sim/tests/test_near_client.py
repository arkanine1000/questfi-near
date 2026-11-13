"""NEAR transaction encoding and the JSON-RPC client, with no network.

The reference vectors were produced by an independent implementation
(py-near's Rust primitives) from the same inputs. Ed25519 signatures are
deterministic, so the bytes must match exactly. The signing key is derived
from a public test string and is not an account on any network.
"""

from __future__ import annotations

import base64
import hashlib
import json

import httpx
import pytest

from quest_sim.near.client import ContractError, TransportError, explorer_tx_url
from quest_sim.near.rpc import NearRpcClient
from quest_sim.near.tx import (
    KeyPair,
    b58decode,
    b58encode,
    sign_function_call,
    verify,
)

_SEED = hashlib.sha256(b"questfi-settler-test-vector").digest()
TEST_PUBLIC = "ed25519:2qXc2PvmqKUtAsz1ENyazKb1mzmrvfpMQ5A1ynbhNRPf"
BLOCK_HASH = "5wbD6GsVBReHetMUw17QcNne8BjB1xSKRoU4JYpafEx5"


def _test_secret() -> str:
    pub = KeyPair.from_secret("ed25519:" + b58encode(_SEED)).public_key
    return "ed25519:" + b58encode(_SEED + pub)


VECTORS = [
    {
        "nonce": 7,
        "method": "report_events",
        "args": b'{"season_id":"w-1a2b3c4d","seq":0,"events":'
                b'[{"kind":"kill","killer":"3","victim":"5"}]}',
        "gas": 100 * 10**12,
        "deposit": 0,
        "hash": "JCiETYCsLkzsHXyb75wFjxXzqMeqjcXkd5ndeFff5592",
        "signed": (
            "EAAAAG9wZXJhdG9yLnRlc3RuZXQAG0orbtoyTxS3PlApxTMQcJC9dPJBoYCXjA0Wlqmq"
            "BsoHAAAAAAAAAA8AAABxdWVzdGZpLnRlc3RuZXRJasqA5Njyn7jozYFsOvtI0/EDlws6"
            "LuFgDAjKZzJt7gEAAAACDQAAAHJlcG9ydF9ldmVudHNXAAAAeyJzZWFzb25faWQiOiJ3"
            "LTFhMmIzYzRkIiwic2VxIjowLCJldmVudHMiOlt7ImtpbmQiOiJraWxsIiwia2lsbGVy"
            "IjoiMyIsInZpY3RpbSI6IjUifV19AEB6EPNaAAAAAAAAAAAAAAAAAAAAAAAAACG1Z0H+"
            "TEYh9iuU6R5s9OdVi9MkVgGyNzpQA+nQOjcypVUCEtOtenHGuqywxXZrmJ40ODaqbQRh"
            "9olAN0Usjw0="
        ),
    },
    {
        "nonce": 123456789012,
        "method": "enter_season",
        "args": b'{"pass_id":"12","season_id":"w-1a2b3c4d"}',
        "gas": 30 * 10**12,
        "deposit": 10**24 + 1,  # above u64: exercises the u128 encoding
        "hash": "4FoHkCuQWr72AKN3GweUzxgMoL4Jgfakr47XuXWbjeth",
        "signed": (
            "EAAAAG9wZXJhdG9yLnRlc3RuZXQAG0orbtoyTxS3PlApxTMQcJC9dPJBoYCXjA0Wlqmq"
            "BsoUGpm+HAAAAA8AAABxdWVzdGZpLnRlc3RuZXRJasqA5Njyn7jozYFsOvtI0/EDlws6"
            "LuFgDAjKZzJt7gEAAAACDAAAAGVudGVyX3NlYXNvbikAAAB7InBhc3NfaWQiOiIxMiIs"
            "InNlYXNvbl9pZCI6InctMWEyYjNjNGQifQDgV+tIGwAAAQAAoe3MzhvC0wAAAAAAAAAA"
            "xiQ2EV7W8u99hfyJgPVJiw8TI+7hOQzaTp1WQW+BhRz0FSrwEdAgJ3kT1P4wtCoGQ85Z"
            "Kjwy4DTXeFsba70O"
        ),
    },
]


@pytest.mark.parametrize("vec", VECTORS, ids=lambda v: v["method"])
def test_signed_function_call_matches_reference_bytes(vec):
    key = KeyPair.from_secret(_test_secret())
    assert key.public_key_str == TEST_PUBLIC
    signed = sign_function_call(
        key,
        signer_id="operator.testnet",
        receiver_id="questfi.testnet",
        nonce=vec["nonce"],
        block_hash=b58decode(BLOCK_HASH),
        method_name=vec["method"],
        args=vec["args"],
        gas=vec["gas"],
        deposit=vec["deposit"],
    )
    assert signed.tx_hash == vec["hash"]
    assert signed.signed_b64 == vec["signed"]
    raw = base64.b64decode(signed.signed_b64)
    body, signature = raw[:-65], raw[-64:]
    assert verify(key.public_key, signature, hashlib.sha256(body).digest())


def test_key_parsing_accepts_both_lengths_and_never_echoes_the_secret():
    secret = _test_secret()
    assert KeyPair.from_secret(secret).public_key_str == TEST_PUBLIC
    assert KeyPair.from_secret("ed25519:" + b58encode(_SEED)).public_key_str == TEST_PUBLIC
    assert secret not in repr(KeyPair.from_secret(secret))

    tampered = "ed25519:" + b58encode(_SEED + bytes(32))
    for bad in (tampered, "ed25519:0OIl", "secp256k1:abc", "ed25519:" + b58encode(b"short")):
        with pytest.raises(ValueError) as info:
            KeyPair.from_secret(bad)
        assert bad.split(":")[-1] not in str(info.value)


def test_explorer_links_follow_the_network():
    assert explorer_tx_url("questfi.testnet", "abc") == "https://testnet.nearblocks.io/txns/abc"
    assert explorer_tx_url("questfi.near", "abc") == "https://nearblocks.io/txns/abc"


def test_base58_keeps_leading_zero_bytes():
    for data in (b"", b"\0", b"\0\0abc", bytes(range(32))):
        assert b58decode(b58encode(data)) == data


# ---------------------------------------------------------------------------
# The RPC client against a scripted RPC
# ---------------------------------------------------------------------------


class ScriptedRpc:
    """Answers JSON-RPC requests from a table of handlers, recording them."""

    def __init__(self):
        self.requests: list[dict] = []
        self.nonce = 41
        self.send_results: list = []  # popped per send_tx; dict = result, str = error name
        self.tx_results: list = []
        self.account_amount: int | None = 7 * 10**24  # None: the account does not exist

    def handler(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        self.requests.append(body)
        method, params = body["method"], body["params"]

        def ok(result):
            return httpx.Response(200, json={"jsonrpc": "2.0", "id": body["id"], "result": result})

        def err(name, data=None):
            return httpx.Response(200, json={
                "jsonrpc": "2.0", "id": body["id"],
                "error": {"name": "HANDLER_ERROR", "cause": {"name": name},
                          "code": -32000, "message": "Server error", "data": data},
            })

        if method == "query" and params["request_type"] == "view_access_key":
            return ok({"nonce": self.nonce, "permission": "FullAccess",
                       "block_height": 1, "block_hash": BLOCK_HASH})
        if method == "query" and params["request_type"] == "view_account":
            if self.account_amount is None:
                return err("UNKNOWN_ACCOUNT")
            return ok({"amount": str(self.account_amount), "locked": "0", "storage_usage": 500,
                       "block_height": 1, "block_hash": BLOCK_HASH})
        if method == "query" and params["request_type"] == "call_function":
            if params["method_name"] == "missing":
                return ok({"error": "wasm execution failed with error: MethodNotFound",
                           "logs": [], "block_height": 1, "block_hash": BLOCK_HASH})
            payload = json.dumps({"status": "Running", "echo": params["args_base64"]}).encode()
            return ok({"result": list(payload), "logs": [], "block_height": 1,
                       "block_hash": BLOCK_HASH})
        if method == "send_tx":
            item = self.send_results.pop(0)
            if isinstance(item, tuple):
                return err(*item)
            return ok(item)
        if method == "tx":
            item = self.tx_results.pop(0)
            if isinstance(item, tuple):
                return err(*item)
            return ok(item)
        return err("METHOD_NOT_FOUND")


def _success(value) -> dict:
    raw = b"" if value is None else json.dumps(value).encode()
    return {
        "final_execution_status": "EXECUTED_OPTIMISTIC",
        "status": {"SuccessValue": base64.b64encode(raw).decode()},
        "transaction": {},
        "transaction_outcome": {},
        "receipts_outcome": [{"outcome": {"logs": ["EVENT_JSON:{}"]}}],
    }


def _client(rpc: ScriptedRpc) -> NearRpcClient:
    return NearRpcClient(
        rpc_url="https://rpc.invalid",
        contract_id="questfi.testnet",
        account_id="operator.testnet",
        secret_key=_test_secret(),
        poll_interval_s=0.0,
        http=httpx.AsyncClient(transport=httpx.MockTransport(rpc.handler)),
    )


async def test_call_signs_with_next_nonce_and_decodes_the_return_value():
    rpc = ScriptedRpc()
    rpc.send_results = [_success({"applied": 1, "skipped": 0, "next_seq": 1})]
    client = _client(rpc)
    result = await client.call("report_events", {"season_id": "w-1", "seq": 0, "events": []})
    assert result.value == {"applied": 1, "skipped": 0, "next_seq": 1}
    assert result.logs == ("EVENT_JSON:{}",)

    send = next(r for r in rpc.requests if r["method"] == "send_tx")
    assert send["params"]["wait_until"] == "EXECUTED_OPTIMISTIC"
    raw = base64.b64decode(send["params"]["signed_tx_base64"])
    # nonce sits after signer (4+16), key type (1) and key (32)
    assert int.from_bytes(raw[53:61], "little") == rpc.nonce + 1
    assert result.tx_hash == b58encode(hashlib.sha256(raw[:-65]).digest())


async def test_contract_panic_is_a_contract_error_with_its_message():
    rpc = ScriptedRpc()
    rpc.send_results = [{
        "status": {"Failure": {"ActionError": {"index": 0, "kind": {"FunctionCallError": {
            "ExecutionError": "Smart contract panicked: season is Settled"}}}}},
        "receipts_outcome": [],
    }]
    with pytest.raises(ContractError) as info:
        await _client(rpc).call("settle_season", {"season_id": "w-1", "winner_pass": None})
    assert "season is Settled" in str(info.value)
    assert info.value.tx_hash


async def test_rpc_timeout_polls_the_transaction_before_giving_up():
    rpc = ScriptedRpc()
    rpc.send_results = [("TIMEOUT_ERROR",)]
    rpc.tx_results = [("UNKNOWN_TRANSACTION",), _success(None)]
    result = await _client(rpc).call("start_season", {"season_id": "w-1"})
    assert result.value is None
    assert [r["method"] for r in rpc.requests].count("tx") == 2

    rpc.send_results = [("TIMEOUT_ERROR",)]
    rpc.tx_results = [("UNKNOWN_TRANSACTION",)] * 4
    with pytest.raises(TransportError) as info:
        await _client(rpc).call("start_season", {"season_id": "w-1"})
    assert info.value.tx_hash  # outcome unknown, but the hash is known


async def test_invalid_nonce_is_retryable_and_raises_the_nonce_floor():
    rpc = ScriptedRpc()
    client = _client(rpc)
    rpc.send_results = [(
        "INVALID_TRANSACTION",
        {"TxExecutionError": {"InvalidTxError": {"InvalidNonce": {"tx_nonce": 42, "ak_nonce": 90}}}},
    ), _success(None)]
    with pytest.raises(TransportError):
        await client.call("lock_market", {"season_id": "w-1"})
    await client.call("lock_market", {"season_id": "w-1"})
    raw = base64.b64decode(
        [r for r in rpc.requests if r["method"] == "send_tx"][-1]["params"]["signed_tx_base64"]
    )
    assert int.from_bytes(raw[53:61], "little") == 91


async def test_view_decodes_json_and_reports_a_panicking_view():
    rpc = ScriptedRpc()
    client = _client(rpc)
    got = await client.view("get_season", {"season_id": "w-1"})
    assert got["status"] == "Running"
    assert json.loads(base64.b64decode(got["echo"])) == {"season_id": "w-1"}
    with pytest.raises(ContractError):
        await client.view("missing", {})


async def test_account_balance_reads_the_operator_account():
    rpc = ScriptedRpc()
    assert await _client(rpc).account_balance() == 7 * 10**24
    query = rpc.requests[-1]["params"]
    assert query["request_type"] == "view_account"
    assert query["account_id"] == "operator.testnet"

    rpc.account_amount = None
    with pytest.raises(TransportError):  # retried, like a missing access key
        await _client(rpc).account_balance()


async def test_unreachable_rpc_is_a_transport_error():
    def refuse(request):
        raise httpx.ConnectError("refused", request=request)

    client = NearRpcClient(
        rpc_url="https://rpc.invalid", contract_id="questfi.testnet",
        account_id="operator.testnet", secret_key=_test_secret(),
        http=httpx.AsyncClient(transport=httpx.MockTransport(refuse)),
    )
    with pytest.raises(TransportError):
        await client.view("get_season", {"season_id": "w-1"})
    with pytest.raises(TransportError):
        await client.call("start_season", {"season_id": "w-1"})
