"""Let the Worker's modules import outside the Workers runtime.

`js`, `pyodide` and `workers` only exist inside Cloudflare's Python runtime.
Rather than reshape production code to be testable, stand in for those three
modules here. Only the pieces the pure functions actually touch are faked;
anything that reaches D1, R2 or the network is not covered by these tests.
"""

import asyncio
import json
import sys
import types
from pathlib import Path

import pytest


SRC = Path(__file__).resolve().parents[1] / "src"


class _FakeTypedArray:
    """Enough of Uint8Array for `secure_bytes` and the image routes."""

    def __init__(self, source):
        if isinstance(source, (bytes, bytearray)):
            self._values = bytes(source)
        else:
            # Deterministic rather than random: tests should not depend on
            # chance, and no test asserts anything about the values.
            self._values = bytes((index * 7 + 13) % 256 for index in range(int(source)))

    def to_py(self):
        return self._values


class _FakeUint8Array:
    @staticmethod
    def new(source):
        # The real one takes either a length or a buffer. `secure_bytes` passes
        # a length; the image routes pass what R2 handed back.
        return _FakeTypedArray(source)


class FakeResponse:
    """Stands in for the runtime's Response so handlers can be inspected."""

    def __init__(self, body="", status: int = 200, headers: dict | None = None):
        self.body = body
        self.status = status
        self.headers = {key.lower(): value for key, value in (headers or {}).items()}

    def json(self):
        return json.loads(self.body)


def _install_runtime_stubs() -> None:
    js = types.ModuleType("js")
    js.Object = types.SimpleNamespace(fromEntries=lambda pairs: dict(pairs))
    js.Uint8Array = _FakeUint8Array
    js.crypto = types.SimpleNamespace(getRandomValues=lambda values: values)
    js.fetch = lambda *args, **kwargs: None
    sys.modules["js"] = js

    pyodide = types.ModuleType("pyodide")
    ffi = types.ModuleType("pyodide.ffi")
    ffi.to_js = lambda value, **kwargs: value
    pyodide.ffi = ffi
    sys.modules["pyodide"] = pyodide
    sys.modules["pyodide.ffi"] = ffi

    workers = types.ModuleType("workers")
    workers.Response = FakeResponse
    workers.WorkerEntrypoint = object
    # The real one hands the coroutine to the runtime to finish after the
    # response is sent. Scheduling it on the running loop is the closest
    # equivalent a test can offer: the handler does not wait for it either.
    workers.wait_until = asyncio.ensure_future
    sys.modules["workers"] = workers


_install_runtime_stubs()
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))


# Stand-ins for the bindings, shared by the two routing suites. They live here
# rather than in either suite because both Workers are driven the same way and
# a second copy would drift from the first.

STOREFRONT_ORIGIN = "https://luma-studio.tw"
ADMIN_ORIGIN = "https://admin.luma-studio.tw"


class FakeStatement:
    def __init__(self, sql: str, rows_for, changes_for):
        self.sql = sql
        self._rows_for = rows_for
        self._changes_for = changes_for
        self.bindings: tuple = ()

    def bind(self, *values):
        self.bindings = values
        return self

    async def run(self):
        # D1 reports affected rows as meta.changes, which is how the shop
        # tells "took the last one" from "somebody else got there first".
        return types.SimpleNamespace(
            success=True, meta=types.SimpleNamespace(changes=self._changes_for(self.sql))
        )

    async def all(self):
        return types.SimpleNamespace(results=self._rows_for(self.sql, self.bindings))


class FakeDatabase:
    """Answers with whatever the test declared for a matching statement.

    `answers` maps a fragment of SQL to the rows it should return; `changes`
    maps one to the affected-row count a write should report. Both match on
    substring, so a test names only the part it cares about.
    """

    def __init__(self, answers: dict[str, list] | None = None, changes: dict[str, int] | None = None):
        self.answers = answers or {}
        self.changes = changes or {}
        self.statements: list[str] = []
        self.writes: list[tuple[str, tuple]] = []

    def prepare(self, sql: str):
        flat = " ".join(sql.split())
        self.statements.append(flat)
        statement = FakeStatement(sql, self._rows_for, self._changes_for)
        self._record(statement, flat)
        return statement

    def _record(self, statement, flat: str):
        original_run = statement.run

        async def run():
            self.writes.append((flat, statement.bindings))
            return await original_run()

        statement.run = run

    def _rows_for(self, sql: str, _bindings):
        for fragment, rows in self.answers.items():
            if fragment in " ".join(sql.split()):
                return rows
        return []

    def _changes_for(self, sql: str) -> int:
        flat = " ".join(sql.split())
        for fragment, count in self.changes.items():
            if fragment in flat:
                return count
        return 1


class FakeBucket:
    def __init__(self, objects: dict | None = None):
        self.objects = objects or {}
        self.deleted: list[str] = []

    async def get(self, key):
        return self.objects.get(key)

    async def put(self, key, content):
        self.objects[key] = FakeObject(content)

    async def delete(self, key):
        self.deleted.append(key)
        self.objects.pop(key, None)


class FakeObject:
    """What R2 hands back: bytes reachable only through arrayBuffer()."""

    def __init__(self, content: bytes):
        self.content = bytes(content)

    async def arrayBuffer(self):
        return self.content


class FakeHeaders:
    def __init__(self, values: dict):
        self._values = {key.lower(): value for key, value in values.items()}

    def get(self, name):
        return self._values.get(name.lower())


class FakeRequest:
    def __init__(self, path: str, method: str = "GET", headers: dict | None = None, host: str = "api.luma-studio.tw"):
        self.url = f"https://{host}{path}"
        self.method = method
        self.headers = FakeHeaders(headers or {})
        self.cf = None


class DenyingLimiter:
    async def limit(self, _options):
        return types.SimpleNamespace(success=False)


def make_env(database=None, bucket=None, *, origins: str | None = None, frontend: str | None = None, **extra):
    return types.SimpleNamespace(
        DB=database or FakeDatabase(),
        IBON_IMAGES=bucket or FakeBucket(),
        ALLOWED_ORIGINS=origins if origins is not None else f"{STOREFRONT_ORIGIN},https://www.luma-studio.tw",
        FRONTEND_ORIGIN=frontend if frontend is not None else STOREFRONT_ORIGIN,
        **extra,
    )


@pytest.fixture
def bio_link():
    import bio_link as module

    return module


@pytest.fixture
def ibon():
    import ibon as module

    return module


@pytest.fixture
def common():
    import common as module

    return module
