"""Let the Worker's modules import outside the Workers runtime.

`js`, `pyodide` and `workers` only exist inside Cloudflare's Python runtime.
Rather than reshape production code to be testable, stand in for those three
modules here. Only the pieces the pure functions actually touch are faked;
anything that reaches D1, R2 or the network is not covered by these tests.
"""

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
    sys.modules["workers"] = workers


_install_runtime_stubs()
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))


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
