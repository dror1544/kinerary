"""The one place a worker test learns which database it may write to.

The Python half of ``control-plane/api/test/support/test-database.ts``, and it
exists for the same reason. These tests do not drop schemas — they insert trips,
bindings and jobs — so pointed at the dev stack's database they do not destroy
it, they contaminate it. That has already happened once: an errored setUp left
fifteen ``prov-test-*`` trips behind in the shared database, which then had to
be found and cleaned by hand.

The rule matches the TypeScript guard exactly: the database NAME must say it is
for tests. Two doors onto the same hazard should not have two different rules,
or the next person will learn one of them and trust it at the other.
"""

from __future__ import annotations

import os
from urllib.parse import urlparse, unquote

# Kept identical to TEST_NAME_PATTERN in the TypeScript guard.
_TEST_NAME = "test"

_GUIDANCE = (
    'CONTROL_PLANE_TEST_DATABASE_URL names the database "{name}", which does '
    "not look like a scratch database.\n\n"
    "These tests write trips, bindings and jobs into whatever database they "
    "are given, so pointing them at a real one contaminates it. The dev "
    "stack's own database is exactly the mistake this catches.\n\n"
    "Use the scratch database instead:\n"
    '  CONTROL_PLANE_TEST_DATABASE_URL="postgres://postgres:test@127.0.0.1:5434/cptest"\n\n'
    "Or leave it unset to skip the database-backed tests."
)


class UnsafeTestDatabaseError(RuntimeError):
    """Raised when the configured database is not safe to write test rows into."""


def database_name_of(connection_string: str) -> str | None:
    """The database name in a Postgres URL, or None when there is not one."""
    try:
        parsed = urlparse(connection_string)
    except ValueError:
        return None
    name = (parsed.path or "").lstrip("/")
    return unquote(name) or None


def is_test_database_url(connection_string: str) -> bool:
    """Whether this URL names a database these tests may write to."""
    name = database_name_of(connection_string)
    return name is not None and _TEST_NAME in name.lower()


def test_database_url(raw: str | None = None) -> str | None:
    """The database URL for DB-backed tests, or None when none is configured.

    Unset returns None, and the callers turn that into a skip — running without
    a database is a supported state. Set-but-unsafe raises, because a skip would
    hide the misconfiguration rather than correct it.
    """
    value = (raw if raw is not None else os.environ.get("CONTROL_PLANE_TEST_DATABASE_URL") or "").strip()
    if not value:
        return None
    if is_test_database_url(value):
        return value
    raise UnsafeTestDatabaseError(_GUIDANCE.format(name=database_name_of(value) or "<none>"))
