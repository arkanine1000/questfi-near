"""The settler: the operator's calls to the season contract, queued.

Trust model: the game server is a trusted reporter. The contract checks
that the caller is a registered operator and does the money maths; it does
not verify that a kill or a win happened in the game. The settler is the
one place the server speaks for the game on chain.

Nothing here ever blocks a tick. Each call method is synchronous and only
records an operation and puts it on an ``asyncio.Queue``; one background
task drains the queue in order, with retries and backoff, so a season
plays at full speed whether the chain answers in a second, an hour, or
not at all.

Every operation is written to a per-season ledger on disk before it is
sent (``<state_dir>/<season_id>.json``), so a restart resumes where the
last process stopped instead of losing or repeating work.

Ordering and exactly-once:

* One worker, one queue, FIFO. Within a season the contract sees calls in
  the order the game produced them: create, entries, start, events, lock,
  settle.
* ``report_events`` batches carry ``seq``: 0, 1, 2, ... per season. A batch
  is sealed (its events filtered and its ``seq`` fixed) just before its
  first send, and every retry resends exactly that ``seq`` and those
  events. The contract ignores an already-applied ``seq`` and rejects a
  gap, so each batch is applied once and in order. ``seq`` advances only
  when a batch succeeds; a batch the contract rejects outright was never
  applied, so the next one reuses its number.
* Other calls are not idempotent on chain, so when the contract rejects
  one the settler first checks ``get_season`` to see whether an earlier
  attempt already landed (a timeout can hide a success) and records it
  as done if so.

Failures: a ``TransportError`` (chain unreachable, operator cannot pay or
sign, outcome unknown) is retried until it succeeds, with capped
exponential backoff. A ``ContractError`` or ``RequestError`` is retried a
few times and then the operation is marked failed and the queue moves on.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from quest_sim.near.client import (
    DEFAULT_GAS,
    ContractError,
    NearClient,
    NearError,
    TransportError,
    TxResult,
    explorer_tx_url,
)

logger = logging.getLogger(__name__)

MAX_EVENTS_PER_BATCH = 20  # the contract's max_events_per_call
TERMINAL = {"Settled", "Cancelled"}
RECENT_TX_LIMIT = 10
LEDGER_VERSION = 1


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _short(text: str, limit: int = 300) -> str:
    return text if len(text) <= limit else text[: limit - 3] + "..."


@dataclass
class Op:
    """One contract call. ``args`` are final once ``sealed``."""

    id: int
    method: str
    args: dict
    deposit_yocto: str = "0"
    state: str = "pending"  # pending | done | failed | skipped | merged
    sealed: bool = False
    attempts: int = 0
    rejections: int = 0  # ContractError / RequestError count
    resequenced: bool = False
    tx_hash: str | None = None
    note: str | None = None
    created_at: str = field(default_factory=_now)
    finished_at: str | None = None


@dataclass
class Ledger:
    """Everything the settler knows about one season."""

    season_id: str
    entry_stake_yocto: str = "0"
    status: str | None = None  # last known on-chain status
    next_seq: int = 0
    entrants: list[str] = field(default_factory=list)  # passes known to be in
    pending_entries: list[str] = field(default_factory=list)  # enter queued
    lock_enqueued: bool = False
    locked: bool = False
    settle_enqueued: bool = False
    cancel_enqueued: bool = False
    create_failed: bool = False
    start_failed: bool = False
    removed: bool = False  # the world is gone from the server
    last_error: dict | None = None
    recent_txs: list[dict] = field(default_factory=list)
    ops: list[Op] = field(default_factory=list)
    next_op_id: int = 1

    @property
    def closed(self) -> bool:
        """Settle or cancel is queued: no further game calls are accepted."""
        return self.settle_enqueued or self.cancel_enqueued

    def pending(self) -> list[Op]:
        return [op for op in self.ops if op.state == "pending"]

    def get(self, op_id: int) -> Op | None:
        for op in self.ops:
            if op.id == op_id:
                return op
        return None

    def to_json(self) -> str:
        data = asdict(self)
        data["version"] = LEDGER_VERSION
        return json.dumps(data, indent=1)

    @classmethod
    def from_json(cls, text: str) -> Ledger:
        data = json.loads(text)
        data.pop("version", None)
        ops = [Op(**op) for op in data.pop("ops", [])]
        known = {f for f in cls.__dataclass_fields__}
        ledger = cls(**{k: v for k, v in data.items() if k in known})
        ledger.ops = ops
        return ledger


class Settler:
    def __init__(
        self,
        client: NearClient,
        *,
        contract_id: str,
        state_dir: Path,
        entry_stake_yocto: int = 0,
        lock_tick: int = 0,
        passes_file: Path | None = None,
        gas: int = DEFAULT_GAS,
        backoff_base_s: float = 1.0,
        backoff_max_s: float = 60.0,
        max_rejections: int = 3,
    ):
        self.client = client
        self.contract_id = contract_id
        self.state_dir = Path(state_dir)
        self.entry_stake_yocto = int(entry_stake_yocto)
        self.lock_tick = int(lock_tick)
        self.passes_file = passes_file
        self.gas = gas
        self.backoff_base_s = backoff_base_s
        self.backoff_max_s = backoff_max_s
        self.max_rejections = max_rejections

        self._ledgers: dict[str, Ledger] = {}
        self._queue: asyncio.Queue | None = None
        self._worker: asyncio.Task | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        # The chain-wide problem of the moment (a transport failure), cleared
        # by the next success. Per-season errors live on the ledger.
        self.chain_error: dict | None = None
        self._load_all()

    # ------------------------------------------------------------------
    # Ledger storage
    # ------------------------------------------------------------------

    def _path(self, season_id: str) -> Path:
        return self.state_dir / f"{season_id}.json"

    def _load_all(self) -> None:
        if not self.state_dir.is_dir():
            return
        for path in sorted(self.state_dir.glob("*.json")):
            try:
                ledger = Ledger.from_json(path.read_text())
            except (OSError, ValueError, TypeError):
                logger.warning("skipping unreadable settler ledger %s", path.name)
                continue
            if ledger.pending() or not self._idle(ledger):
                self._ledgers[ledger.season_id] = ledger

    def _ledger(self, season_id: str) -> Ledger | None:
        ledger = self._ledgers.get(season_id)
        if ledger is not None:
            return ledger
        path = self._path(season_id)
        if not path.exists():
            return None
        try:
            return Ledger.from_json(path.read_text())
        except (OSError, ValueError, TypeError):
            return None

    def _save(self, ledger: Ledger) -> None:
        self.state_dir.mkdir(parents=True, exist_ok=True)
        path = self._path(ledger.season_id)
        tmp = path.with_suffix(".json.tmp")
        try:
            tmp.write_text(ledger.to_json())
            os.replace(tmp, path)
        except OSError:
            logger.exception("could not write settler ledger for %s", ledger.season_id)

    @staticmethod
    def _idle(ledger: Ledger) -> bool:
        """Nothing queued and nothing more will be: safe to forget."""
        if ledger.pending():
            return False
        return ledger.status in TERMINAL or ledger.create_failed or (
            ledger.closed and not ledger.pending()
        )

    def _retire_if_idle(self, ledger: Ledger) -> None:
        if not self._idle(ledger):
            return
        self._ledgers.pop(ledger.season_id, None)
        if ledger.removed:
            try:
                self._path(ledger.season_id).unlink()
            except OSError:
                pass

    # ------------------------------------------------------------------
    # Queue and worker
    # ------------------------------------------------------------------

    def _worker_alive(self) -> bool:
        return (
            self._worker is not None
            and not self._worker.done()
            and self._loop is not None
            and self._loop.is_running()
        )

    def _schedule(self, token: tuple[str, int] | None = None) -> None:
        """Hand an operation to the worker, starting the worker if needed.

        One worker, on one loop. A caller on another thread reaches it
        through call_soon_threadsafe. With no worker and no running loop
        the operation simply waits in its ledger for start()."""
        try:
            running = asyncio.get_running_loop()
        except RuntimeError:
            running = None
        if self._worker_alive():
            if token is not None:
                if running is self._loop:
                    self._queue.put_nowait(token)
                else:
                    self._loop.call_soon_threadsafe(self._queue.put_nowait, token)
            return
        if running is None:
            return
        # (Re)build on this loop from the ledgers, which already hold `token`.
        self._loop = running
        self._queue = asyncio.Queue()
        for ledger in list(self._ledgers.values()):
            for op in ledger.pending():
                self._queue.put_nowait((ledger.season_id, op.id))
        self._worker = running.create_task(self._run(), name="near-settler")

    def _enqueue(self, ledger: Ledger, op: Op) -> None:
        self._schedule((ledger.season_id, op.id))

    async def start(self) -> None:
        self._schedule()

    async def stop(self) -> None:
        if self._worker is not None and not self._worker.done():
            self._worker.cancel()
            try:
                await self._worker
            except (asyncio.CancelledError, Exception):
                pass
        self._worker = None
        self._queue = None
        await self.client.aclose()

    async def drain(self, timeout: float = 10.0) -> bool:
        """Wait until every queued operation has been handled. For tests and
        orderly shutdown; the game never waits on this."""
        self._schedule()
        if self._queue is None:
            return not self.queue_depth()
        try:
            await asyncio.wait_for(self._queue.join(), timeout)
        except (TimeoutError, asyncio.TimeoutError):
            return False
        return True

    async def _run(self) -> None:
        queue = self._queue
        assert queue is not None
        while True:
            season_id, op_id = await queue.get()
            try:
                ledger = self._ledgers.get(season_id)
                op = ledger.get(op_id) if ledger is not None else None
                if op is not None and op.state == "pending":
                    await self._execute(ledger, op)
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("settler failed on %s op %s", season_id, op_id)
            finally:
                queue.task_done()

    def _backoff(self, n: int) -> float:
        return min(self.backoff_base_s * (2 ** max(0, n - 1)), self.backoff_max_s)

    # ------------------------------------------------------------------
    # The operator's calls (enqueue only; never wait for the chain)
    # ------------------------------------------------------------------

    def _add(self, ledger: Ledger, method: str, args: dict, deposit_yocto: int = 0) -> Op:
        op = Op(id=ledger.next_op_id, method=method, args=args, deposit_yocto=str(deposit_yocto))
        ledger.next_op_id += 1
        ledger.ops.append(op)
        self._save(ledger)
        self._enqueue(ledger, op)
        return op

    def tracks(self, season_id: str) -> bool:
        return self._ledger(season_id) is not None

    def _open_ledger(self, season_id: str) -> Ledger | None:
        ledger = self._ledgers.get(season_id) or self._ledger(season_id)
        if ledger is None or ledger.closed or ledger.create_failed:
            return None
        self._ledgers[season_id] = ledger
        return ledger

    def is_open(self, season_id: str) -> bool:
        """A season this settler opened and that still takes game calls."""
        ledger = self._ledgers.get(season_id)
        if ledger is None:
            ledger = self._ledger(season_id)
        return bool(ledger and not ledger.closed and not ledger.create_failed)

    def create_season(self, season_id: str, entry_stake_yocto: int | None = None) -> Op | None:
        if self._ledger(season_id) is not None:
            return None  # already created (or creating) under this id
        stake = self.entry_stake_yocto if entry_stake_yocto is None else int(entry_stake_yocto)
        ledger = Ledger(season_id=season_id, entry_stake_yocto=str(stake))
        self._ledgers[season_id] = ledger
        return self._add(
            ledger, "create_season", {"season_id": season_id, "entry_stake": str(stake)}
        )

    def enter_season(self, season_id: str, pass_id: str) -> Op | None:
        """Enter one of the operator's own (house) passes."""
        ledger = self._open_ledger(season_id)
        if ledger is None or pass_id in ledger.entrants or pass_id in ledger.pending_entries:
            return None
        ledger.pending_entries.append(pass_id)
        return self._add(ledger, "enter_season", {"pass_id": pass_id, "season_id": season_id})

    def start_season(self, season_id: str) -> Op | None:
        ledger = self._open_ledger(season_id)
        if ledger is None:
            return None
        return self._add(ledger, "start_season", {"season_id": season_id})

    def lock_market(self, season_id: str) -> Op | None:
        ledger = self._open_ledger(season_id)
        if ledger is None or ledger.lock_enqueued:
            return None
        ledger.lock_enqueued = True
        return self._add(ledger, "lock_market", {"season_id": season_id})

    def report_events(self, season_id: str, events: list[dict]) -> list[Op]:
        """Queue game events. Batches are cut to the contract's limit here
        and may be merged with their neighbours when they are sealed."""
        ledger = self._open_ledger(season_id)
        if ledger is None or not events:
            return []
        ops = []
        for i in range(0, len(events), MAX_EVENTS_PER_BATCH):
            chunk = [dict(e) for e in events[i:i + MAX_EVENTS_PER_BATCH]]
            ops.append(
                self._add(ledger, "report_events", {"season_id": season_id, "events": chunk})
            )
        return ops

    def settle_season(self, season_id: str, winner_pass: str | None) -> Op | None:
        ledger = self._open_ledger(season_id)
        if ledger is None:
            return None
        ledger.settle_enqueued = True
        return self._add(
            ledger, "settle_season", {"season_id": season_id, "winner_pass": winner_pass}
        )

    def cancel_season(self, season_id: str) -> Op | None:
        ledger = self._ledgers.get(season_id) or self._ledger(season_id)
        if ledger is None or ledger.cancel_enqueued or ledger.create_failed:
            return None
        settle = next((o for o in ledger.ops if o.method == "settle_season"), None)
        if settle is not None and settle.state != "failed":
            return None  # settled, or settling: nothing to cancel
        if ledger.status in TERMINAL:
            return None
        self._ledgers[season_id] = ledger
        ledger.cancel_enqueued = True
        return self._add(ledger, "cancel_season", {"season_id": season_id})

    def mark_removed(self, season_id: str) -> None:
        """The world is gone from the server; its ledger file may be deleted
        once nothing more is owed to the chain."""
        ledger = self._ledgers.get(season_id) or self._ledger(season_id)
        if ledger is None:
            return
        ledger.removed = True
        self._ledgers[season_id] = ledger
        self._save(ledger)
        self._retire_if_idle(ledger)

    def note_entrant(self, season_id: str, pass_id: str) -> None:
        """A player's pass, confirmed on chain at join time."""
        ledger = self._open_ledger(season_id)
        if ledger is None or pass_id in ledger.entrants:
            return
        ledger.entrants.append(pass_id)
        self._save(ledger)

    def is_locked(self, season_id: str) -> bool:
        ledger = self._ledger(season_id)
        return bool(ledger and ledger.lock_enqueued)

    def pass_busy(self, pass_id: str, except_season: str | None = None) -> bool:
        """Is this pass entered (or being entered) in another season that has
        not yet been settled or cancelled? A pass can be in one season at a
        time, so entering it again would be refused on chain."""
        for ledger in self._ledgers.values():
            if ledger.season_id == except_season or ledger.closed or ledger.create_failed:
                continue
            if pass_id in ledger.entrants or pass_id in ledger.pending_entries:
                return True
        return False

    async def fetch_season(self, season_id: str) -> Any:
        """``get_season``, straight from the chain. Raises NearError."""
        return await self.client.view("get_season", {"season_id": season_id})

    # ------------------------------------------------------------------
    # Execution
    # ------------------------------------------------------------------

    def _skip_reason(self, ledger: Ledger, op: Op) -> str | None:
        if ledger.create_failed:
            return "season was never created on chain"
        if op.method == "cancel_season":
            if ledger.status in TERMINAL:
                return f"season already {ledger.status}"
            return None
        if ledger.start_failed and op.method in ("report_events", "lock_market", "settle_season"):
            return "season never started on chain"
        if ledger.status == "Cancelled":
            return "season was cancelled"
        return None

    def _seal(self, ledger: Ledger, op: Op) -> None:
        """Fix a call's final arguments before its first send."""
        if op.method == "report_events":
            batch = self._filter_events(ledger, op.args.get("events") or [])
            # Merge the season's next batches while they fit: when the chain
            # lags, ten one-kill batches become one transaction.
            index = ledger.ops.index(op)
            for nxt in ledger.ops[index + 1:]:
                if nxt.method != "report_events" or nxt.state != "pending" or nxt.sealed:
                    break
                more = self._filter_events(ledger, nxt.args.get("events") or [])
                if len(batch) + len(more) > MAX_EVENTS_PER_BATCH:
                    break
                batch.extend(more)
                nxt.state = "merged"
                nxt.note = f"merged into op {op.id}"
                nxt.finished_at = _now()
            if not batch:
                op.state = "skipped"
                op.note = "no events for passes in this season"
                op.finished_at = _now()
            op.args = {"season_id": ledger.season_id, "seq": ledger.next_seq, "events": batch}
        elif op.method == "settle_season":
            winner = op.args.get("winner_pass")
            if winner is not None and winner not in ledger.entrants:
                op.note = f"winner pass {winner} is not an entrant; settling with no winner"
                op.args = {"season_id": ledger.season_id, "winner_pass": None}
        op.sealed = True

    @staticmethod
    def _filter_events(ledger: Ledger, events: list[dict]) -> list[dict]:
        """Keep only what the contract can apply: victims and loot recipients
        must be entrants; a killer who is not counts as a monster."""
        entrants = set(ledger.entrants)
        out = []
        for ev in events:
            if ev.get("kind") == "kill":
                if ev.get("victim") not in entrants:
                    continue
                killer = ev.get("killer")
                out.append({
                    "kind": "kill",
                    "killer": killer if killer in entrants else None,
                    "victim": ev["victim"],
                })
            elif ev.get("kind") == "loot":
                if ev.get("pass") in entrants:
                    out.append(dict(ev))
        return out

    async def _already_applied(self, ledger: Ledger, op: Op) -> bool:
        """After a rejection: did an earlier attempt already do this?"""
        if op.method == "report_events":
            return False  # seq makes a repeat a no-op, never a rejection
        try:
            if op.method == "lock_market":
                market = await self.client.view("get_market", {"season_id": ledger.season_id})
                return isinstance(market, dict) and market.get("open") is False
            season = await self.fetch_season(ledger.season_id)
        except NearError:
            return False
        if not isinstance(season, dict):
            return False
        status = season.get("status")
        if isinstance(status, str):
            ledger.status = status
        if op.method == "create_season":
            return True
        if op.method == "enter_season":
            passes = {str(e.get("pass_id")) for e in season.get("entrants") or []}
            return str(op.args.get("pass_id")) in passes
        if op.method == "start_season":
            return status in ("Running", "Settled")
        if op.method == "settle_season":
            return status == "Settled"
        if op.method == "cancel_season":
            return status == "Cancelled"
        return False

    def _record_tx(self, ledger: Ledger, op: Op, tx_hash: str | None, ok: bool) -> None:
        if not tx_hash:
            return
        ledger.recent_txs.insert(
            0, {"method": op.method, "tx_hash": tx_hash, "ok": ok, "at": _now()}
        )
        del ledger.recent_txs[RECENT_TX_LIMIT:]

    def _record_error(self, ledger: Ledger, op: Op, error: Exception) -> None:
        ledger.last_error = {
            "method": op.method,
            "message": _short(f"{type(error).__name__}: {error}"),
            "at": _now(),
        }

    async def _execute(self, ledger: Ledger, op: Op) -> None:
        transport_failures = 0
        while op.state == "pending":
            reason = self._skip_reason(ledger, op)
            if reason is not None:
                op.state, op.note, op.finished_at = "skipped", reason, _now()
                break
            if not op.sealed:
                self._seal(ledger, op)
                self._save(ledger)
                if op.state != "pending":
                    break

            op.attempts += 1
            try:
                result = await self.client.call(
                    op.method, op.args, deposit_yocto=int(op.deposit_yocto), gas=self.gas
                )
            except TransportError as e:
                transport_failures += 1
                self._record_error(ledger, op, e)
                self.chain_error = ledger.last_error
                self._save(ledger)
                logger.warning(
                    "settler: %s for %s not confirmed (attempt %d): %s",
                    op.method, ledger.season_id, op.attempts, e,
                )
                await asyncio.sleep(self._backoff(transport_failures))
                continue
            except (NearError, Exception) as e:  # ContractError, RequestError, bugs
                self._record_tx(ledger, op, getattr(e, "tx_hash", None), ok=False)
                if isinstance(e, ContractError) and self._adjust_deposit(op, str(e)):
                    self._save(ledger)
                    continue
                if isinstance(e, ContractError) and await self._already_applied(ledger, op):
                    op.state, op.note, op.finished_at = "done", "already applied on chain", _now()
                    self._on_success(ledger, op, None)
                    break
                op.rejections += 1
                self._record_error(ledger, op, e)
                logger.warning(
                    "settler: %s for %s rejected (%d/%d): %s",
                    op.method, ledger.season_id, op.rejections, self.max_rejections, e,
                )
                if op.rejections >= self.max_rejections:
                    op.state, op.note, op.finished_at = "failed", _short(str(e)), _now()
                    self._on_failure(ledger, op)
                    break
                self._save(ledger)
                await asyncio.sleep(self._backoff(op.rejections + 1))
                continue

            self.chain_error = None
            self._record_tx(ledger, op, result.tx_hash, ok=True)
            if op.method == "report_events" and self._resequence(ledger, op, result):
                self._save(ledger)
                continue
            op.state, op.tx_hash, op.finished_at = "done", result.tx_hash, _now()
            self._on_success(ledger, op, result)

        self._save(ledger)
        self._retire_if_idle(ledger)

    @staticmethod
    def _adjust_deposit(op: Op, message: str) -> bool:
        """Operator calls attach nothing. A contract may still guard a method
        that pays out to an account with near-sdk's assert_one_yocto; it then
        says so in its panic, and the call is resent with exactly 1 yocto.
        Once only: near-sdk refuses any deposit on a non-payable method."""
        if op.deposit_yocto == "0" and "Requires attached deposit of exactly 1 yoctoNEAR" in message:
            op.deposit_yocto = "1"
            op.note = "contract requires 1 yocto; resent with it"
            return True
        return False

    def _resequence(self, ledger: Ledger, op: Op, result: TxResult) -> bool:
        """The contract answered our batch as already applied, and its next
        expected ``seq`` is past ours: our counter fell behind the chain (a
        lost ledger). Resend these events once under the chain's number."""
        value = result.value if isinstance(result.value, dict) else {}
        expected, sent = value.get("next_seq"), op.args.get("seq", 0)
        if op.resequenced or not isinstance(expected, int) or expected <= sent + 1:
            return False
        if value.get("applied") not in (0, None):
            return False
        logger.warning(
            "settler: %s seq %s was behind the chain (next %s); resending",
            ledger.season_id, sent, expected,
        )
        op.resequenced = True
        ledger.next_seq = expected
        op.args = {**op.args, "seq": expected}
        return True

    def _on_success(self, ledger: Ledger, op: Op, result: TxResult | None) -> None:
        method = op.method
        if method == "create_season":
            ledger.status = ledger.status or "Open"
        elif method == "enter_season":
            pass_id = op.args["pass_id"]
            if pass_id in ledger.pending_entries:
                ledger.pending_entries.remove(pass_id)
            if pass_id not in ledger.entrants:
                ledger.entrants.append(pass_id)
        elif method == "start_season":
            ledger.status = "Running"
        elif method == "lock_market":
            ledger.locked = True
        elif method == "report_events":
            seq = int(op.args.get("seq", 0))
            nxt = result.value.get("next_seq") if result and isinstance(result.value, dict) else None
            ledger.next_seq = max(ledger.next_seq, seq + 1, nxt if isinstance(nxt, int) else 0)
        elif method == "settle_season":
            ledger.status = "Settled"
        elif method == "cancel_season":
            ledger.status = "Cancelled"

    def _on_failure(self, ledger: Ledger, op: Op) -> None:
        method = op.method
        if method == "create_season":
            ledger.create_failed = True
        elif method == "enter_season":
            pass_id = op.args["pass_id"]
            if pass_id in ledger.pending_entries:
                ledger.pending_entries.remove(pass_id)
        elif method == "start_season":
            # The stakes are in an Open season that will never run: refund.
            ledger.start_failed = True
            self._save(ledger)
            self.cancel_season(ledger.season_id)
        elif method == "settle_season":
            # Leaving it Running would hold every entrant's stake, and keep
            # the house passes out of all later seasons. Refund instead.
            self._save(ledger)
            self.cancel_season(ledger.season_id)

    # ------------------------------------------------------------------
    # Visibility
    # ------------------------------------------------------------------

    def queue_depth(self, season_id: str | None = None) -> int:
        if season_id is not None:
            ledger = self._ledgers.get(season_id)
            return len(ledger.pending()) if ledger else 0
        return sum(len(ledger.pending()) for ledger in self._ledgers.values())

    def status(self, season_id: str) -> dict:
        """The ``near`` block of the world state the spectator polls."""
        ledger = self._ledger(season_id)
        block: dict[str, Any] = {
            "enabled": True,
            "contract_id": self.contract_id,
            "season_id": season_id,
            "tracked": ledger is not None,
        }
        if ledger is None:
            return block
        block.update({
            "season_status": ledger.status,
            "queue_depth": len(ledger.pending()),
            "queue_depth_total": self.queue_depth(),
            "last_error": ledger.last_error,
            "chain_error": self.chain_error,
            "failed_calls": sum(1 for op in ledger.ops if op.state == "failed"),
            "recent_txs": [
                {**tx, "url": explorer_tx_url(self.contract_id, tx["tx_hash"])}
                for tx in ledger.recent_txs
            ],
        })
        return block
