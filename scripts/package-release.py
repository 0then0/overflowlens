"""Package the production build for local use or a tagged GitHub release."""

import argparse
import hashlib
import json
from pathlib import Path
import zipfile


def package_release(root: Path, output: Path, repository: str) -> Path:
    version = json.loads((root / "package.json").read_text(encoding="utf-8"))["version"]
    name = f"overflowlens-{version}"
    dist = root / "dist"
    if not (dist / "index.html").is_file():
        raise ValueError("Build the application first with npm run build.")
    notes = (root / "docs" / "releases" / f"v{version}.md").read_text(encoding="utf-8")
    readme = f"""# OverflowLens v{version}

Extract this archive and change into the `{name}` directory. Start a local HTTP server:

```sh
python3 -m http.server 8080 --bind 127.0.0.1
```

Open http://127.0.0.1:8080. The application files are in this directory; there is no
nested `dist` directory. Any static HTTP server also works. Use HTTPS for remote
hosting. Opening `index.html` through `file://` is unsupported.

Node.js and Go are not required to use this build. Imported files are processed
locally in your browser.

Source and documentation: https://github.com/{repository}/tree/v{version}

{notes}
"""
    output.mkdir(parents=True, exist_ok=True)
    archive = output / f"{name}.zip"
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as bundle:
        for path in sorted(dist.rglob("*")):
            if path.is_file():
                bundle.write(path, f"{name}/{path.relative_to(dist).as_posix()}")
        bundle.write(root / "LICENSE", f"{name}/LICENSE")
        bundle.writestr(f"{name}/README.md", readme)
    checksum = hashlib.sha256(archive.read_bytes()).hexdigest()
    (output / "SHA256SUMS.txt").write_text(f"{checksum}  {archive.name}\n", encoding="utf-8")
    return archive


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, default=Path("release"))
    parser.add_argument("--repository", default="0then0/overflowlens")
    args = parser.parse_args()
    try:
        archive = package_release(Path(__file__).resolve().parent.parent, args.output_dir, args.repository)
    except (ValueError, OSError) as error:
        parser.error(str(error))
    print(archive)


if __name__ == "__main__":
    main()
