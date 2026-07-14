# Bundled Oracle Instant Client

The Oracle driver (`oracle` crate → ODPI-C) dlopens the OCI client library at
runtime. To ship Oracle support **without asking users to install anything**, the
Instant Client is bundled here as a Tauri resource and pointed at on app startup
(`lib.rs` → `drivers::oracle::init_client_dir`).

## What goes here

The **contents** of an Instant Client **Basic** (or **Basic Light**) package,
flattened directly into this folder — i.e. `oci.dll` (Windows) /
`libclntsh.so.*` (Linux) / `libclntsh.dylib` (macOS) must sit at
`src-tauri/resources/instantclient/oci.dll`, not in a nested `instantclient_23_8/`
subfolder. (Startup also tolerates a single nested `instantclient*` subfolder, but
flat is preferred.)

The binaries are **git-ignored** (they are large and Oracle-licensed) — only this
README is tracked. Each machine/CI that builds an Oracle-enabled installer must
populate this folder first.

## How to populate

From the repo root, run the fetch script for your build platform:

```bash
# Windows x64
pwsh scripts/fetch-instantclient.ps1

# Linux x64 / ARM64  and  macOS (Apple Silicon)
scripts/fetch-instantclient.sh
```

Both detect OS + arch, download the free (no-login) package from Oracle's OTN CDN
(**Basic Light** zip on Windows/Linux; **Basic** `.dmg` on macOS — ARM64-only for
v23), and flatten it into this folder. Both are idempotent (skip if already
present; `--force`/`-Force` to re-download) and accept `--url`/`-Url` to override
when Oracle bumps the version.

- **macOS is ARM64-only** for Instant Client v23 (Intel stopped at 19c). The
  `.dmg` is mounted with `hdiutil`, its contents copied here (symlinks preserved),
  then detached.
- If a default URL 404s (version bumped), grab the current package link from
  <https://www.oracle.com/database/technologies/instant-client/downloads.html>
  and pass it via `--url`.

## Licensing

Oracle Instant Client is distributed under the **Oracle Free Use Terms and
Conditions (OFUTC)** / OTN license, which permits redistribution bundled with an
application subject to its terms. Review the license before publishing installers
that include these binaries. Because of this (and their size), the binaries are
not committed to the repository.

## If this folder has no client

Startup detects the absence (no `oci.dll` / `libclntsh.*`) and leaves ODPI-C on
its default library search, so a **system-installed** Instant Client still works.
Only Oracle connections are affected — every other engine is unaffected.
