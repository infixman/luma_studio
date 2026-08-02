"""Turn production's test payment on or off, and deploy.

`ALLOW_FAKE_PAYMENT` marks an order paid with no gateway involved. It exists so
the order lifecycle can be walked before PAYUNi is wired up, and it is the one
switch that must be off the day the shop opens: with it on, any signed-in
customer can mark their own order paid.

    python scripts/fake_payment.py on
    python scripts/fake_payment.py off

The value lives in `backend/wrangler.toml` and is deployed with the Worker, so
this edits the file and then deploys. Changing it in the Cloudflare dashboard
instead works until the next deploy from this repository quietly puts it back —
`[vars]` is declarative and wrangler overwrites the whole set.
"""

import pathlib
import re
import subprocess
import sys


ROOT = pathlib.Path(__file__).resolve().parent.parent
CONFIG = ROOT / "backend" / "wrangler.toml"
FLAG = "ALLOW_FAKE_PAYMENT"


def set_flag(config: str, value: str) -> str:
    """The same file with the flag set, or a refusal.

    Matched on the assignment rather than rewritten wholesale, and it raises
    when the line is absent: a script that silently changes nothing would report
    a successful deploy of the setting it did not change.
    """

    pattern = re.compile(rf'^{FLAG}\s*=\s*"[^"]*"$', re.MULTILINE)
    if not pattern.search(config):
        raise LookupError(f"{FLAG} is not set in {CONFIG.name}")
    return pattern.sub(f'{FLAG} = "{value}"', config)


def main(argv: list[str]) -> int:
    wanted = (argv[1] if len(argv) > 1 else "").strip().lower()
    if wanted not in {"on", "off"}:
        print(__doc__)
        return 2

    value = "1" if wanted == "on" else "0"
    config = CONFIG.read_text(encoding="utf8")
    CONFIG.write_text(set_flag(config, value), encoding="utf8")

    print(f"{FLAG} = \"{value}\" — deploying the public Worker…")
    deployed = subprocess.run(
        ["uv", "run", "pywrangler", "deploy"], cwd=ROOT / "backend", shell=True
    )
    if deployed.returncode != 0:
        print("\nThe deploy failed, so production is unchanged. The file is not:")
        print(f"  check `git diff {CONFIG.relative_to(ROOT)}` before doing anything else.")
        return deployed.returncode

    if value == "1":
        print("\n測試付款已開啟。任何登入的顧客都能把自己的訂單標成已付。")
        print("開賣前務必關掉：python scripts/fake_payment.py off")
    else:
        print("\n測試付款已關閉。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
