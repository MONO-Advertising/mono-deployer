#!/usr/bin/env python3
"""Build the pinned Linux arm64 Node layer; requires Python 3 and curl.

This layer overrides the managed Node interpreter, so updating its pinned version
and checksum is our responsibility until the layer is removed. Lambda continues
to manage its OS/bootstrap. Always smoke invoke after deploying the layer.
"""
import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile

VERSION = "22.23.4"
ARCHIVE = f"node-v{VERSION}-linux-arm64.tar.xz"
# Verified against the official release manifest, 2026-10-22.
SHA256 = "6287aa46b6c375d816e63ae66d024fbbfd70404825aabdfdf898a970871d2f4b"
BASE = f"https://nodejs.org/dist/v{VERSION}"
DEST = Path(__file__).resolve().parents[1] / "build" / "node-runtime"
WRAPPER = b'''#!/bin/sh
set -eu
# Lambda passes its original Node interpreter followed by bootstrap arguments.
# Preserve every argument, including flags and whitespace, after the interpreter.
if [ "$#" -lt 1 ]; then
  echo "Missing Lambda interpreter argument" >&2
  exit 64
fi
shift
exec /opt/bin/node "$@"
'''


def download(name, destination):
    subprocess.run([
        "curl", "--fail", "--silent", "--show-error", "--location",
        "--proto", "=https", "--proto-redir", "=https", "--tlsv1.2",
        "--connect-timeout", "20", "--max-time", "300", "--retry", "2",
        "--output", str(destination), f"{BASE}/{name}",
    ], check=True)


def main():
    with tempfile.TemporaryDirectory(prefix="mono-node-layer-") as temporary:
        temporary = Path(temporary)
        manifest = temporary / "SHASUMS256.txt"
        download(manifest.name, manifest)
        checksums = dict(line.split()[::-1] for line in manifest.read_text().splitlines() if line.strip())
        if checksums.get(ARCHIVE) != SHA256:
            raise RuntimeError("Official manifest does not match the pinned archive checksum")
        archive = temporary / ARCHIVE
        download(ARCHIVE, archive)
        digest = hashlib.sha256()
        with archive.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(chunk)
        if digest.hexdigest() != SHA256:
            raise RuntimeError("Downloaded Node archive checksum mismatch")

        staging = temporary / "layer"
        (staging / "bin").mkdir(parents=True)
        # Extract only known regular files, never archive paths/symlinks wholesale.
        with tarfile.open(archive, "r:xz") as package:
            for relative in ("bin/node", "LICENSE"):
                member = package.getmember(f"node-v{VERSION}-linux-arm64/{relative}")
                if not member.isfile():
                    raise RuntimeError(f"Expected regular archive member: {relative}")
                source = package.extractfile(member)
                if source is None:
                    raise RuntimeError(f"Missing archive member: {relative}")
                with source, (staging / relative).open("wb") as target:
                    shutil.copyfileobj(source, target)
        (staging / "bin" / "node-wrapper").write_bytes(WRAPPER)
        for relative in ("bin/node", "bin/node-wrapper"):
            (staging / relative).chmod(0o755)
        (staging / "LICENSE").chmod(0o644)
        for path in (staging, staging / "bin", *staging.rglob("*")):
            os.utime(path, (0, 0))
        DEST.parent.mkdir(parents=True, exist_ok=True)
        if DEST.exists():
            shutil.rmtree(DEST)
        shutil.copytree(staging, DEST, copy_function=shutil.copy2)
        print(f"Built Node {VERSION} Linux arm64 layer at {DEST}; SHA-256 verified")


if __name__ == "__main__":
    main()
