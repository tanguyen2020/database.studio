# Bundled Backup & Restore client tools

Database Studio ships the client tools its Backup & Restore dialog runs, so users
never install pg_dump & co. themselves. This folder is bundled into the installer
(`tauri.conf.json` → `bundle.resources`) and found at run time by
`src-tauri/src/drivers/bundled_tools.rs`.

| Folder      | Tools                                  | Used for                    |
|-------------|----------------------------------------|-----------------------------|
| `postgres/` | `pg_dump`, `pg_restore`, `psql` + libs | PostgreSQL                  |
| `mariadb/`  | `mariadb-dump`, `mariadb` + auth plugins | MariaDB, and MySQL when no MySQL client is installed |
| `mongodb/`  | `mongodump`, `mongorestore`            | MongoDB                     |

Oracle Data Pump (`expdp`, `impdp`) goes into `../instantclient/` next to the OCI
libraries the Oracle driver already loads.

The binaries are **git-ignored** — only this README is tracked. Populate the folder
before `tauri build` (CI does it in `build-beta.yml`):

```bash
npm run tools:fetch                       # every family for this platform
npm run tools:fetch -- --only postgres    # one family
npm run tools:fetch -- --force            # re-download even if up to date
```

The fetcher (`tools/fetch-dump-tools`) reads each vendor's own release metadata,
verifies the archive against the SHA-256 the vendor publishes (refuses it
otherwise), extracts only the tools + the libraries they load (Windows DLLs are
chosen by reading the executables' import tables), runs each tool once, and
writes `tools.json` (family, version, bin folder) + `NOTICE.txt` (licenses).

Precedence at run time: a folder the user picked → `PATH` → vendor install
folders → these bundled copies (pg_dump still picks the newest major of all,
since an older pg_dump refuses a newer server).
