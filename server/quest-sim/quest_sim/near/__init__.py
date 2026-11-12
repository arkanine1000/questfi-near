"""On-chain settlement of Agent Island seasons on NEAR.

Off unless ``QUEST_SIM_NEAR_ENABLED`` is set. When on, the server acts as
the season contract's operator: it opens a season per world, enters its
house agents' passes, reports kills and dungeon clears, and settles the
winner. The contract trusts it to report the game truthfully; see
``settler.py`` for the trust model and the delivery guarantees.

- ``tx``: transaction encoding and ed25519 signing
- ``rpc``: the JSON-RPC client that signs and sends
- ``client``: the client interface, its errors, and an in-memory fake
- ``settler``: the queue, the ledger, retries
- ``bridge``: which game moment becomes which contract call
"""

from __future__ import annotations

from quest_sim.near.settler import Settler

_settler: Settler | None = None

REQUIRED_SETTINGS = {
    "near_contract_id": "QUEST_SIM_NEAR_CONTRACT_ID",
    "near_operator_id": "QUEST_SIM_NEAR_OPERATOR_ID",
    "near_operator_key": "QUEST_SIM_NEAR_OPERATOR_KEY",
    "near_entry_stake": "QUEST_SIM_NEAR_ENTRY_STAKE",
}


def config_problems(settings) -> list[str]:
    """What stops the settler from running with these settings. Never
    includes a secret value."""
    problems = [
        f"{env} is not set"
        for attr, env in REQUIRED_SETTINGS.items()
        if getattr(settings, attr) in (None, "")
    ]
    key = settings.near_operator_key
    if key is not None:
        from quest_sim.near.tx import KeyPair

        try:
            KeyPair.from_secret(key.get_secret_value())
        except ValueError as e:
            problems.append(f"QUEST_SIM_NEAR_OPERATOR_KEY is not usable: {e}")
    return problems


def build_settler(settings) -> Settler:
    from quest_sim.near.rpc import NearRpcClient

    problems = config_problems(settings)
    if problems:
        raise RuntimeError("NEAR settlement is enabled but " + "; ".join(problems))
    client = NearRpcClient(
        rpc_url=settings.near_rpc_url,
        contract_id=settings.near_contract_id,
        account_id=settings.near_operator_id,
        secret_key=settings.near_operator_key.get_secret_value(),
    )
    return Settler(
        client,
        contract_id=settings.near_contract_id,
        state_dir=settings.near_state_dir,
        entry_stake_yocto=settings.near_entry_stake,
        lock_tick=settings.near_lock_tick,
        passes_file=settings.near_passes_file,
    )


def get_settler(settings) -> Settler | None:
    """The process's settler, or None when settlement is off."""
    global _settler
    if not settings.near_enabled:
        return None
    if _settler is None:
        _settler = build_settler(settings)
    return _settler


def install_settler(settler: Settler | None) -> None:
    """Replace the process's settler (tests use a fake-backed one)."""
    global _settler
    _settler = settler
