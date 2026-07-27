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
    """Enough of Uint8Array for `secure_bytes` to produce real bytes."""

    def __init__(self, length: int):
        # Deterministic rather than random: tests should not depend on chance,
        # and no test asserts anything about the values themselves.
        self._values = bytes((index * 7 + 13) % 256 for index in range(length))

    def to_py(self):
        return self._values


class _FakeUint8Array:
    @staticmethod
    def new(length):
        return _FakeTypedArray(int(length))


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
    def __init__(self, sql: str, rows_for):
        self.sql = sql
        self._rows_for = rows_for
        self.bindings: tuple = ()

    def bind(self, *values):
        self.bindings = values
        return self

    async def run(self):
        return types.SimpleNamespace(success=True)

    async def all(self):
        return types.SimpleNamespace(results=self._rows_for(self.sql, self.bindings))


class FakeDatabase:
    """Answers with whatever the test declared for a matching statement."""

    def __init__(self, answers: dict[str, list] | None = None):
        self.answers = answers or {}
        self.statements: list[str] = []

    def prepare(self, sql: str):
        self.statements.append(" ".join(sql.split()))
        return FakeStatement(sql, self._rows_for)

    def _rows_for(self, sql: str, _bindings):
        for fragment, rows in self.answers.items():
            if fragment in " ".join(sql.split()):
                return rows
        return []


class FakeBucket:
    def __init__(self, objects: dict | None = None):
        self.objects = objects or {}

    async def get(self, key):
        return self.objects.get(key)


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
