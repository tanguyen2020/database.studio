//! Downloads the client tools Backup & Restore runs and puts them where Tauri
//! bundles them into the installer:
//!
//!   src-tauri/resources/tools/postgres/   pg_dump, pg_restore, psql (+ libs)
//!   src-tauri/resources/tools/mariadb/    mariadb-dump, mariadb (+ auth plugins)
//!   src-tauri/resources/tools/mongodb/    mongodump, mongorestore
//!   src-tauri/resources/tools/sqlpackage/ sqlpackage (SQL Server .bacpac)
//!   src-tauri/resources/instantclient/    expdp, impdp next to the OCI libraries
//!
//! Every archive is checked against the checksum its vendor publishes before a
//! single file is extracted, and only the files the tools need are kept (the
//! MariaDB package is a whole server). Run before `tauri build`:
//!
//!   cargo run --release --manifest-path tools/fetch-dump-tools/Cargo.toml
//!   … -- --only postgres,mongodb --force --out <resources dir>
//!
//! Which package to fetch, how to verify it and what to keep is decided by the
//! same module the app uses to find the result at run time.

#[path = "../../../src-tauri/src/drivers/bundled_tools.rs"]
mod bundled_tools;

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;

use bundled_tools::*;
use sha2::{Digest, Sha256};

type Res<T> = Result<T, String>;

struct Args {
    out: PathBuf,
    only: Vec<String>,
    force: bool,
}

fn parse_args() -> Res<Args> {
    let default_out = Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("..").join("src-tauri").join("resources");
    let mut a = Args { out: default_out, only: vec!["postgres".into(), "mariadb".into(), "mongodb".into(), "sqlpackage".into(), "oracle".into()], force: false };
    let mut it = std::env::args().skip(1);
    while let Some(x) = it.next() {
        match x.as_str() {
            "--out" => a.out = PathBuf::from(it.next().ok_or("--out needs a folder")?),
            "--only" => a.only = it.next().ok_or("--only needs a list")?.split(',').map(|s| s.trim().to_ascii_lowercase()).filter(|s| !s.is_empty()).collect(),
            "--force" => a.force = true,
            "-h" | "--help" => {
                println!("fetch-dump-tools [--out <resources dir>] [--only postgres,mariadb,mongodb,sqlpackage,oracle] [--force]");
                std::process::exit(0);
            }
            other => return Err(format!("unknown argument {other}")),
        }
    }
    Ok(a)
}

fn main() {
    if let Err(e) = run() {
        eprintln!("error: {e}");
        std::process::exit(1);
    }
}

fn run() -> Res<()> {
    let args = parse_args()?;
    let platform = current_platform().ok_or("unsupported build platform")?;
    let client = reqwest::blocking::Client::builder()
        .user_agent("DatabaseStudio-build/fetch-dump-tools")
        .connect_timeout(std::time::Duration::from_secs(30))
        .timeout(std::time::Duration::from_secs(1800))
        .build()
        .map_err(|e| e.to_string())?;
    let tools_dir = args.out.join("tools");
    std::fs::create_dir_all(&tools_dir).map_err(|e| format!("{}: {e}", tools_dir.display()))?;

    for (key, family) in [("postgres", Family::Postgres), ("mariadb", Family::Mariadb), ("mongodb", Family::Mongodb)] {
        if args.only.iter().any(|o| o == key) {
            fetch_family(&client, family, platform, &tools_dir, args.force).map_err(|e| format!("{}: {e}", family.label()))?;
        }
    }
    if args.only.iter().any(|o| o == "sqlpackage" || o == "mssql") {
        fetch_sqlpackage(&client, platform, &tools_dir, args.force).map_err(|e| format!("SqlPackage: {e}"))?;
    }
    let ic = args.out.join("instantclient");
    if args.only.iter().any(|o| o == "oracle") {
        fetch_oracle(&client, platform, &ic, args.force)?;
    }
    // the notice lists exactly what is in the folder (this run or an earlier one)
    let mut notices: Vec<String> = manifests_in(&args.out).into_iter().map(|(m, _)| notice_for(m.family, &m.version, &m.source)).collect();
    if ic.join(if cfg!(windows) { "expdp.exe" } else { "expdp" }).is_file() {
        notices.push(oracle_notice());
    }
    if ic.join("libaio.so.1").is_file() {
        notices.push("libaio (shipped next to Oracle Instant Client on Linux)\n  from the build machine's libaio package — https://pagure.io/libaio\n  license: GNU LGPL v2.1\n".to_string());
    }
    write_notice(&tools_dir, &notices)?;
    println!("done → {}", args.out.display());
    Ok(())
}

// ---- download + verify ---------------------------------------------------------------

fn get_json(client: &reqwest::blocking::Client, url: &str) -> Res<serde_json::Value> {
    let mut req = client.get(url);
    if url.contains("api.github.com") {
        if let Ok(t) = std::env::var("GITHUB_TOKEN") {
            if !t.is_empty() {
                req = req.bearer_auth(t);
            }
        }
    }
    let r = req.send().map_err(|e| format!("{url}: {e}"))?;
    if !r.status().is_success() {
        return Err(format!("{url} answered {}", r.status()));
    }
    r.json().map_err(|e| format!("{url}: {e}"))
}

fn cache_dir() -> PathBuf {
    std::env::temp_dir().join("dbstudio-dump-tools-cache")
}

/// Download (or reuse a cached copy) and return its path + SHA-256.
fn download(client: &reqwest::blocking::Client, url: &str, file_name: &str) -> Res<(PathBuf, String)> {
    let dir = cache_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(file_name);
    if !path.is_file() {
        println!("  downloading {url}");
        let mut r = client.get(url).send().and_then(|r| r.error_for_status()).map_err(|e| format!("{url}: {e}"))?;
        let part = dir.join(format!("{file_name}.part"));
        let mut f = std::fs::File::create(&part).map_err(|e| e.to_string())?;
        std::io::copy(&mut r, &mut f).map_err(|e| format!("{url}: {e}"))?;
        f.flush().map_err(|e| e.to_string())?;
        drop(f);
        std::fs::rename(&part, &path).map_err(|e| e.to_string())?;
    } else {
        println!("  cached {}", path.display());
    }
    let mut h = Sha256::new();
    let mut f = std::fs::File::open(&path).map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = f.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok((path, hex::encode(h.finalize())))
}

fn verify(path: &Path, got: &str, expected: &str) -> Res<()> {
    if got.eq_ignore_ascii_case(expected.trim()) {
        println!("  sha256 ok {got}");
        Ok(())
    } else {
        let _ = std::fs::remove_file(path);
        Err(format!("{} does not match its published SHA-256 (expected {expected}, got {got}) — discarded", path.display()))
    }
}

// ---- extract ----------------------------------------------------------------------

/// Unpack the entries `keep(name) -> Some(relative path)` selects into `dest`.
fn extract(archive: &Path, fmt: ArchiveFormat, dest: &Path, keep: &dyn Fn(&str) -> Option<String>) -> Res<usize> {
    let file = std::fs::File::open(archive).map_err(|e| e.to_string())?;
    let mut n = 0;
    match fmt {
        ArchiveFormat::Zip => {
            let mut zip = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
            for i in 0..zip.len() {
                let mut entry = zip.by_index(i).map_err(|e| e.to_string())?;
                if entry.is_dir() {
                    continue;
                }
                let Some(rel) = keep(entry.name()) else { continue };
                let Some(out) = safe_join(dest, &rel) else { continue };
                if let Some(p) = out.parent() {
                    std::fs::create_dir_all(p).map_err(|e| e.to_string())?;
                }
                let mut f = std::fs::File::create(&out).map_err(|e| format!("{}: {e}", out.display()))?;
                std::io::copy(&mut entry, &mut f).map_err(|e| e.to_string())?;
                #[cfg(unix)]
                if let Some(mode) = entry.unix_mode() {
                    use std::os::unix::fs::PermissionsExt;
                    let _ = std::fs::set_permissions(&out, std::fs::Permissions::from_mode(mode | 0o444));
                }
                n += 1;
            }
        }
        ArchiveFormat::TarGz => {
            let mut tar = tar::Archive::new(flate2::read::GzDecoder::new(file));
            tar.set_preserve_permissions(true);
            for entry in tar.entries().map_err(|e| e.to_string())? {
                let mut entry = entry.map_err(|e| e.to_string())?;
                let name = entry.path().map_err(|e| e.to_string())?.to_string_lossy().to_string();
                let kind = entry.header().entry_type();
                if !(kind.is_file() || kind.is_symlink()) {
                    continue;
                }
                let Some(rel) = keep(&name) else { continue };
                let Some(out) = safe_join(dest, &rel) else { continue };
                if let Some(p) = out.parent() {
                    std::fs::create_dir_all(p).map_err(|e| e.to_string())?;
                }
                if kind.is_symlink() {
                    // libpq.so -> libpq.so.5: only relative links that stay inside
                    #[cfg(unix)]
                    if let Ok(Some(target)) = entry.link_name() {
                        let t = target.to_string_lossy().to_string();
                        if !t.contains("..") && !Path::new(&t).is_absolute() {
                            let _ = std::fs::remove_file(&out);
                            let _ = std::os::unix::fs::symlink(&t, &out);
                            n += 1;
                        }
                    }
                    continue;
                }
                entry.unpack(&out).map_err(|e| format!("{}: {e}", out.display()))?;
                n += 1;
            }
        }
    }
    Ok(n)
}

// ---- Windows: ship only the DLLs the tools actually load ------------------------------

fn rd_u16(b: &[u8], o: usize) -> Option<u16> {
    b.get(o..o + 2).map(|s| u16::from_le_bytes([s[0], s[1]]))
}
fn rd_u32(b: &[u8], o: usize) -> Option<u32> {
    b.get(o..o + 4).map(|s| u32::from_le_bytes([s[0], s[1], s[2], s[3]]))
}

/// DLL names a PE file imports (normal + delay-load import tables).
fn pe_imports(b: &[u8]) -> Vec<String> {
    let mut out = Vec::new();
    let Some(pe) = rd_u32(b, 0x3c).map(|v| v as usize) else { return out };
    if b.get(pe..pe + 4) != Some(b"PE\0\0") {
        return out;
    }
    let coff = pe + 4;
    let (Some(nsec), Some(opt_size)) = (rd_u16(b, coff + 2), rd_u16(b, coff + 16)) else { return out };
    let opt = coff + 20;
    let dirs = match rd_u16(b, opt) {
        Some(0x20b) => opt + 112, // PE32+
        Some(0x10b) => opt + 96,  // PE32
        _ => return out,
    };
    let sections = opt + opt_size as usize;
    let to_off = |rva: u32| -> Option<usize> {
        for i in 0..nsec as usize {
            let s = sections + i * 40;
            let (vsize, va, raw_size, raw) = (rd_u32(b, s + 8)?, rd_u32(b, s + 12)?, rd_u32(b, s + 16)?, rd_u32(b, s + 20)?);
            if rva >= va && rva < va + vsize.max(raw_size) {
                return Some((rva - va + raw) as usize);
            }
        }
        None
    };
    let cstr = |off: usize| -> Option<String> {
        let end = b[off..].iter().position(|&c| c == 0)?;
        Some(String::from_utf8_lossy(&b[off..off + end]).to_ascii_lowercase())
    };
    // (directory index, descriptor size, offset of the name RVA in a descriptor)
    for (idx, size, name_at) in [(1usize, 20usize, 12usize), (13, 32, 4)] {
        let Some(rva) = rd_u32(b, dirs + idx * 8).filter(|r| *r != 0) else { continue };
        let Some(mut d) = to_off(rva) else { continue };
        loop {
            let Some(name_rva) = rd_u32(b, d + name_at) else { break };
            if name_rva == 0 {
                break;
            }
            if let Some(n) = to_off(name_rva).and_then(cstr) {
                if !out.contains(&n) {
                    out.push(n);
                }
            }
            d += size;
        }
    }
    out
}

/// Delete every DLL in `bin` that no shipped executable (or plugin) loads,
/// directly or through another shipped DLL.
fn prune_windows_dlls(bin: &Path, roots: Vec<PathBuf>) -> Res<(usize, u64)> {
    let mut by_name: std::collections::HashMap<String, PathBuf> = std::collections::HashMap::new();
    for e in std::fs::read_dir(bin).map_err(|e| e.to_string())?.flatten() {
        let n = e.file_name().to_string_lossy().to_ascii_lowercase();
        if n.ends_with(".dll") {
            by_name.insert(n, e.path());
        }
    }
    let mut keep: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut queue = roots;
    while let Some(f) = queue.pop() {
        let Ok(bytes) = std::fs::read(&f) else { continue };
        for dep in pe_imports(&bytes) {
            if let Some(p) = by_name.get(&dep) {
                if keep.insert(dep.clone()) {
                    queue.push(p.clone());
                }
            }
        }
    }
    let (mut removed, mut bytes) = (0, 0);
    for (name, path) in by_name {
        if !keep.contains(&name) {
            bytes += std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
            std::fs::remove_file(&path).map_err(|e| format!("{}: {e}", path.display()))?;
            removed += 1;
        }
    }
    Ok((removed, bytes))
}

/// Windows virus scanners hold freshly written executables for a moment.
fn rename_retry(from: &Path, to: &Path) -> Res<()> {
    let mut last = String::new();
    for _ in 0..20 {
        match std::fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(e) => last = e.to_string(),
        }
        std::thread::sleep(std::time::Duration::from_millis(500));
    }
    Err(format!("{} → {}: {last}", from.display(), to.display()))
}

/// Drop the archive's top folder (`postgresql-18.1-x86_64-pc-windows-msvc/…`).
fn strip_top(entry: &str) -> Option<String> {
    let e = entry.replace('\\', "/");
    let mut parts = e.splitn(2, '/');
    let _top = parts.next()?;
    parts.next().filter(|r| !r.is_empty()).map(String::from)
}

fn dir_size(p: &Path) -> u64 {
    let mut total = 0;
    if let Ok(rd) = std::fs::read_dir(p) {
        for e in rd.flatten() {
            let path = e.path();
            if path.is_dir() {
                total += dir_size(&path);
            } else if let Ok(m) = e.metadata() {
                total += m.len();
            }
        }
    }
    total
}

/// Run each shipped executable once (`--version`) — a copy that cannot start
/// on the build machine must not reach an installer.
fn smoke_test(bin: &Path, family: Family) -> Res<()> {
    for b in family.bins() {
        let exe = bin.join(if cfg!(windows) { format!("{b}.exe") } else { b.to_string() });
        let mut cmd = Command::new(&exe);
        cmd.arg("--version");
        if !cfg!(windows) {
            let var = if cfg!(target_os = "macos") { "DYLD_LIBRARY_PATH" } else { "LD_LIBRARY_PATH" };
            cmd.env(var, std::env::join_paths([bin.to_path_buf(), bin.join("..").join("lib")]).unwrap_or_default());
        }
        let out = cmd.output().map_err(|e| format!("{} does not start: {e}", exe.display()))?;
        let text = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
        let first = text.lines().find(|l| !l.trim().is_empty()).unwrap_or("").trim().to_string();
        if !out.status.success() && first.is_empty() {
            return Err(format!("{} exited with {} and printed nothing", exe.display(), out.status));
        }
        println!("  {b}: {first}");
    }
    Ok(())
}

// ---- PostgreSQL / MariaDB / MongoDB ---------------------------------------------------

fn resolve(client: &reqwest::blocking::Client, family: Family, p: Platform) -> Res<Package> {
    match family {
        Family::Postgres => pick_pg_package(&get_json(client, PG_RELEASES_API)?, p),
        Family::Mariadb => {
            let majors = get_json(client, MARIADB_API)?;
            let series = pick_mariadb_series(&majors).ok_or("MariaDB lists no long-term-support release")?;
            pick_mariadb_package(&get_json(client, &format!("{MARIADB_API}{series}/latest/"))?, p)
        }
        Family::Mongodb => pick_mongo_package(&get_json(client, MONGO_TOOLS_FEED)?, p),
        Family::Sqlpackage => Err("SqlPackage is fetched by fetch_sqlpackage".into()),
    }
}

fn fetch_family(client: &reqwest::blocking::Client, family: Family, p: Platform, tools_dir: &Path, force: bool) -> Res<()> {
    println!("{}", family.label());
    let pkg = match resolve(client, family, p) {
        Ok(pkg) => pkg,
        // e.g. no MariaDB build for macOS: ship without it, the app falls back
        // to a client installed on the machine.
        // A missing checksum is never "not available" — that fails the build.
        Err(e) if !e.contains("checksum") && (e.contains("publishes") || e.contains(" build") || e.contains("client package")) => {
            println!("  skipped — {e}");
            return Ok(());
        }
        Err(e) => return Err(e),
    };
    let dest = tools_dir.join(family.key());
    if !force {
        if let Ok(text) = std::fs::read_to_string(dest.join(MANIFEST)) {
            if let Ok(m) = serde_json::from_str::<BundleManifest>(&text) {
                if m.version == pkg.version && dest.join(&m.bin).is_dir() {
                    println!("  {} already in place", pkg.version);
                    return Ok(());
                }
            }
        }
    }
    let expected = match (&pkg.sha256, &pkg.sha256_url) {
        (Some(h), _) => h.clone(),
        (None, Some(u)) => {
            let text = client.get(u).send().and_then(|r| r.error_for_status()).and_then(|r| r.text()).map_err(|e| format!("{u}: {e}"))?;
            parse_sha256_file(&text).ok_or_else(|| format!("{u} holds no SHA-256"))?
        }
        (None, None) => return Err(format!("{} has no published checksum — refusing to ship it unverified", pkg.file_name)),
    };
    let (archive, got) = download(client, &pkg.url, &pkg.file_name)?;
    verify(&archive, &got, &expected)?;

    let staging = tools_dir.join(format!(".{}.partial", family.key()));
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging).map_err(|e| e.to_string())?;
    let n = extract(&archive, pkg.format, &staging, &|name| keep_entry(family, name).then(|| strip_top(name)).flatten())?;
    let bin = find_bin_dir(&staging, family).ok_or_else(|| format!("{} does not contain {}", pkg.file_name, family.bins().join(", ")))?;
    let rel = bin.strip_prefix(&staging).unwrap_or(Path::new("")).to_string_lossy().replace('\\', "/");
    let rel = if rel.is_empty() { ".".to_string() } else { rel };
    if cfg!(windows) {
        let mut roots: Vec<PathBuf> = family.bins().iter().map(|b| bin.join(format!("{b}.exe"))).collect();
        if let Ok(rd) = std::fs::read_dir(staging.join("lib").join("plugin")) {
            roots.extend(rd.flatten().map(|e| e.path()));
        }
        let (n, b) = prune_windows_dlls(&bin, roots)?;
        println!("  dropped {n} DLLs nothing loads ({:.1} MB)", b as f64 / 1_048_576.0);
    }
    let _ = std::fs::remove_dir_all(&dest);
    rename_retry(&staging, &dest)?;
    // run from the final place (a just-started .exe stays locked for a moment on
    // Windows, so the check comes after the move); no manifest = not shipped
    if let Err(e) = smoke_test(&dest.join(&rel), family) {
        let _ = std::fs::remove_dir_all(&dest);
        return Err(e);
    }
    let manifest = BundleManifest { family, version: pkg.version.clone(), bin: rel, source: pkg.source.clone() };
    std::fs::write(dest.join(MANIFEST), serde_json::to_string_pretty(&manifest).unwrap_or_default()).map_err(|e| e.to_string())?;
    println!("  {} files, {:.1} MB → {}", n, dir_size(&dest) as f64 / 1_048_576.0, dest.display());
    Ok(())
}

// ---- SqlPackage (SQL Server) -------------------------------------------------------------

fn fetch_sqlpackage(client: &reqwest::blocking::Client, p: Platform, tools_dir: &Path, force: bool) -> Res<()> {
    let family = Family::Sqlpackage;
    println!("{}", family.label());
    let url = match sqlpackage_url(p) {
        Ok(u) => u,
        Err(e) => {
            println!("  skipped — {e}");
            return Ok(());
        }
    };
    let dest = tools_dir.join(family.key());
    if !force && dest.join(MANIFEST).is_file() {
        println!("  already in place (use --force to refresh)");
        return Ok(());
    }
    // follow aka.ms → go.microsoft.com → download.microsoft.com; every hop and
    // the final file must be a Microsoft host over HTTPS
    let resp = client.get(url).send().and_then(|r| r.error_for_status()).map_err(|e| format!("{url}: {e}"))?;
    let final_url = resp.url().to_string();
    if !is_microsoft_host(&final_url) {
        return Err(format!("refusing a SqlPackage download from {final_url}"));
    }
    let name = final_url.split(['?', '#']).next().unwrap_or(&final_url).rsplit('/').next().unwrap_or("sqlpackage.zip").to_string();
    let name = if name.to_ascii_lowercase().ends_with(".zip") { name } else { format!("{name}.zip") };
    let cached = cache_dir().join(&name);
    if !cached.is_file() {
        println!("  downloading {final_url}");
        std::fs::create_dir_all(cache_dir()).map_err(|e| e.to_string())?;
        let part = cache_dir().join(format!("{name}.part"));
        let mut f = std::fs::File::create(&part).map_err(|e| e.to_string())?;
        let mut resp = resp;
        std::io::copy(&mut resp, &mut f).map_err(|e| format!("{final_url}: {e}"))?;
        drop(f);
        std::fs::rename(&part, &cached).map_err(|e| e.to_string())?;
    } else {
        drop(resp);
    }
    let (archive, got) = download(client, &final_url, &name)?; // cached → just hashes it
    match std::env::var("DBSTUDIO_SQLPACKAGE_SHA256").ok().filter(|s| !s.trim().is_empty()) {
        Some(h) => verify(&archive, &got, &h)?,
        None => println!("  sha256 {got} (Microsoft publishes no checksum; pin it with DBSTUDIO_SQLPACKAGE_SHA256)"),
    }
    let staging = tools_dir.join(format!(".{}.partial", family.key()));
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging).map_err(|e| e.to_string())?;
    let n = extract(&archive, ArchiveFormat::Zip, &staging, &|e| keep_entry(family, e).then(|| e.replace('\\', "/")))?;
    let bin = find_bin_dir(&staging, family).ok_or_else(|| format!("{name} does not contain sqlpackage"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(bin.join("sqlpackage"), std::fs::Permissions::from_mode(0o755));
    }
    let rel = bin.strip_prefix(&staging).unwrap_or(Path::new("")).to_string_lossy().replace('\\', "/");
    let rel = if rel.is_empty() { ".".to_string() } else { rel };
    let _ = std::fs::remove_dir_all(&dest);
    rename_retry(&staging, &dest)?;
    let exe = dest.join(&rel).join(if cfg!(windows) { "sqlpackage.exe" } else { "sqlpackage" });
    let out = Command::new(&exe).arg("/version").output().map_err(|e| {
        let _ = std::fs::remove_dir_all(&dest);
        format!("{} does not start: {e}", exe.display())
    })?;
    let version = String::from_utf8_lossy(&out.stdout).lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("").to_string();
    if !out.status.success() || version.is_empty() {
        let _ = std::fs::remove_dir_all(&dest);
        return Err(format!("{} /version failed: {}", exe.display(), String::from_utf8_lossy(&out.stderr)));
    }
    println!("  sqlpackage: {version}");
    let manifest = BundleManifest { family, version, bin: rel, source: "download.microsoft.com".into() };
    std::fs::write(dest.join(MANIFEST), serde_json::to_string_pretty(&manifest).unwrap_or_default()).map_err(|e| e.to_string())?;
    println!("  {} files, {:.1} MB → {}", n, dir_size(&dest) as f64 / 1_048_576.0, dest.display());
    Ok(())
}

// ---- Oracle -----------------------------------------------------------------------

fn fetch_oracle(client: &reqwest::blocking::Client, p: Platform, dest: &Path, force: bool) -> Res<()> {
    println!("Oracle Instant Client {ORACLE_IC_VERSION} (Basic Light + Tools)");
    let urls = match oracle_packages(p) {
        Ok(u) => u,
        Err(e) => {
            println!("  skipped — {e}");
            return Ok(());
        }
    };
    let exe = |n: &str| if cfg!(windows) { format!("{n}.exe") } else { n.to_string() };
    if !force && dest.join(exe("expdp")).is_file() && dest.join(exe("impdp")).is_file() {
        println!("  already in place");
        return prepare_linux_instantclient(dest);
    }
    // Oracle publishes no machine-readable checksum; a digest can be pinned
    // (DBSTUDIO_ORACLE_SHA256=<basic>,<tools>) and is then enforced.
    let pinned: Vec<String> = std::env::var("DBSTUDIO_ORACLE_SHA256").unwrap_or_default().split(',').map(|s| s.trim().to_string()).collect();
    std::fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    // start clean (keep the tracked README) so nothing from an older layout ships
    for e in std::fs::read_dir(dest).map_err(|e| e.to_string())?.flatten() {
        if e.file_name().to_string_lossy().eq_ignore_ascii_case("README.md") {
            continue;
        }
        let p = e.path();
        let r = if p.is_dir() { std::fs::remove_dir_all(&p) } else { std::fs::remove_file(&p) };
        r.map_err(|err| format!("{}: {err}", p.display()))?;
    }
    for (i, url) in urls.iter().enumerate() {
        if !url.starts_with("https://download.oracle.com/") {
            return Err(format!("refusing a non-Oracle download URL: {url}"));
        }
        let name = url.rsplit('/').next().unwrap_or("oracle.zip");
        let (archive, got) = download(client, url, name)?;
        match pinned.get(i).filter(|s| !s.is_empty()) {
            Some(h) => verify(&archive, &got, h)?,
            None => println!("  sha256 {got} (no published checksum; pin it with DBSTUDIO_ORACLE_SHA256)"),
        }
        let n = extract(&archive, ArchiveFormat::Zip, dest, &|e| {
            let low = e.to_ascii_lowercase().replace('\\', "/");
            let file = low.rsplit('/').next().unwrap_or(&low);
            // JDBC/UCP jars, the C++ API (OCCI), SQL*Loader and the legacy exp/imp
            // are not used — the driver needs OCI, Backup needs expdp/impdp.
            let unused = low.ends_with(".sym")
                || low.ends_with(".pdb")
                || low.ends_with(".jar")
                || low.contains("/sdk/")
                || file.starts_with("oraocci")
                || file.starts_with("ocijdbc")
                || ["sqlldr", "exp", "imp", "adrci", "wrc", "uidrvci", "genezi"].contains(&file.strip_suffix(".exe").unwrap_or(file));
            if unused {
                return None;
            }
            flatten_instantclient(e)
        })?;
        println!("  {n} files from {name}");
    }
    for b in ["expdp", "impdp"] {
        if !dest.join(exe(b)).is_file() {
            return Err(format!("{b} missing after unpacking the Oracle Tools package"));
        }
    }
    prepare_linux_instantclient(dest)?;
    println!("  {:.1} MB → {}", dir_size(dest) as f64 / 1_048_576.0, dest.display());
    Ok(())
}

/// Linux only: make the Instant Client folder self-contained.
///
/// Oracle's binaries carry no RPATH — they expect LD_LIBRARY_PATH — so the
/// AppImage bundler (linuxdeploy), which resolves the dependencies of every ELF
/// file it is given, cannot find `libclntsh.so` next to `expdp` and fails the
/// build. Every ELF file here gets `RPATH=$ORIGIN`, so it finds its siblings on
/// its own. Oracle also needs `libaio.so.1`, which Ubuntu 24.04 renamed to
/// `libaio.so.1t64`; a copy ships under the name Oracle asks for, so Oracle
/// works on machines without libaio installed.
fn prepare_linux_instantclient(dest: &Path) -> Res<()> {
    if !cfg!(target_os = "linux") {
        return Ok(());
    }
    let libaio = dest.join("libaio.so.1");
    if !libaio.is_file() {
        let found = ["/usr/lib/x86_64-linux-gnu", "/lib/x86_64-linux-gnu", "/usr/lib/aarch64-linux-gnu", "/lib/aarch64-linux-gnu", "/usr/lib64", "/lib64", "/usr/lib"]
            .iter()
            .flat_map(|d| ["libaio.so.1", "libaio.so.1t64"].map(|n| Path::new(d).join(n)))
            .find(|p| p.is_file())
            .ok_or("libaio is not installed on this build machine (Oracle Instant Client needs it) — install libaio1t64 (Ubuntu 24.04+) or libaio1")?;
        // follows the symlink: the real library is copied under Oracle's name
        std::fs::copy(&found, &libaio).map_err(|e| format!("{}: {e}", found.display()))?;
        patchelf(&["--set-soname", "libaio.so.1"], &libaio)?;
        println!("  libaio.so.1 from {}", found.display());
    }
    let mut n = 0;
    for e in std::fs::read_dir(dest).map_err(|e| e.to_string())?.flatten() {
        let p = e.path();
        // regular files only: the versioned symlinks point at files patched here
        if !e.file_type().map(|t| t.is_file()).unwrap_or(false) || !is_elf(&p) {
            continue;
        }
        patchelf(&["--set-rpath", "$ORIGIN"], &p)?;
        n += 1;
    }
    println!("  RPATH=$ORIGIN on {n} ELF files");
    // must start from its final place with no library path set
    let out = Command::new(dest.join("expdp"))
        .arg("help=y")
        .env_remove("LD_LIBRARY_PATH")
        .output()
        .map_err(|e| format!("expdp does not start: {e}"))?;
    let text = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
    let first = text.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("");
    if !first.starts_with("Export:") {
        return Err(format!("expdp does not start without LD_LIBRARY_PATH: {}", text.trim()));
    }
    println!("  expdp: {first}");
    Ok(())
}

fn is_elf(p: &Path) -> bool {
    let mut magic = [0u8; 4];
    std::fs::File::open(p).and_then(|mut f| f.read_exact(&mut magic)).is_ok() && magic == *b"\x7fELF"
}

fn patchelf(args: &[&str], file: &Path) -> Res<()> {
    let out = Command::new("patchelf")
        .args(args)
        .arg(file)
        .output()
        .map_err(|e| format!("patchelf is needed to bundle Oracle Instant Client on Linux ({e}) — install it (apt install patchelf)"))?;
    if !out.status.success() {
        return Err(format!("patchelf {} {}: {}", args.join(" "), file.display(), String::from_utf8_lossy(&out.stderr).trim()));
    }
    Ok(())
}

// ---- notices -------------------------------------------------------------------------

fn notice_for(family: Family, version: &str, source: &str) -> String {
    let license = match family {
        Family::Postgres => "PostgreSQL License (permissive) — https://www.postgresql.org/about/licence/",
        Family::Mariadb => "GNU GPL v2 — source code: https://mariadb.org/download/ (see COPYING in tools/mariadb)",
        Family::Mongodb => "Apache License 2.0 — https://github.com/mongodb/mongo-tools",
        Family::Sqlpackage => "Microsoft SqlPackage license (shipped as License.txt in tools/sqlpackage) — https://aka.ms/sqlpackage",
    };
    format!("{} {version}\n  from {source}\n  license: {license}\n", family.label())
}

fn oracle_notice() -> String {
    format!(
        "Oracle Instant Client {ORACLE_IC_VERSION} (Basic Light, Tools)\n  from download.oracle.com\n  license: Oracle Free Use Terms and Conditions — https://www.oracle.com/downloads/licenses/oracle-free-license.html\n"
    )
}

fn write_notice(tools_dir: &Path, notices: &[String]) -> Res<()> {
    let mut text = String::from(
        "Third-party client tools shipped with Database Studio for Backup & Restore.\n\
         They are unmodified vendor builds, verified against the vendor's checksum when the\n\
         installer was built. Each keeps its own license:\n\n",
    );
    for n in notices {
        text.push_str(n);
        text.push('\n');
    }
    std::fs::write(tools_dir.join("NOTICE.txt"), text).map_err(|e| e.to_string())
}
