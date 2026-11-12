"""A small NEAR JSON-RPC client: views, and signed function calls.

Signing happens here, in Python (see ``tx.py``), so the server needs no
Node runtime and no CLI. One call is:

1. ``query view_access_key`` for the operator key: its nonce, plus a final
   block hash to anchor the transaction to.
2. Sign a transaction with one ``FunctionCall`` action, nonce + 1.
3. ``send_tx`` with ``wait_until`` (default ``EXECUTED_OPTIMISTIC``), which
   returns once every receipt has run.
4. If the RPC times out or the connection drops after sending, poll the
   ``tx`` method by hash before reporting the outcome as unknown.

Calls are serialised behind a lock: one key, one nonce sequence. A local
nonce floor covers the gap between an optimistic result and the final
block that ``view_access_key`` reads.
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
from typing import Any

import httpx

from quest_sim.near.client import (
    DEFAULT_GAS,
    ContractError,
    RequestError,
    TransportError,
    TxResult,
)
from quest_sim.near.tx import KeyPair, b58decode, encode_args, sign_function_call

logger = logging.getLogger(__name__)

# How the RPC names failures (error.cause.name). Everything not listed is
# treated as transient.
_REQUEST_ERRORS = {"PARSE_ERROR", "REQUEST_VALIDATION_ERROR", "METHOD_NOT_FOUND"}
_VIEW_ERRORS = {
    "CONTRACT_EXECUTION_ERROR", "NO_CONTRACT_CODE", "UNKNOWN_ACCOUNT", "QUERY_ERROR",
}


class _RpcFailure(Exception):
    def __init__(self, name: str, message: str, data: Any = None):
        super().__init__(f"{name}: {message}")
        self.name = name
        self.data = data


def _short(value: Any, limit: int = 300) -> str:
    text = value if isinstance(value, str) else json.dumps(value, default=str)
    return text if len(text) <= limit else text[: limit - 3] + "..."


def failure_message(failure: Any) -> str:
    """The contract's own words from a transaction ``Failure`` when there
    are any (``Smart contract panicked: <message>``), else the raw error."""
    text = _find_key(failure, "ExecutionError")
    return _short(text) if isinstance(text, str) else _short(failure)


class NearRpcClient:
    def __init__(
        self,
        *,
        rpc_url: str,
        contract_id: str,
        account_id: str | None = None,
        secret_key: str | None = None,
        wait_until: str = "EXECUTED_OPTIMISTIC",
        request_timeout_s: float = 30.0,
        poll_attempts: int = 4,
        poll_interval_s: float = 3.0,
        http: httpx.AsyncClient | None = None,
    ):
        self.rpc_url = rpc_url
        self.contract_id = contract_id
        self.account_id = account_id
        self._key = KeyPair.from_secret(secret_key) if secret_key else None
        self.wait_until = wait_until
        self.request_timeout_s = request_timeout_s
        self.poll_attempts = poll_attempts
        self.poll_interval_s = poll_interval_s
        self._http = http
        self._owns_http = http is None
        self._lock = asyncio.Lock()
        self._nonce_floor = 0
        self._request_id = 0

    @property
    def public_key(self) -> str | None:
        return self._key.public_key_str if self._key else None

    # -- transport ----------------------------------------------------------

    def _client(self) -> httpx.AsyncClient:
        if self._http is None:
            self._http = httpx.AsyncClient(timeout=self.request_timeout_s)
        return self._http

    async def aclose(self) -> None:
        if self._http is not None and self._owns_http:
            await self._http.aclose()
        self._http = None

    async def _rpc(self, method: str, params: Any) -> Any:
        self._request_id += 1
        body = {"jsonrpc": "2.0", "id": self._request_id, "method": method, "params": params}
        try:
            resp = await self._client().post(self.rpc_url, json=body)
        except httpx.TimeoutException as e:
            raise _RpcFailure("TIMEOUT_ERROR", f"HTTP timeout ({type(e).__name__})") from None
        except httpx.HTTPError as e:
            raise TransportError(f"RPC unreachable: {type(e).__name__}: {e}") from None
        try:
            payload = resp.json()
        except ValueError:
            payload = None
        if isinstance(payload, dict) and payload.get("error"):
            err = payload["error"]
            cause = err.get("cause") or {}
            name = cause.get("name") or err.get("name") or "UNKNOWN"
            detail = err.get("data") if err.get("data") is not None else err.get("message")
            raise _RpcFailure(name, _short(detail), err.get("data"))
        if resp.status_code >= 400 or not isinstance(payload, dict) or "result" not in payload:
            if resp.status_code in (408, 504):
                raise _RpcFailure("TIMEOUT_ERROR", f"HTTP {resp.status_code}")
            if resp.status_code >= 500 or resp.status_code == 429:
                raise TransportError(f"RPC returned HTTP {resp.status_code}")
            raise RequestError(f"RPC returned HTTP {resp.status_code}: {_short(resp.text)}")
        result = payload["result"]
        if method == "query" and isinstance(result, dict) and result.get("error"):
            # Query failures (a missing access key, a panicking view) arrive
            # as a successful response with the error inside the result.
            raise _RpcFailure("QUERY_ERROR", _short(result["error"]))
        return result

    # -- views --------------------------------------------------------------

    async def view(self, method: str, args: dict, *, contract_id: str | None = None) -> Any:
        params = {
            "request_type": "call_function",
            "finality": "optimistic",
            "account_id": contract_id or self.contract_id,
            "method_name": method,
            "args_base64": base64.b64encode(encode_args(args)).decode("ascii"),
        }
        try:
            result = await self._rpc("query", params)
        except _RpcFailure as e:
            if e.name in _VIEW_ERRORS:
                raise ContractError(f"view {method} failed: {e}") from None
            if e.name in _REQUEST_ERRORS:
                raise RequestError(f"view {method} refused: {e}") from None
            raise TransportError(f"view {method}: {e}") from None
        raw = bytes(result.get("result") or [])
        if not raw:
            return None
        try:
            return json.loads(raw)
        except ValueError:
            return raw.decode("utf-8", "replace")

    async def access_key(self) -> dict:
        """The operator key's on-chain record (nonce, permission)."""
        if self._key is None or not self.account_id:
            raise TransportError("no operator account or key configured")
        params = {
            "request_type": "view_access_key",
            "finality": "final",
            "account_id": self.account_id,
            "public_key": self._key.public_key_str,
        }
        try:
            return await self._rpc("query", params)
        except _RpcFailure as e:
            # UNKNOWN_ACCESS_KEY / UNKNOWN_ACCOUNT: misconfiguration the
            # operator can fix without a restart (e.g. by adding the key), so
            # it stays retryable rather than dropping the call.
            raise TransportError(f"operator access key: {e}") from None
        except RequestError as e:
            raise TransportError(f"operator access key: {e}") from None

    # -- calls --------------------------------------------------------------

    async def call(
        self, method: str, args: dict, *, deposit_yocto: int = 0, gas: int = DEFAULT_GAS
    ) -> TxResult:
        if self._key is None or not self.account_id:
            raise TransportError("no operator account or key configured")
        async with self._lock:
            key = await self.access_key()
            nonce = max(int(key["nonce"]), self._nonce_floor) + 1
            signed = sign_function_call(
                self._key,
                signer_id=self.account_id,
                receiver_id=self.contract_id,
                nonce=nonce,
                block_hash=b58decode(key["block_hash"]),
                method_name=method,
                args=encode_args(args),
                gas=gas,
                deposit=deposit_yocto,
            )
            self._nonce_floor = nonce
            try:
                outcome = await self._rpc(
                    "send_tx",
                    {"signed_tx_base64": signed.signed_b64, "wait_until": self.wait_until},
                )
            except _RpcFailure as e:
                if e.name == "TIMEOUT_ERROR":
                    outcome = await self._await_tx(signed.tx_hash)
                else:
                    raise self._classify_send_failure(e, signed.tx_hash) from None
            except TransportError:
                # the connection dropped: the transaction may or may not
                # have been accepted, so look before saying "unknown"
                outcome = await self._await_tx(signed.tx_hash)
        return self._parse_outcome(outcome, signed.tx_hash)

    def _classify_send_failure(self, e: _RpcFailure, tx_hash: str) -> Exception:
        if e.name in _REQUEST_ERRORS:
            return RequestError(str(e), tx_hash=tx_hash)
        if e.name == "INVALID_TRANSACTION":
            nonce_info = _find_key(e.data, "InvalidNonce")
            if isinstance(nonce_info, dict) and "ak_nonce" in nonce_info:
                self._nonce_floor = max(self._nonce_floor, int(nonce_info["ak_nonce"]))
        # Invalid nonce, expired block hash, operator out of balance, a
        # missing or exhausted key: the call never ran, and none of these is
        # this call's fault. Retry.
        return TransportError(str(e), tx_hash=tx_hash)

    async def _await_tx(self, tx_hash: str) -> dict:
        params = {
            "tx_hash": tx_hash,
            "sender_account_id": self.account_id,
            "wait_until": self.wait_until,
        }
        last = "not found"
        for attempt in range(self.poll_attempts):
            if attempt:
                await asyncio.sleep(self.poll_interval_s)
            try:
                return await self._rpc("tx", params)
            except _RpcFailure as e:
                last = str(e)
            except TransportError as e:
                last = str(e)
        raise TransportError(f"outcome unknown after sending ({last})", tx_hash=tx_hash)

    @staticmethod
    def _parse_outcome(outcome: Any, tx_hash: str) -> TxResult:
        if not isinstance(outcome, dict):
            raise TransportError("unexpected send_tx result", tx_hash=tx_hash)
        status = outcome.get("status")
        logs: list[str] = []
        for receipt in outcome.get("receipts_outcome") or []:
            logs.extend((receipt.get("outcome") or {}).get("logs") or [])
        if isinstance(status, dict) and "SuccessValue" in status:
            raw = base64.b64decode(status["SuccessValue"] or "")
            value: Any = None
            if raw:
                try:
                    value = json.loads(raw)
                except ValueError:
                    value = raw.decode("utf-8", "replace")
            return TxResult(tx_hash=tx_hash, value=value, logs=tuple(logs))
        if isinstance(status, dict) and "SuccessReceiptId" in status:
            return TxResult(tx_hash=tx_hash, value=None, logs=tuple(logs))
        if isinstance(status, dict) and "Failure" in status:
            raise ContractError(failure_message(status["Failure"]), tx_hash=tx_hash)
        raise TransportError(f"transaction not finished ({_short(status)})", tx_hash=tx_hash)


def _find_key(node: Any, key: str) -> Any:
    if isinstance(node, dict):
        if key in node:
            return node[key]
        for value in node.values():
            found = _find_key(value, key)
            if found is not None:
                return found
    elif isinstance(node, list):
        for value in node:
            found = _find_key(value, key)
            if found is not None:
                return found
    return None
