#!/usr/bin/env python3
"""Build the Zotero XPI and its update manifest using only Python's stdlib."""

import argparse
import hashlib
import io
import json
from pathlib import Path
import re
from urllib.parse import quote
import zipfile


ROOT = Path(__file__).resolve().parents[1]


def repository(value):
    pattern = r"[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9_.-]{1,100}"
    if not re.fullmatch(pattern, value):
        raise argparse.ArgumentTypeError("use a GitHub repository in OWNER/REPO form")
    owner, name = value.split("/")
    if owner.endswith("-") or name in {".", ".."}:
        raise argparse.ArgumentTypeError("invalid GitHub owner or repository name")
    return value


def branch_name(value):
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._/-]*", value):
        raise argparse.ArgumentTypeError("use a branch name such as main or release/stable")
    if ".." in value or "//" in value or value.endswith(("/", ".", ".lock")):
        raise argparse.ArgumentTypeError("invalid branch name")
    return value


def encode_json(value):
    return (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def build_xpi(manifest):
    retain = (ROOT / "src" / "retain.js").read_text(encoding="utf-8").strip()
    watcher = (ROOT / "src" / "watcher.js").read_text(encoding="utf-8").strip()
    if watcher.startswith('"use strict";'):
        watcher = watcher[len('"use strict";'):].lstrip()
    bootstrap = ('"use strict";\n\n' + retain + "\n\n" + watcher + "\n").encode("utf-8")
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name, data in (("manifest.json", encode_json(manifest)), ("bootstrap.js", bootstrap)):
            entry = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            entry.compress_type = zipfile.ZIP_DEFLATED
            entry.create_system = 3
            entry.external_attr = 0o100644 << 16
            archive.writestr(entry, data, compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
    return output.getvalue()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=repository, required=True, metavar="OWNER/REPO")
    parser.add_argument("--branch", type=branch_name, default="main")
    parser.add_argument(
        "--out-dir", type=Path,
        help="write both generated files here instead of dist/ and the repository root",
    )
    args = parser.parse_args()

    manifest = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
    version = manifest["version"]
    if not re.fullmatch(r"[0-9]+(?:\.[0-9]+){1,3}", version):
        parser.error("manifest.json version must contain 2 to 4 numeric components")
    application = manifest["applications"]["zotero"]
    encoded_branch = quote(args.branch, safe="/")
    application["update_url"] = (
        f"https://raw.githubusercontent.com/{args.repo}/{encoded_branch}/updates.json"
    )
    filename = f"Zotero-RetainPDF-Bridge-{version}.xpi"
    xpi = build_xpi(manifest)
    update = {
        "addons": {
            application["id"]: {
                "updates": [{
                    "version": version,
                    "update_link": f"https://github.com/{args.repo}/releases/download/v{version}/{filename}",
                    "update_hash": "sha256:" + hashlib.sha256(xpi).hexdigest(),
                    "applications": {
                        "zotero": {
                            "strict_min_version": application["strict_min_version"],
                            "strict_max_version": application["strict_max_version"],
                        }
                    },
                }]
            }
        }
    }
    release_dir = args.out_dir if args.out_dir else ROOT / "dist"
    update_file = (args.out_dir if args.out_dir else ROOT) / "updates.json"
    release_dir.mkdir(parents=True, exist_ok=True)
    update_file.parent.mkdir(parents=True, exist_ok=True)
    xpi_file = release_dir / filename
    xpi_file.write_bytes(xpi)
    update_file.write_bytes(encode_json(update))
    print(f"XPI: {xpi_file}")
    print(f"Update manifest: {update_file}")
    print(f"Release tag: v{version}")


if __name__ == "__main__":
    main()
