"""NEAR transaction encoding: base58, ed25519 keys, Borsh, signing.

Pure functions, no I/O. Only the one shape the settler needs is
implemented: a transaction carrying a single ``FunctionCall`` action,
signed with an ed25519 key.

Layout (Borsh, little-endian integers, ``u32`` length prefixes)::

    Transaction {
        signer_id:   string
        public_key:  u8 key type (0 = ed25519) + [u8; 32]
        nonce:       u64
        receiver_id: string
        block_hash:  [u8; 32]
        actions:     u32 count + Action*
    }
    Action::FunctionCall = u8 2 + {
        method_name: string, args: u32 len + bytes, gas: u64, deposit: u128
    }
    SignedTransaction = Transaction + u8 key type + [u8; 64] signature

The transaction hash is sha256 of the Borsh-encoded ``Transaction``; the
signature is ed25519 over that hash, and the hash's base58 form is the id
explorers show.
"""

from __future__ import annotations

import base64
import hashlib
import json
import struct
from dataclasses import dataclass

from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PrivateKey,
    Ed25519PublicKey,
)
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

_B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
_B58_INDEX = {c: i for i, c in enumerate(_B58_ALPHABET)}

KEY_TYPE_ED25519 = 0
ACTION_FUNCTION_CALL = 2
U64_MAX = (1 << 64) - 1
U128_MAX = (1 << 128) - 1


def b58encode(data: bytes) -> str:
    num = int.from_bytes(data, "big")
    out = []
    while num:
        num, rem = divmod(num, 58)
        out.append(_B58_ALPHABET[rem])
    pad = len(data) - len(data.lstrip(b"\0"))
    return "1" * pad + "".join(reversed(out))


def b58decode(text: str) -> bytes:
    num = 0
    for char in text:
        try:
            num = num * 58 + _B58_INDEX[char]
        except KeyError:
            raise ValueError("invalid base58 character") from None
    body = num.to_bytes((num.bit_length() + 7) // 8, "big") if num else b""
    pad = len(text) - len(text.lstrip("1"))
    return b"\0" * pad + body


@dataclass(frozen=True)
class KeyPair:
    """An ed25519 signing key. ``repr`` never shows the secret."""

    _private: Ed25519PrivateKey
    public_key: bytes  # 32 raw bytes

    @classmethod
    def from_secret(cls, secret: str) -> KeyPair:
        """Parse ``ed25519:<base58>`` as NEAR tools write it: 64 bytes (seed
        followed by public key) or a bare 32-byte seed.

        Errors never echo the input, since the input is a secret."""
        text = secret.strip()
        if text.startswith("ed25519:"):
            text = text[len("ed25519:"):]
        elif ":" in text:
            raise ValueError("only ed25519 secret keys are supported")
        try:
            raw = b58decode(text)
        except ValueError:
            raise ValueError("secret key is not valid base58") from None
        if len(raw) not in (32, 64):
            raise ValueError("secret key must decode to 32 or 64 bytes")
        private = Ed25519PrivateKey.from_private_bytes(raw[:32])
        public = private.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
        if len(raw) == 64 and raw[32:] != public:
            raise ValueError("secret key's embedded public key does not match its seed")
        return cls(private, public)

    @property
    def public_key_str(self) -> str:
        return "ed25519:" + b58encode(self.public_key)

    def sign(self, message: bytes) -> bytes:
        return self._private.sign(message)

    def __repr__(self) -> str:
        return f"KeyPair(public_key={self.public_key_str!r})"


def verify(public_key: bytes, signature: bytes, message: bytes) -> bool:
    try:
        Ed25519PublicKey.from_public_bytes(public_key).verify(signature, message)
    except Exception:
        return False
    return True


# --- Borsh primitives ------------------------------------------------------


def _u8(value: int) -> bytes:
    return struct.pack("<B", value)


def _u32(value: int) -> bytes:
    return struct.pack("<I", value)


def _u64(value: int) -> bytes:
    if not 0 <= value <= U64_MAX:
        raise ValueError("u64 out of range")
    return struct.pack("<Q", value)


def _u128(value: int) -> bytes:
    if not 0 <= value <= U128_MAX:
        raise ValueError("u128 out of range")
    return value.to_bytes(16, "little")


def _string(value: str) -> bytes:
    raw = value.encode("utf-8")
    return _u32(len(raw)) + raw


def _bytes(value: bytes) -> bytes:
    return _u32(len(value)) + value


def encode_args(args: dict) -> bytes:
    """JSON arguments exactly as they go on chain (compact, stable order)."""
    return json.dumps(args, separators=(",", ":")).encode("utf-8")


def serialize_function_call_tx(
    *,
    signer_id: str,
    public_key: bytes,
    nonce: int,
    receiver_id: str,
    block_hash: bytes,
    method_name: str,
    args: bytes,
    gas: int,
    deposit: int,
) -> bytes:
    if len(public_key) != 32:
        raise ValueError("public key must be 32 bytes")
    if len(block_hash) != 32:
        raise ValueError("block hash must be 32 bytes")
    action = (
        _u8(ACTION_FUNCTION_CALL)
        + _string(method_name)
        + _bytes(args)
        + _u64(gas)
        + _u128(deposit)
    )
    return (
        _string(signer_id)
        + _u8(KEY_TYPE_ED25519)
        + public_key
        + _u64(nonce)
        + _string(receiver_id)
        + block_hash
        + _u32(1)
        + action
    )


@dataclass(frozen=True)
class SignedTx:
    tx_hash: str  # base58 sha256 of the unsigned transaction
    signed_b64: str  # base64 SignedTransaction, as send_tx expects


def sign_function_call(
    key: KeyPair,
    *,
    signer_id: str,
    receiver_id: str,
    nonce: int,
    block_hash: bytes,
    method_name: str,
    args: bytes,
    gas: int,
    deposit: int,
) -> SignedTx:
    body = serialize_function_call_tx(
        signer_id=signer_id,
        public_key=key.public_key,
        nonce=nonce,
        receiver_id=receiver_id,
        block_hash=block_hash,
        method_name=method_name,
        args=args,
        gas=gas,
        deposit=deposit,
    )
    digest = hashlib.sha256(body).digest()
    signature = key.sign(digest)
    signed = body + _u8(KEY_TYPE_ED25519) + signature
    return SignedTx(
        tx_hash=b58encode(digest),
        signed_b64=base64.b64encode(signed).decode("ascii"),
    )
