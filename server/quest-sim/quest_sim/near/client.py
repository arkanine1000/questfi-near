"""The settler's view of the chain: two calls and three kinds of failure.

``call`` signs and sends one function call as the operator and waits for
its result; ``view`` reads contract state. Everything chain-specific lives
behind this seam, so the settler's queue, retries and ledger are tested
against ``FakeNearClient`` and run unchanged against ``NearRpcClient``.

The failure kinds drive the settler's retry policy:

* ``TransportError`` — the RPC could not be reached, the operator could not
  sign or pay, or the outcome is unknown. Nothing proves the call failed, so
  it is retried until it goes through.
* ``ContractError`` — the chain ran the transaction and the contract
  rejected it; its state change was rolled back. Retrying usually fails the
  same way, so the settler first checks whether the effect is already there
  (an earlier attempt may have landed), then gives up after a few tries.
* ``RequestError`` — the RPC refused the request itself as malformed.
"""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass, field
from typing import Any, Protocol

TGAS = 10**12
DEFAULT_GAS = 100 * TGAS


def explorer_tx_url(account_id: str | None, tx_hash: str) -> str:
    """A transaction's page on nearblocks. The network is read off the
    account the transaction went to: ``*.testnet`` means testnet."""
    host = "testnet.nearblocks.io" if (account_id or "").endswith(".testnet") else "nearblocks.io"
    return f"https://{host}/txns/{tx_hash}"


class NearError(Exception):
    def __init__(self, message: str, *, tx_hash: str | None = None):
        super().__init__(message)
        self.tx_hash = tx_hash


class TransportError(NearError):
    """Unreachable, unsigned, unpaid, or outcome unknown. Retry."""


class ContractError(NearError):
    """Executed and rejected by the contract (or a view that panicked)."""


class RequestError(NearError):
    """Refused by the RPC as malformed."""


@dataclass(frozen=True)
class TxResult:
    tx_hash: str
    value: Any = None  # the method's JSON return value, decoded
    logs: tuple[str, ...] = ()


class NearClient(Protocol):
    async def call(
        self, method: str, args: dict, *, deposit_yocto: int = 0, gas: int = DEFAULT_GAS
    ) -> TxResult: ...

    async def view(self, method: str, args: dict) -> Any: ...

    async def account_balance(self) -> int:
        """yoctoNEAR on the operator's own account."""
        ...

    async def aclose(self) -> None: ...


# ---------------------------------------------------------------------------
# Fake
# ---------------------------------------------------------------------------


@dataclass
class FakeCall:
    method: str
    args: dict
    deposit_yocto: int
    gas: int
    outcome: str = "pending"  # "pending" | "ok" | the failure class name
    tx_hash: str | None = None


@dataclass
class _FakeFailure:
    method: str | None  # None matches every method
    error: NearError
    after_apply: bool  # apply first, then fail: the "landed but timed out" case
    times: int


@dataclass
class FakeNearClient:
    """An in-memory stand-in for the contract, for tests and offline runs.

    Records every attempted call (``calls``) and view (``views``), and keeps
    just enough season state to answer ``get_season`` and to apply the same
    rules the contract enforces on ``report_events`` sequence numbers: an
    already-applied ``seq`` is a no-op, a gap is rejected.

    ``outage = True`` makes every request fail with ``TransportError``;
    ``hang = True`` makes calls block until it is cleared (polled, so it may
    be cleared from another thread); ``fail_next`` queues targeted
    failures. ``active`` is each pass's ``active_season``: a pass is in one
    season at a time, until that season settles or is cancelled.

    ``balances`` holds the pass balances a test cares about, in yocto: a
    listed pass pays its stake on entry and is refused when it cannot; a
    pass not listed can always pay. ``operator_balance`` is what
    ``account_balance`` answers, and a ``deposit`` moves it into a pass."""

    calls: list[FakeCall] = field(default_factory=list)
    views: list[tuple[str, dict]] = field(default_factory=list)
    seasons: dict[str, dict] = field(default_factory=dict)
    active: dict[str, str] = field(default_factory=dict)  # pass_id -> season_id
    balances: dict[str, int] = field(default_factory=dict)  # pass_id -> yocto
    operator_balance: int = 10**27
    outage: bool = False
    hang: bool = False
    _failures: list[_FakeFailure] = field(default_factory=list)
    _tx_counter: int = 0

    # -- test controls ------------------------------------------------------

    def fail_next(
        self,
        method: str | None,
        error: NearError | None = None,
        *,
        times: int = 1,
        after_apply: bool = False,
    ) -> None:
        self._failures.append(
            _FakeFailure(method, error or TransportError("injected"), after_apply, times)
        )

    def release(self) -> None:
        self.hang = False

    def applied(self, method: str | None = None) -> list[FakeCall]:
        return [
            c for c in self.calls
            if c.outcome == "ok" and (method is None or c.method == method)
        ]

    def add_entrant(self, season_id: str, pass_id: str, name: str = "") -> None:
        """A pass entering on its own (a player's agent key)."""
        season = self.seasons.setdefault(season_id, self._new_season("0"))
        season["entrants"][pass_id] = {"name": name, "alive": True}
        self.active[pass_id] = season_id

    # -- NearClient ---------------------------------------------------------

    async def call(
        self, method: str, args: dict, *, deposit_yocto: int = 0, gas: int = DEFAULT_GAS
    ) -> TxResult:
        record = FakeCall(method, json.loads(json.dumps(args)), deposit_yocto, gas)
        self.calls.append(record)
        while self.hang:
            await asyncio.sleep(0.005)
        if self.outage:
            record.outcome = "TransportError"
            raise TransportError("chain unreachable (fake outage)")
        failure = self._take_failure(method)
        if failure is not None and not failure.after_apply:
            record.outcome = type(failure.error).__name__
            raise failure.error
        self._tx_counter += 1
        tx_hash = f"faketx{self._tx_counter:04d}"
        try:
            value = self._apply(method, args, deposit_yocto)
        except ContractError as e:
            record.outcome = "ContractError"
            e.tx_hash = tx_hash
            raise
        if failure is not None:
            record.outcome = type(failure.error).__name__
            raise failure.error
        record.outcome, record.tx_hash = "ok", tx_hash
        return TxResult(tx_hash=tx_hash, value=value)

    async def view(self, method: str, args: dict) -> Any:
        self.views.append((method, dict(args)))
        if self.outage:
            raise TransportError("chain unreachable (fake outage)")
        if method == "get_season":
            season = self.seasons.get(args.get("season_id"))
            if season is None:
                return None
            return {
                "status": season["status"],
                "entry_stake": season["entry_stake"],
                "pot": "0",
                "winner": season["winner"],
                "entrants": [
                    {"pass_id": pid, "name": e["name"], "at_risk": season["entry_stake"],
                     "alive": e["alive"]}
                    for pid, e in season["entrants"].items()
                ],
            }
        if method == "get_market":
            season = self.seasons.get(args.get("season_id"))
            return None if season is None else {"open": season["market_open"]}
        if method == "get_pass":
            pass_id = str(args.get("pass_id"))
            return {
                "token_id": pass_id,
                "active_season": self.active.get(pass_id),
                "balance": str(self.balances.get(pass_id, 10**27)),
            }
        raise ContractError(f"MethodNotFound: {method}")

    async def account_balance(self) -> int:
        if self.outage:
            raise TransportError("chain unreachable (fake outage)")
        return self.operator_balance

    async def aclose(self) -> None:
        return None

    # -- the contract, in miniature ------------------------------------------

    def _take_failure(self, method: str) -> _FakeFailure | None:
        for failure in self._failures:
            if failure.method in (None, method):
                failure.times -= 1
                if failure.times <= 0:
                    self._failures.remove(failure)
                return failure
        return None

    @staticmethod
    def _new_season(stake: str) -> dict:
        return {
            "status": "Open", "entry_stake": stake, "entrants": {}, "next_seq": 0,
            "events": [], "winner": None, "market_open": True,
        }

    def _release(self, season_id: str) -> None:
        for pass_id in [p for p, s in self.active.items() if s == season_id]:
            del self.active[pass_id]

    def _season(self, args: dict, *statuses: str) -> dict:
        season = self.seasons.get(args.get("season_id"))
        if season is None:
            raise ContractError("season not found")
        if statuses and season["status"] not in statuses:
            raise ContractError(f"season is {season['status']}")
        return season

    def _apply(self, method: str, args: dict, deposit_yocto: int = 0) -> Any:
        if method == "deposit":
            if deposit_yocto <= 0:
                raise ContractError("attach a deposit")
            pass_id = str(args["pass_id"])
            self.balances[pass_id] = self.balances.get(pass_id, 0) + deposit_yocto
            self.operator_balance -= deposit_yocto
            return None
        if method == "create_season":
            if args["season_id"] in self.seasons:
                raise ContractError("season already exists")
            self.seasons[args["season_id"]] = self._new_season(args["entry_stake"])
            return None
        if method == "enter_season":
            season = self._season(args, "Open")
            if args["pass_id"] in season["entrants"]:
                raise ContractError("pass already entered")
            if args["pass_id"] in self.active:
                raise ContractError("pass is already in a season")
            if args["pass_id"] in self.balances:
                stake = int(season["entry_stake"])
                if self.balances[args["pass_id"]] < stake:
                    raise ContractError("not enough in the pass")
                self.balances[args["pass_id"]] -= stake
            season["entrants"][args["pass_id"]] = {"name": "", "alive": True}
            self.active[args["pass_id"]] = args["season_id"]
            return None
        if method == "start_season":
            self._season(args, "Open")["status"] = "Running"
            return None
        if method == "lock_market":
            self._season(args, "Open", "Running")["market_open"] = False
            return None
        if method == "report_events":
            season = self._season(args, "Running")
            seq, events = int(args["seq"]), list(args["events"])
            if len(events) > 20:
                raise ContractError("too many events")
            if seq < season["next_seq"]:
                return {"applied": 0, "skipped": len(events), "next_seq": season["next_seq"]}
            if seq > season["next_seq"]:
                raise ContractError(f"seq gap: expected {season['next_seq']}, got {seq}")
            applied = 0
            for ev in events:
                if ev.get("kind") == "kill":
                    victim = season["entrants"].get(ev.get("victim"))
                    killer = ev.get("killer")
                    if victim is None or not victim["alive"] or (
                        killer is not None and killer not in season["entrants"]
                    ):
                        continue
                    victim["alive"] = False
                elif ev.get("kind") == "loot":
                    if ev.get("pass") not in season["entrants"]:
                        continue
                else:
                    continue
                season["events"].append(ev)
                applied += 1
            season["next_seq"] = seq + 1
            return {"applied": applied, "skipped": len(events) - applied,
                    "next_seq": season["next_seq"]}
        if method == "settle_season":
            season = self._season(args, "Running")
            winner = args.get("winner_pass")
            if winner is not None and winner not in season["entrants"]:
                raise ContractError("winner is not an entrant")
            season["status"] = "Settled"
            season["winner"] = winner
            season["market_open"] = False
            self._release(args["season_id"])
            return None
        if method == "cancel_season":
            self._season(args, "Open", "Running")["status"] = "Cancelled"
            self._release(args["season_id"])
            return None
        raise ContractError(f"MethodNotFound: {method}")
