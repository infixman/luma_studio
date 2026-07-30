"""What the desktop tool may download from us, and under what name.

The tool runs one pinned FFmpeg and no other — the output filenames end up in
object keys the playback gateway validates, so a different build is a different
set of names and the failure lands on a member watching a lesson. It fetches that
build from our own mirror rather than from an official URL, because official URLs
move and old builds are removed.

Which means this module answers a request that names a file. That is the shape of
every path-traversal bug, so the name is matched against a pattern rather than
cleaned: a sanitiser has to anticipate every way of writing `..`, and a pattern
only has to describe what a file name looks like.
"""

import re

# Everything the mirror holds lives here: the archive the tool installs, and the
# corresponding source the GPL requires us to keep alongside it.
PREFIX = "ffmpeg/"

# One path segment, starting with something visible. No separators, no leading
# dot, nothing that could be `..` — all of which follow from the character set
# rather than from a list of things to reject.
NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$")

# Archives only. Not because an executable would be dangerous sitting in a
# bucket, but because this route exists to hand over something the tool verifies
# by digest before unpacking. Anything else arriving here means the mirror holds
# a file nobody planned for, and answering 404 is how that gets noticed.
SUFFIXES = (".zip", ".7z", ".tar.xz", ".tar.bz2", ".tar.gz")

# How long a client may keep it. The names are version-stamped and the tool
# checks a digest, so a stale copy is impossible rather than merely unlikely.
CACHE_SECONDS = 31_536_000


def mirror_key(name: str) -> str | None:
    """The object key for `name`, or None if it is not a name we serve.

    Case is preserved. R2 keys are case-sensitive, so folding it here would ask
    for an object that is not there and fail as a missing mirror.
    """

    if not NAME.fullmatch(name or ""):
        return None
    if not name.lower().endswith(SUFFIXES):
        return None
    return f"{PREFIX}{name}"
