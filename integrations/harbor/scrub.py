"""Take secrets out of every file under a directory before it is uploaded as an artifact.

    SECRET=... SECRET_2=... python integrations/harbor/scrub.py jobs/

Two of the agents run with the API key in their environment, inside a
container where the model runs commands: one `env` and the key is in the
transcript, and a public repository's artifacts can be downloaded by anyone
signed in to GitHub. Text files get each key replaced; any other file holding
one is deleted. The secrets are read from the environment (SECRET, and
SECRET_ followed by anything), never from arguments, and never printed.
Exits non-zero if any copy is left.

Symbolic links are deleted first, whatever they point to: the log directory
is mounted into the container, so a link made there would be followed on
the runner by the upload, to whatever file of the runner it names.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

MARK = b"[REDACTED]"


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: SECRET=... scrub.py <dir>", file=sys.stderr)
        return 2
    secrets = sorted(
        {value.strip().encode() for name, value in os.environ.items() if (name == "SECRET" or name.startswith("SECRET_")) and value.strip()},
        key=len,
        reverse=True,  # a longer key first, in case one key contains another
    )
    root = Path(sys.argv[1])
    if not root.is_dir():
        print(f"{root} is not a directory")
        return 0
    links = [p for p in root.rglob("*") if p.is_symlink()]
    for link in links:
        link.unlink()
    print(f"deleted {len(links)} symbolic link(s)")
    if not secrets:
        print("no secret to scrub")
        return 0
    if any(len(secret) < 8 for secret in secrets):
        print("refusing a secret shorter than 8 bytes: it would match ordinary text", file=sys.stderr)
        return 2

    def holds(data: bytes) -> bool:
        return any(secret in data for secret in secrets)

    redacted = deleted = 0
    for path in sorted(p for p in root.rglob("*") if p.is_file() and not p.is_symlink()):
        data = path.read_bytes()
        if not holds(data):
            continue
        try:
            data.decode("utf-8")
        except UnicodeDecodeError:
            path.unlink()
            deleted += 1
            continue
        for secret in secrets:
            data = data.replace(secret, MARK)
        path.write_bytes(data)
        redacted += 1

    left = [p for p in root.rglob("*") if p.is_file() and not p.is_symlink() and holds(p.read_bytes())]
    print(f"{len(secrets)} secret(s): redacted {redacted} file(s), deleted {deleted}; {len(left)} still hold one")
    return 1 if left else 0


if __name__ == "__main__":
    sys.exit(main())
