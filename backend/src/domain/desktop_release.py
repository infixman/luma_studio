"""Which versions of the desktop tool may work, and where the installer lives.

The trap this exists for is stated in the plan: if 1.0.0 is installed and the
update mechanism turns out to be broken, there is no way to push a fix. So the
server keeps the answer to "is this build still allowed", and it has to be
answerable before the first release rather than invented after somebody needs it.

Two levers, and they are not the same. `minSupported` retires versions as they
age — a tool old enough to have a known bug in the upload path should not be
running it. `blocked` stops everything at once, including the newest, which is
what a bad release needs: it does not wait for each machine to update itself.

The installer route is the only public thing on this Worker that is not about
video, so its names are an allowlist. Sanitising would mean enumerating every way
of writing `..`; these file names are entirely predictable.

The files sit flat under `releases/` rather than in a directory per version. That
is not tidiness — electron-updater's generic provider reads `{feed}/latest.yml`
and then resolves the installer's name *relative to the feed*, so a versioned
directory means writing our own update logic. Ours would be the part nobody can
test without the machine it runs on, and the version is in the installer's name
anyway.
"""

import re

from shared.common import d1_rows


VERSION_PATTERN = re.compile(r"^\d{1,4}(?:\.\d{1,4}){0,2}$")

# Where the published files live in the tools bucket.
RELEASE_PREFIX = "releases/"

# What electron-updater fetches, and nothing else. The installer's name carries
# its version, so the pattern has to allow that rather than a fixed list.
FILE_PATTERNS = (
    re.compile(r"^latest\.yml$"),
    re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,80}\.exe$"),
    re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,80}\.exe\.blockmap$"),
)

# Before anything is published. Nothing is blocked, and the minimum is the first
# version that will exist — so a deployment that has never been configured
# behaves like one that has, rather than like one that refuses everything.
DEFAULT_POLICY = {
    "latest": "0.1.0",
    "minSupported": "0.1.0",
    "forceUpdate": False,
    "blocked": False,
    "notes": "",
    "updatedAt": 0,
}

SAVE_SQL = (
    "INSERT INTO desktop_version_policy (id, latest, min_supported, force_update, blocked,"
    " notes, updated_at) VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6)"
    " ON CONFLICT(id) DO UPDATE SET latest = excluded.latest,"
    " min_supported = excluded.min_supported, force_update = excluded.force_update,"
    " blocked = excluded.blocked, notes = excluded.notes, updated_at = excluded.updated_at"
)


def _parts(version) -> tuple[int, int, int]:
    if not isinstance(version, str) or not VERSION_PATTERN.fullmatch(version.strip()):
        raise ValueError(f"版本格式不正確：{version}")
    numbers = [int(part) for part in version.strip().split(".")]
    # electron-builder writes `1.2` in some places and `1.2.0` in others, and a
    # missing part means zero rather than "unknown".
    while len(numbers) < 3:
        numbers.append(0)
    return tuple(numbers[:3])


def compare(left, right) -> int:
    """Which of two versions is later, as a number.

    Numerically, part by part. As strings `"1.10.0" < "1.9.0"`, which would tell
    everybody running the newest build that they are out of date.
    """

    first, second = _parts(left), _parts(right)
    return (first > second) - (first < second)


def feed_url(origin: str) -> str:
    """Where an updater looks. Built from whichever deployment answered.

    Not configured: a hard-coded host would be wrong on exactly the deployment
    that is not the production one, and silently — the updater would check the
    live feed from a staging build.
    """

    return f"{origin.rstrip('/')}{'/releases'}"


def policy_row(row: dict) -> dict:
    """The stored policy, in the shape the tool and the back office read."""

    return {
        "latest": row["latest"],
        "minSupported": row["min_supported"],
        "forceUpdate": bool(row["force_update"]),
        "blocked": bool(row["blocked"]),
        "notes": row["notes"] or "",
        "updatedAt": int(row["updated_at"] or 0),
    }


def verdict(policy: dict, version) -> dict:
    """Whether this build may work, and whether there is a newer one.

    A version the server has never heard of — newer than `latest` — is allowed.
    That machine belongs to whoever is about to publish it, and refusing it would
    refuse the person doing the release.

    A version that is not a version at all is refused. Treating an unreadable one
    as current is how a corrupted install keeps uploading.
    """

    if policy["blocked"]:
        return {
            "allowed": False,
            "mustUpdate": True,
            "updateAvailable": True,
            "reason": "blocked",
        }

    try:
        behind_minimum = compare(version, policy["minSupported"]) < 0
        behind_latest = compare(version, policy["latest"]) < 0
    except ValueError:
        return {
            "allowed": False,
            "mustUpdate": True,
            "updateAvailable": True,
            "reason": "unreadableVersion",
        }

    if behind_minimum:
        return {"allowed": False, "mustUpdate": True, "updateAvailable": True, "reason": "tooOld"}
    if policy["forceUpdate"] and behind_latest:
        return {"allowed": False, "mustUpdate": True, "updateAvailable": True, "reason": "forced"}
    return {
        "allowed": True,
        "mustUpdate": False,
        "updateAvailable": behind_latest,
        "reason": "ok",
    }


async def read_policy(env) -> dict:
    rows = await d1_rows(env.DB.prepare("SELECT * FROM desktop_version_policy WHERE id = 1"))
    return policy_row(rows[0]) if rows else dict(DEFAULT_POLICY)


async def save_policy(
    env,
    *,
    latest: str,
    min_supported: str,
    force_update: bool = False,
    blocked: bool = False,
    notes: str = "",
    now: int,
) -> dict:
    """Write the one policy row.

    A minimum above the latest version is refused. It would stop every installed
    tool including the one about to be published, and it is exactly the shape a
    typo takes.
    """

    if compare(min_supported, latest) > 0:
        raise ValueError("最低支援版本不能高於最新版本")

    await env.DB.prepare(SAVE_SQL).bind(
        latest.strip(),
        min_supported.strip(),
        1 if force_update else 0,
        1 if blocked else 0,
        str(notes or "")[:2000],
        now,
    ).run()
    return await read_policy(env)


def release_key(file) -> str | None:
    """Where this file lives in the tools bucket, or nothing.

    Matched against a pattern rather than cleaned: a cleaner has to enumerate
    every way of writing `..`, and these names are produced by our own build.

    `None` rather than an exception, matching `desktop_tools.mirror_key` next
    door — both answer the same question for the same kind of route, and the
    caller turns either answer into the same 404.
    """

    if not isinstance(file, str):
        return None
    name = file.strip()
    if not any(pattern.fullmatch(name) for pattern in FILE_PATTERNS):
        return None
    return f"{RELEASE_PREFIX}{name}"
