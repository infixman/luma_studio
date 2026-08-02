"""What the CI workflows have to get right about the machine they run on.

A workflow is code nobody can run before pushing it, and the release one runs on
Windows — where the default shell is PowerShell. A step that reads `$VERSION`
there is reading a PowerShell variable that was never set, not the environment,
and PowerShell does not fall back: it stops. The release fails at the step that
was supposed to name the build, after the checkout and the install have already
run.

That is what happened on the first real release. These tests are the cheapest
thing that would have caught it.
"""

import pathlib
import re

import pytest
import yaml


WORKFLOWS = sorted((pathlib.Path(__file__).resolve().parents[2] / ".github" / "workflows").glob("*.yml"))

# `$NAME` and `${NAME}`, but not `${{ github.event... }}` — that one is resolved
# by Actions before any shell sees it, and is the same in every shell.
SHELL_VARIABLE = re.compile(r"(?<!\$)\$(?:\{(?!\{)[A-Za-z_]|[A-Za-z_])")


def steps_of(workflow: pathlib.Path):
    definition = yaml.safe_load(workflow.read_text(encoding="utf8"))
    for job_name, job in (definition.get("jobs") or {}).items():
        runs_on = str(job.get("runs-on", ""))
        for step in job.get("steps") or []:
            if "run" in step:
                yield job_name, runs_on, step


@pytest.mark.parametrize("workflow", WORKFLOWS, ids=lambda path: path.name)
def test_a_windows_step_that_reads_a_variable_says_which_shell(workflow):
    """PowerShell is the default there, and it does not read the environment
    the way these scripts assume. Naming the shell is the whole fix; not naming
    it is a step that fails only once it is on a runner."""

    offenders = [
        f"{job}: {step.get('name', step['run'][:40])}"
        for job, runs_on, step in steps_of(workflow)
        if "windows" in runs_on and SHELL_VARIABLE.search(step["run"]) and step.get("shell") != "bash"
    ]

    assert offenders == []


@pytest.mark.parametrize("workflow", WORKFLOWS, ids=lambda path: path.name)
def test_every_bash_step_stops_at_the_first_failure(workflow):
    """`set -euo pipefail`, because a multi-line `run` otherwise carries on
    after a failed line and reports the exit code of the last one. On the
    release workflow that means an upload loop that skipped a file and a job
    that went green anyway."""

    lax = [
        f"{job}: {step.get('name', step['run'][:40])}"
        for job, _runs_on, step in steps_of(workflow)
        if step.get("shell") == "bash" and "\n" in step["run"].strip() and "set -euo pipefail" not in step["run"]
    ]

    assert lax == []
