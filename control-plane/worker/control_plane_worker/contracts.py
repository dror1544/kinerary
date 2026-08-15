"""Python representation of the shared provider-neutral adapter envelopes."""
from __future__ import annotations

from dataclasses import asdict, dataclass, field
import re
from typing import Any, Mapping


_OPAQUE_ID = re.compile(r"^[a-z]{2,8}_[A-Za-z0-9]{8,64}$")
_OPERATIONS = {"inspect", "create", "verify", "delete", "inventory"}


@dataclass(frozen=True)
class AdapterRequest:
    request_id: str
    correlation_id: str
    idempotency_key: str
    adapter: str
    operation: str
    payload: Mapping[str, Any]
    test_run_id: str | None = None
    schema_version: int = field(default=1, init=False)

    def __post_init__(self) -> None:
        for name in ("request_id", "correlation_id"):
            if not _OPAQUE_ID.fullmatch(getattr(self, name)):
                raise ValueError(f"{name} must be an opaque contract ID")
        if len(self.idempotency_key) < 8:
            raise ValueError("idempotency_key must contain at least 8 characters")
        if self.operation not in _OPERATIONS:
            raise ValueError("unsupported adapter operation")

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class AdapterResult:
    request_id: str
    correlation_id: str
    idempotency_key: str
    adapter: str
    operation: str
    status: str
    changed: bool
    safe_error_code: str | None = None
    data: Mapping[str, Any] | None = None
    schema_version: int = field(default=1, init=False)

    def __post_init__(self) -> None:
        if self.status not in {"succeeded", "failed", "not_found"}:
            raise ValueError("invalid adapter result status")
        if self.status == "failed" and not self.safe_error_code:
            raise ValueError("failed adapter results require a safe error code")

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)
