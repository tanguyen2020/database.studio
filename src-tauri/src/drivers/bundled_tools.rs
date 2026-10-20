//! The client tools Backup & Restore runs (pg_dump & co.) ship INSIDE the
//! installer: `tools/fetch-dump-tools` downloads them at build time into
//! `src-tauri/resources/tools/<family>/`, Tauri bundles that folder as a
//! resource, and `bundled_bin_dirs` finds it at run time. Users install nothing.
//!
//! This module is shared by both sides (the fetcher includes it with
//! `#[path]`), so it only depends on std + serde + serde_json.
//!
//! Sources (each publishes a checksum per file, verified before extraction):
//! * PostgreSQL → github.com/theseus-rs/postgresql-binaries (builds of the
//!   official sources for Windows/macOS/Linux; `<asset>.sha256` next to each).
//! * MySQL + MariaDB → MariaDB's REST API (latest stable LTS series): the
//!   Windows zip / Linux bintar carry mariadb-dump + the mariadb client, which
//!   also talk to MySQL servers.
//! * MongoDB → downloads.mongodb.org/tools/db/release.json (Database Tools).
//! * Oracle → Instant Client Basic Light + Tools (expdp/impdp) from Oracle's
//!   download CDN, into `resources/instantclient/` next to the OCI libraries
//!   the driver already loads. Oracle publishes no machine-readable checksum,
//!   so these are pinned URLs over HTTPS (the fetcher accepts a pinned digest).

// The package pickers are only called by the build-time fetcher.
#![allow(dead_code)]

use std::path::{Component, Path, PathBuf};
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Family {
    Postgres,
    Mariadb,
    Mongodb,
    /// SqlPackage: SQL Server .bacpac export / import to and from this computer.
    Sqlpackage,
}

impl Family {
    pub fn key(self) -> &'static str {
        match self {
            Family::Postgres => "postgres",
            Family::Mariadb => "mariadb",
            Family::Mongodb => "mongodb",
            Family::Sqlpackage => "sqlpackage",
        }
    }
    pub fn label(self) -> &'static str {
        match self {
            Family::Postgres => "PostgreSQL client tools",
            Family::Mariadb => "MariaDB client tools (also for MySQL)",
            Family::Mongodb => "MongoDB Database Tools",
            Family::Sqlpackage => "SqlPackage (SQL Server)",
        }
    }
    /// Executables the install must provide.
    pub fn bins(self) -> &'static [&'static str] {
        match self {
            Family::Postgres => &["pg_dump", "pg_restore", "psql"],
            Family::Mariadb => &["mariadb-dump", "mariadb"],
            Family::Mongodb => &["mongodump", "mongorestore"],
            Family::Sqlpackage => &["sqlpackage"],
        }
    }
}

/// Which tool family serves an engine's backups (None = no client tool needed,
/// or not installable automatically).
pub fn family_for(system: &str) -> Option<Family> {
    match system {
        "postgres" => Some(Family::Postgres),
        "mysql" | "mariadb" => Some(Family::Mariadb),
        "mongodb" => Some(Family::Mongodb),
        "mssql" => Some(Family::Sqlpackage),
        _ => None,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Os {
    Windows,
    Macos,
    Linux,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Arch {
    X64,
    Arm64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Platform {
    pub os: Os,
    pub arch: Arch,
}

pub fn current_platform() -> Option<Platform> {
    let os = if cfg!(target_os = "windows") {
        Os::Windows
    } else if cfg!(target_os = "macos") {
        Os::Macos
    } else if cfg!(target_os = "linux") {
        Os::Linux
    } else {
        return None;
    };
    let arch = if cfg!(target_arch = "x86_64") {
        Arch::X64
    } else if cfg!(target_arch = "aarch64") {
        Arch::Arm64
    } else {
        return None;
    };
    Some(Platform { os, arch })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ArchiveFormat {
    Zip,
    TarGz,
}

pub fn format_of(file_name: &str) -> Option<ArchiveFormat> {
    let f = file_name.to_ascii_lowercase();
    if f.ends_with(".zip") {
        Some(ArchiveFormat::Zip)
    } else if f.ends_with(".tar.gz") || f.ends_with(".tgz") {
        Some(ArchiveFormat::TarGz)
    } else {
        None
    }
}

/// One downloadable package. `sha256` is known up front (MariaDB, MongoDB) or
/// fetched from `sha256_url` (PostgreSQL's `.sha256` asset).
#[derive(Debug, Clone, Serialize)]
pub struct Package {
    pub family: Family,
    pub version: String,
    pub file_name: String,
    pub url: String,
    pub sha256: Option<String>,
    pub sha256_url: Option<String>,
    pub size: Option<u64>,
    pub format: ArchiveFormat,
    pub source: String,
}

fn https(url: &str) -> String {
    match url.strip_prefix("http://") {
        Some(rest) => format!("https://{rest}"),
        None => url.to_string(),
    }
}

// ---- PostgreSQL ------------------------------------------------------------

pub const PG_RELEASES_API: &str = "https://api.github.com/repos/theseus-rs/postgresql-binaries/releases/latest";

pub fn pg_triple(p: Platform) -> (&'static str, ArchiveFormat) {
    match (p.os, p.arch) {
        (Os::Windows, Arch::X64) => ("x86_64-pc-windows-msvc", ArchiveFormat::Zip),
        (Os::Windows, Arch::Arm64) => ("aarch64-pc-windows-msvc", ArchiveFormat::Zip),
        (Os::Macos, Arch::X64) => ("x86_64-apple-darwin", ArchiveFormat::TarGz),
        (Os::Macos, Arch::Arm64) => ("aarch64-apple-darwin", ArchiveFormat::TarGz),
        (Os::Linux, Arch::X64) => ("x86_64-unknown-linux-gnu", ArchiveFormat::TarGz),
        (Os::Linux, Arch::Arm64) => ("aarch64-unknown-linux-gnu", ArchiveFormat::TarGz),
    }
}

/// From GitHub's "latest release" JSON: the archive for this platform and the
/// URL of its `.sha256` companion.
pub fn pick_pg_package(release: &Value, p: Platform) -> Result<Package, String> {
    let version = release["tag_name"].as_str().ok_or("release has no tag")?.trim_start_matches('v').to_string();
    let (triple, fmt) = pg_triple(p);
    let ext = if fmt == ArchiveFormat::Zip { "zip" } else { "tar.gz" };
    let name = format!("postgresql-{version}-{triple}.{ext}");
    let assets = release["assets"].as_array().ok_or("release has no assets")?;
    let find = |n: &str| assets.iter().find(|a| a["name"].as_str() == Some(n));
    let archive = find(&name).ok_or_else(|| format!("no PostgreSQL build for {triple} in release {version}"))?;
    let sha = find(&format!("{name}.sha256")).ok_or_else(|| format!("{name} has no published checksum"))?;
    Ok(Package {
        family: Family::Postgres,
        version,
        file_name: name,
        url: https(archive["browser_download_url"].as_str().ok_or("asset has no url")?),
        sha256: None,
        sha256_url: sha["browser_download_url"].as_str().map(https),
        size: archive["size"].as_u64(),
        format: fmt,
        source: "github.com/theseus-rs/postgresql-binaries".into(),
    })
}

// ---- MariaDB ----------------------------------------------------------------

pub const MARIADB_API: &str = "https://downloads.mariadb.org/rest-api/mariadb/";

fn version_tuple(v: &str) -> Vec<u64> {
    v.split(|c: char| !c.is_ascii_digit()).filter_map(|x| x.parse().ok()).collect()
}

/// Newest stable long-term-support series ("11.8").
pub fn pick_mariadb_series(majors: &Value) -> Option<String> {
    majors["major_releases"]
        .as_array()?
        .iter()
        .filter(|r| r["release_status"].as_str() == Some("Stable"))
        .filter(|r| r["release_support_type"].as_str().is_some_and(|s| s.contains("Long Term")))
        .filter_map(|r| r["release_id"].as_str())
        .max_by(|a, b| version_tuple(a).cmp(&version_tuple(b)))
        .map(String::from)
}

/// From `/rest-api/mariadb/<series>/latest/`: the Windows zip or Linux bintar.
pub fn pick_mariadb_package(latest: &Value, p: Platform) -> Result<Package, String> {
    let releases = latest["releases"].as_object().ok_or("no releases")?;
    let (version, rel) = releases.iter().next().ok_or("no release")?;
    let files = rel["files"].as_array().ok_or("no files")?;
    let want_os = match p.os {
        Os::Windows => "Windows",
        Os::Linux => "Linux",
        Os::Macos => return Err("MariaDB publishes no macOS build — install the client with Homebrew (brew install mariadb), then press Check again.".into()),
    };
    if p.arch != Arch::X64 {
        return Err("MariaDB publishes client builds for x86-64 only — install the client with your package manager.".into());
    }
    let file = files
        .iter()
        .find(|f| {
            let name = f["file_name"].as_str().unwrap_or("");
            f["os"].as_str() == Some(want_os)
                && f["cpu"].as_str() == Some("x86_64")
                && !name.contains("debug")
                && format_of(name).is_some()
                && (p.os == Os::Windows || name.contains("linux-systemd") || name.contains("linux-x86_64"))
        })
        .ok_or_else(|| format!("no MariaDB {version} client package for {want_os} x86_64"))?;
    let name = file["file_name"].as_str().unwrap_or_default().to_string();
    Ok(Package {
        family: Family::Mariadb,
        version: version.clone(),
        format: format_of(&name).ok_or("unknown archive format")?,
        url: https(file["file_download_url"].as_str().ok_or("no download url")?),
        sha256: file["checksum"]["sha256sum"].as_str().map(|s| s.to_ascii_lowercase()),
        sha256_url: None,
        size: None,
        file_name: name,
        source: "downloads.mariadb.org".into(),
    })
}

// ---- MongoDB ------------------------------------------------------------------

pub const MONGO_TOOLS_FEED: &str = "https://downloads.mongodb.org/tools/db/release.json";

pub fn pick_mongo_package(feed: &Value, p: Platform) -> Result<Package, String> {
    let versions = feed["versions"].as_array().ok_or("feed has no versions")?;
    let latest = versions
        .iter()
        .max_by(|a, b| version_tuple(a["version"].as_str().unwrap_or("")).cmp(&version_tuple(b["version"].as_str().unwrap_or(""))))
        .ok_or("feed is empty")?;
    let version = latest["version"].as_str().unwrap_or_default().to_string();
    let (names, arch): (&[&str], &[&str]) = match (p.os, p.arch) {
        (Os::Windows, Arch::X64) => (&["windows"], &["x86_64"]),
        (Os::Windows, Arch::Arm64) => (&["windows"], &["arm64", "x86_64"]),
        (Os::Macos, Arch::X64) => (&["macos"], &["x86_64"]),
        (Os::Macos, Arch::Arm64) => (&["macos"], &["arm64"]),
        (Os::Linux, Arch::X64) => (&["ubuntu2204", "ubuntu2004", "rhel90", "debian12"], &["x86_64"]),
        (Os::Linux, Arch::Arm64) => (&["ubuntu2204", "ubuntu2004", "rhel90"], &["arm64", "aarch64"]),
    };
    let downloads = latest["downloads"].as_array().ok_or("version has no downloads")?;
    let d = names
        .iter()
        .find_map(|n| {
            arch.iter().find_map(|a| {
                downloads
                    .iter()
                    .find(|d| d["name"].as_str() == Some(n) && d["arch"].as_str() == Some(a))
            })
        })
        .ok_or_else(|| format!("no MongoDB Database Tools {version} build for this system"))?;
    let url = d["archive"]["url"].as_str().ok_or("download has no url")?;
    let file_name = url.rsplit('/').next().unwrap_or(url).to_string();
    Ok(Package {
        family: Family::Mongodb,
        version,
        format: format_of(&file_name).ok_or("unknown archive format")?,
        url: https(url),
        sha256: d["archive"]["sha256"].as_str().map(|s| s.to_ascii_lowercase()),
        sha256_url: None,
        size: None,
        file_name,
        source: "downloads.mongodb.org".into(),
    })
}

// ---- verify / extract -----------------------------------------------------------

/// `<hex>  <file>` (sha256sum style) or a bare hex digest.
pub fn parse_sha256_file(text: &str) -> Option<String> {
    let first = text.split_whitespace().next()?.to_ascii_lowercase();
    (first.len() == 64 && first.chars().all(|c| c.is_ascii_hexdigit())).then_some(first)
}

/// Archive entry → path under `root`, refusing absolute paths and `..` (zip slip).
pub fn safe_join(root: &Path, entry: &str) -> Option<PathBuf> {
    let p = Path::new(entry);
    let mut out = root.to_path_buf();
    let mut any = false;
    for c in p.components() {
        match c {
            Component::Normal(s) => {
                out.push(s);
                any = true;
            }
            Component::CurDir => {}
            _ => return None,
        }
    }
    any.then_some(out)
}

/// Executables shipped per family (Windows adds `.exe`). MariaDB's `mysqldump`
/// / `mysql` names are left out: the MariaDB tools are the bundled fallback for
/// MySQL servers, a real MySQL client on the machine still wins.
fn shipped_exes(family: Family) -> &'static [&'static str] {
    match family {
        Family::Postgres => &["pg_dump", "pg_restore", "psql"],
        Family::Mariadb => &["mariadb-dump", "mariadb"],
        Family::Mongodb => &["mongodump", "mongorestore"],
        Family::Sqlpackage => &["sqlpackage"],
    }
}

/// Client-side authentication plugins the MariaDB tools load on demand (the
/// rest of `lib/plugin` are server storage engines and audit plugins).
pub const CLIENT_AUTH_PLUGINS: &[&str] = &[
    "caching_sha2_password",
    "sha256_password",
    "mysql_clear_password",
    "dialog",
    "client_ed25519",
    "auth_gssapi_client",
    "parsec",
    "authentication_windows_client",
];

/// Only what the tools need goes into the installer: the executables above, the
/// shared libraries next to / under them (Windows DLLs live in `bin`), MariaDB's
/// auth plugins (caching_sha2_password for MySQL 8 servers), and the license
/// files. Never the server, docs, debug symbols or import libraries.
pub fn keep_entry(family: Family, entry: &str) -> bool {
    let e = entry.replace('\\', "/").to_ascii_lowercase();
    let segs: Vec<&str> = e.split('/').filter(|s| !s.is_empty()).collect();
    let Some(file) = segs.last().copied() else { return false };
    if e.ends_with('/') || file.ends_with(".pdb") || file.ends_with(".lib") || file.ends_with(".a") {
        return false;
    }
    // license / copying files from the top two levels (ship the terms with the binaries)
    if segs.len() <= 2 && (file.starts_with("license") || file.starts_with("copying") || file.starts_with("third-party")) {
        return true;
    }
    let parent = if segs.len() >= 2 { segs[segs.len() - 2] } else { "" };
    let stem = file.strip_suffix(".exe").unwrap_or(file);
    let is_lib = file.ends_with(".dll") || file.ends_with(".dylib") || file.contains(".so");
    match family {
        Family::Postgres => {
            (parent == "bin" && (shipped_exes(family).contains(&stem) || file.ends_with(".dll")))
                // shared libraries only (`libpq.so.5`, `libssl.3.dylib`); server
                // extensions (`plpgsql.so`, Windows `lib/*.dll`) stay out
                || (parent == "lib" && is_lib && file.starts_with("lib") && !file.ends_with(".dll"))
        }
        Family::Mariadb => {
            let plugin_stem = file.split('.').next().unwrap_or(file);
            (parent == "bin" && (shipped_exes(family).contains(&stem) || file.ends_with(".dll")))
                || (parent == "plugin" && segs.iter().any(|s| *s == "lib") && is_lib && CLIENT_AUTH_PLUGINS.contains(&plugin_stem))
                || (parent == "lib" && is_lib)
        }
        Family::Mongodb => parent == "bin" && shipped_exes(family).contains(&stem),
        // a self-contained .NET app: every assembly is loaded by name at run time,
        // so the whole folder ships — minus debug symbols, API docs and the
        // translated resource folders (the English text is built in)
        Family::Sqlpackage => {
            let localized = segs.len() >= 2 && SATELLITE_CULTURES.contains(&segs[segs.len() - 2]);
            !(localized || file.ends_with(".xml") && !file.ends_with(".deps.xml"))
        }
    }
}

// ---- SqlPackage (SQL Server) -------------------------------------------------------------

/// Translated resource folders of a .NET app (`de/Microsoft.Data.Tools.Schema.Sql.resources.dll`).
const SATELLITE_CULTURES: &[&str] = &["cs", "de", "es", "fr", "it", "ja", "ko", "pl", "pt-br", "ru", "tr", "zh-hans", "zh-hant"];

/// Microsoft's evergreen links to the newest self-contained SqlPackage zip.
/// Microsoft publishes no machine-readable checksum, so the download must come
/// from a Microsoft host over HTTPS (a digest can be pinned by the fetcher).
pub fn sqlpackage_url(p: Platform) -> Result<&'static str, String> {
    match (p.os, p.arch) {
        (Os::Windows, Arch::X64) => Ok("https://aka.ms/sqlpackage-windows"),
        (Os::Linux, Arch::X64) => Ok("https://aka.ms/sqlpackage-linux"),
        (Os::Macos, _) => Ok("https://aka.ms/sqlpackage-macos"),
        _ => Err("Microsoft publishes no SqlPackage build for this system".into()),
    }
}

/// Hosts a SqlPackage download may come from (after redirects).
pub fn is_microsoft_host(url: &str) -> bool {
    let host = url.strip_prefix("https://").and_then(|r| r.split(['/', ':']).next()).unwrap_or("");
    let host = host.to_ascii_lowercase();
    ["microsoft.com", "aka.ms"].iter().any(|d| host == *d || host.ends_with(&format!(".{d}")))
}

// ---- Oracle (Instant Client) --------------------------------------------------------

/// Instant Client version shipped (keep in step with scripts/fetch-instantclient.*).
pub const ORACLE_IC_VERSION: &str = "23.8.0.25.04";

/// Basic Light (OCI libraries — also what the Oracle driver loads) and Tools
/// (expdp / impdp) for this platform, from Oracle's download CDN. Both unzip
/// into one `instantclient_23_8/` folder, flattened into `resources/instantclient`.
pub fn oracle_packages(p: Platform) -> Result<[String; 2], String> {
    let base = "https://download.oracle.com/otn_software";
    let v = ORACLE_IC_VERSION;
    let (dir, plat) = match (p.os, p.arch) {
        (Os::Windows, Arch::X64) => ("nt/instantclient/2380000", "windows.x64"),
        (Os::Linux, Arch::X64) => ("linux/instantclient/2380000", "linux.x64"),
        (Os::Linux, Arch::Arm64) => ("linux/instantclient/2380000", "linux.arm64"),
        _ => return Err("Oracle ships Instant Client Tools for this system only as a disk image — install them separately; the system copy is found automatically.".into()),
    };
    Ok([
        format!("{base}/{dir}/instantclient-basiclite-{plat}-{v}.zip"),
        format!("{base}/{dir}/instantclient-tools-{plat}-{v}.zip"),
    ])
}

/// Archive entry → path under `dest` with the top `instantclient_*` folder removed.
pub fn flatten_instantclient(entry: &str) -> Option<String> {
    let e = entry.replace('\\', "/");
    let mut parts = e.split('/').filter(|s| !s.is_empty());
    let first = parts.next()?;
    let rest: Vec<&str> = parts.collect();
    if first.to_ascii_lowercase().starts_with("instantclient") {
        (!rest.is_empty()).then(|| rest.join("/"))
    } else {
        Some(std::iter::once(first).chain(rest).collect::<Vec<_>>().join("/"))
    }
}

// ---- bundled tools (run time) --------------------------------------------------------

/// Written by the fetcher next to each family's files.
pub const MANIFEST: &str = "tools.json";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BundleManifest {
    pub family: Family,
    pub version: String,
    /// Folder holding the executables, relative to the family folder.
    pub bin: String,
    pub source: String,
}

static RESOURCE_ROOTS: OnceLock<Vec<PathBuf>> = OnceLock::new();

/// Called once at start-up with Tauri's resource dir. Resources keep their
/// path under `src-tauri/`, so both `<res>/tools` and `<res>/resources/tools`
/// are checked (and the same for `instantclient`).
pub fn set_resource_dir(res: &Path) {
    let _ = RESOURCE_ROOTS.set(vec![res.to_path_buf(), res.join("resources")]);
}

/// Folders that may hold `tools/` and `instantclient/`: the env override (tests),
/// the app's resource dir, and — in debug builds — the source tree, so
/// `tauri dev` and `cargo test` use what the fetcher put there.
pub fn resource_roots() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(p) = std::env::var_os("DBSTUDIO_BUNDLED_RESOURCES") {
        if !p.is_empty() {
            out.push(PathBuf::from(p));
        }
    }
    if let Some(r) = RESOURCE_ROOTS.get() {
        out.extend(r.iter().cloned());
    }
    if cfg!(debug_assertions) {
        if let Some(dir) = option_env!("CARGO_MANIFEST_DIR") {
            out.push(Path::new(dir).join("resources"));
        }
    }
    out
}

/// The bundled family folders that carry a manifest → their bin dirs.
pub fn manifests_in(resources: &Path) -> Vec<(BundleManifest, PathBuf)> {
    let mut out = Vec::new();
    let Ok(rd) = std::fs::read_dir(resources.join("tools")) else { return out };
    let mut dirs: Vec<PathBuf> = rd.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect();
    dirs.sort();
    for dir in dirs {
        let Ok(text) = std::fs::read_to_string(dir.join(MANIFEST)) else { continue };
        let Ok(m) = serde_json::from_str::<BundleManifest>(&text) else { continue };
        let Some(bin) = safe_join(&dir, &m.bin).or_else(|| (m.bin.is_empty() || m.bin == ".").then(|| dir.clone())) else { continue };
        if bin.is_dir() {
            out.push((m, bin));
        }
    }
    out
}

/// Every folder of bundled executables: the per-family tool folders plus the
/// bundled Instant Client (expdp / impdp live next to the OCI libraries).
pub fn bundled_bin_dirs() -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    for root in resource_roots() {
        for (_, bin) in manifests_in(&root) {
            if !out.contains(&bin) {
                out.push(bin);
            }
        }
        let ic = root.join("instantclient");
        if ic.is_dir() && !out.contains(&ic) {
            out.push(ic);
        }
    }
    out
}

/// Was this executable shipped with Database Studio?
pub fn is_bundled(path: &Path) -> bool {
    resource_roots().iter().any(|r| path.starts_with(r.join("tools")) || path.starts_with(r.join("instantclient")))
}

/// The folder (inside an extracted package) that holds every required binary.
pub fn find_bin_dir(root: &Path, family: Family) -> Option<PathBuf> {
    let exe = |n: &str| if cfg!(windows) { format!("{n}.exe") } else { n.to_string() };
    let mut stack = vec![root.to_path_buf()];
    while let Some(d) = stack.pop() {
        if family.bins().iter().all(|b| d.join(exe(b)).is_file()) {
            return Some(d);
        }
        if let Ok(rd) = std::fs::read_dir(&d) {
            for e in rd.flatten() {
                if e.path().is_dir() {
                    stack.push(e.path());
                }
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const WIN: Platform = Platform { os: Os::Windows, arch: Arch::X64 };
    const MAC_ARM: Platform = Platform { os: Os::Macos, arch: Arch::Arm64 };
    const LINUX: Platform = Platform { os: Os::Linux, arch: Arch::X64 };

    fn pg_release() -> Value {
        let mut assets = vec![];
        for t in ["x86_64-pc-windows-msvc.zip", "x86_64-pc-windows-msvc.tar.gz", "aarch64-apple-darwin.tar.gz", "x86_64-unknown-linux-gnu.tar.gz"] {
            let n = format!("postgresql-18.6.1-{t}");
            assets.push(json!({ "name": n, "size": 48_730_935u64, "browser_download_url": format!("https://github.com/r/d/18.6.1/{n}") }));
            assets.push(json!({ "name": format!("{n}.sha256"), "browser_download_url": format!("https://github.com/r/d/18.6.1/{n}.sha256") }));
        }
        json!({ "tag_name": "18.6.1", "assets": assets })
    }

    #[test]
    fn engines_map_to_tool_families() {
        assert_eq!(family_for("postgres"), Some(Family::Postgres));
        assert_eq!(family_for("mysql"), Some(Family::Mariadb));
        assert_eq!(family_for("mariadb"), Some(Family::Mariadb));
        assert_eq!(family_for("mongodb"), Some(Family::Mongodb));
        assert_eq!(family_for("mssql"), Some(Family::Sqlpackage));
        for s in ["oracle", "sqlite", "redis", "kafka"] {
            assert_eq!(family_for(s), None, "{s}");
        }
    }

    #[test]
    fn postgres_package_per_platform_with_its_checksum_file() {
        let p = pick_pg_package(&pg_release(), WIN).unwrap();
        assert_eq!(p.file_name, "postgresql-18.6.1-x86_64-pc-windows-msvc.zip");
        assert_eq!(p.format, ArchiveFormat::Zip);
        assert_eq!(p.sha256_url.as_deref(), Some("https://github.com/r/d/18.6.1/postgresql-18.6.1-x86_64-pc-windows-msvc.zip.sha256"));
        assert_eq!(p.size, Some(48_730_935));
        let m = pick_pg_package(&pg_release(), MAC_ARM).unwrap();
        assert!(m.file_name.ends_with("aarch64-apple-darwin.tar.gz") && m.format == ArchiveFormat::TarGz);
        assert!(pick_pg_package(&pg_release(), LINUX).unwrap().file_name.contains("linux-gnu"));
        // no checksum asset → refused, never installed unverified
        let mut r = pg_release();
        r["assets"].as_array_mut().unwrap().retain(|a| !a["name"].as_str().unwrap().ends_with(".sha256"));
        assert!(pick_pg_package(&r, WIN).unwrap_err().contains("checksum"));
    }

    #[test]
    fn mariadb_picks_newest_lts_and_the_right_file() {
        let majors = json!({ "major_releases": [
            { "release_id": "13.0", "release_status": "Stable", "release_support_type": "Rolling" },
            { "release_id": "12.3", "release_status": "Stable", "release_support_type": "Long Term Support" },
            { "release_id": "11.8", "release_status": "Stable", "release_support_type": "Long Term Support" },
            { "release_id": "13.1", "release_status": "RC", "release_support_type": "Long Term Support" }
        ]});
        assert_eq!(pick_mariadb_series(&majors).as_deref(), Some("12.3"));
        let latest = json!({ "releases": { "11.8.9": { "files": [
            { "file_name": "mariadb-11.8.9-winx64-debugsymbols.zip", "os": "Windows", "cpu": "x86_64", "file_download_url": "http://x/dbg.zip", "checksum": { "sha256sum": "AA" } },
            { "file_name": "mariadb-11.8.9-winx64.msi", "os": "Windows", "cpu": "x86_64", "file_download_url": "http://x/a.msi", "checksum": { "sha256sum": "BB" } },
            { "file_name": "mariadb-11.8.9-winx64.zip", "os": "Windows", "cpu": "x86_64", "file_download_url": "http://downloads.mariadb.org/x/mariadb-11.8.9-winx64.zip", "checksum": { "sha256sum": "830C46" } },
            { "file_name": "mariadb-11.8.9.tar.gz", "os": "Source", "cpu": null, "file_download_url": "http://x/src.tar.gz", "checksum": { "sha256sum": "CC" } },
            { "file_name": "mariadb-11.8.9-linux-systemd-x86_64.tar.gz", "os": "Linux", "cpu": "x86_64", "file_download_url": "http://x/linux.tar.gz", "checksum": { "sha256sum": "DD" } }
        ]}}});
        let w = pick_mariadb_package(&latest, WIN).unwrap();
        assert_eq!(w.file_name, "mariadb-11.8.9-winx64.zip");
        assert_eq!(w.url, "https://downloads.mariadb.org/x/mariadb-11.8.9-winx64.zip", "always over https");
        assert_eq!(w.sha256.as_deref(), Some("830c46"));
        assert_eq!(w.version, "11.8.9");
        assert_eq!(pick_mariadb_package(&latest, LINUX).unwrap().sha256.as_deref(), Some("dd"));
        assert!(pick_mariadb_package(&latest, MAC_ARM).unwrap_err().contains("Homebrew"));
    }

    #[test]
    fn mongo_tools_from_the_official_feed() {
        let feed = json!({ "versions": [ { "version": "100.19.1", "downloads": [
            { "name": "windows", "arch": "x86_64", "archive": { "url": "https://fastdl.mongodb.org/tools/db/mongodb-database-tools-windows-x86_64-100.19.1.zip", "sha256": "527738A0" } },
            { "name": "macos", "arch": "arm64", "archive": { "url": "https://fastdl.mongodb.org/tools/db/mongodb-database-tools-macos-arm64-100.19.1.zip", "sha256": "54643d4a" } },
            { "name": "ubuntu2204", "arch": "x86_64", "archive": { "url": "https://fastdl.mongodb.org/tools/db/mongodb-database-tools-ubuntu2204-x86_64-100.19.1.tgz", "sha256": "8312f251" } }
        ]}]});
        let w = pick_mongo_package(&feed, WIN).unwrap();
        assert_eq!(w.file_name, "mongodb-database-tools-windows-x86_64-100.19.1.zip");
        assert_eq!(w.sha256.as_deref(), Some("527738a0"));
        assert_eq!(pick_mongo_package(&feed, MAC_ARM).unwrap().format, ArchiveFormat::Zip);
        assert_eq!(pick_mongo_package(&feed, LINUX).unwrap().format, ArchiveFormat::TarGz);
    }

    #[test]
    fn checksum_files_and_zip_slip() {
        let h = "a".repeat(64);
        assert_eq!(parse_sha256_file(&format!("{h}  postgresql.zip\n")), Some(h.clone()));
        assert_eq!(parse_sha256_file(&h.to_uppercase()), Some(h));
        assert_eq!(parse_sha256_file("not a hash"), None);
        let root = Path::new("/r");
        assert_eq!(safe_join(root, "pg/bin/pg_dump"), Some(PathBuf::from("/r/pg/bin/pg_dump")));
        assert!(safe_join(root, "../evil").is_none());
        assert!(safe_join(root, "pg/../../evil").is_none());
        assert!(safe_join(root, "/etc/passwd").is_none());
        assert!(safe_join(root, "").is_none());
    }

    #[test]
    fn only_the_tools_go_into_the_installer() {
        let pg = Family::Postgres;
        assert!(keep_entry(pg, "postgresql-18/bin/pg_dump.exe"));
        assert!(keep_entry(pg, "postgresql-18/bin/pg_restore"));
        assert!(keep_entry(pg, "postgresql-18/bin/libpq.dll"));
        assert!(keep_entry(pg, "postgresql-18/lib/libpq.so.5.18"));
        assert!(keep_entry(pg, "postgresql-18/lib/libpq.dylib"));
        // the server and its extensions stay out
        assert!(!keep_entry(pg, "postgresql-18/bin/postgres.exe"));
        assert!(!keep_entry(pg, "postgresql-18/bin/initdb"));
        assert!(!keep_entry(pg, "postgresql-18/lib/postgresql/plpgsql.so"));
        assert!(!keep_entry(pg, "postgresql-18/lib/plpgsql.so"));
        assert!(!keep_entry(pg, "postgresql-18/lib/amcheck.dll"));
        assert!(!keep_entry(pg, "postgresql-18/lib/libpq.lib"));
        assert!(!keep_entry(pg, "postgresql-18/share/doc/x.html"));
        let my = Family::Mariadb;
        assert!(keep_entry(my, "mariadb-11.8.9-winx64/bin/mariadb-dump.exe"));
        assert!(keep_entry(my, "mariadb-11.8.9-winx64/bin/mariadb.exe"));
        assert!(keep_entry(my, "mariadb-11.8.9-winx64/bin/libmariadb.dll"));
        assert!(keep_entry(my, "mariadb-11.8.9-winx64/lib/plugin/caching_sha2_password.dll"));
        assert!(keep_entry(my, "mariadb-11.8.9-linux-systemd-x86_64/lib/plugin/caching_sha2_password.so"));
        assert!(!keep_entry(my, "mariadb-11.8.9-winx64/lib/plugin/ha_rocksdb.dll"));
        assert!(!keep_entry(my, "mariadb-11.8.9-winx64/lib/plugin/server_audit.dll"));
        assert!(!keep_entry(my, "mariadb-11.8.9-winx64/bin/mariadbd.exe"));
        assert!(!keep_entry(my, "mariadb-11.8.9-winx64/bin/mariadbd.pdb"));
        assert!(!keep_entry(my, "mariadb-11.8.9-winx64/share/english/errmsg.sys"));
        assert!(keep_entry(my, "mariadb-11.8.9-winx64/COPYING"));
        let mo = Family::Mongodb;
        assert!(keep_entry(mo, "mongodb-database-tools-windows/bin/mongodump.exe"));
        assert!(keep_entry(mo, "mongodb-database-tools-windows/bin/mongorestore"));
        assert!(!keep_entry(mo, "mongodb-database-tools-windows/bin/bsondump.exe"));
        assert!(keep_entry(mo, "mongodb-database-tools-windows/LICENSE.md"));
        let sp = Family::Sqlpackage;
        assert!(keep_entry(sp, "sqlpackage.exe"));
        assert!(keep_entry(sp, "Microsoft.Data.Tools.Schema.Sql.dll"));
        assert!(keep_entry(sp, "runtimes/win-x64/native/Microsoft.Data.SqlClient.SNI.dll"));
        assert!(keep_entry(sp, "sqlpackage.deps.json"));
        assert!(!keep_entry(sp, "de/Microsoft.Data.Tools.Schema.Sql.resources.dll"));
        assert!(!keep_entry(sp, "zh-Hant/Microsoft.SqlServer.Dac.resources.dll"));
        assert!(!keep_entry(sp, "Microsoft.SqlServer.Dac.xml"));
        assert!(!keep_entry(sp, "sqlpackage.pdb"));
        assert!(!keep_entry(mo, "mongodb-database-tools-windows/README.md"));
    }

    #[test]
    fn sqlpackage_only_from_microsoft() {
        assert!(sqlpackage_url(WIN).unwrap().starts_with("https://aka.ms/"));
        assert!(sqlpackage_url(LINUX).unwrap().ends_with("linux"));
        assert!(is_microsoft_host("https://download.microsoft.com/download/x/sqlpackage-win-x64.zip"));
        assert!(is_microsoft_host("https://go.microsoft.com/fwlink/?linkid=1"));
        assert!(!is_microsoft_host("https://download.microsoft.com.evil.example/x.zip"));
        assert!(!is_microsoft_host("http://download.microsoft.com/x.zip"), "https only");
        assert!(!is_microsoft_host("https://notmicrosoft.com/x.zip"));
    }

    #[test]
    fn oracle_tools_come_with_the_matching_client_libraries() {
        let [basic, tools] = oracle_packages(WIN).unwrap();
        assert!(basic.starts_with("https://download.oracle.com/") && basic.contains("basiclite-windows.x64-23.8"));
        assert!(tools.contains("instantclient-tools-windows.x64-23.8"));
        assert!(oracle_packages(LINUX).unwrap()[1].contains("tools-linux.x64"));
        assert!(oracle_packages(MAC_ARM).is_err());
        assert_eq!(flatten_instantclient("instantclient_23_8/expdp.exe").as_deref(), Some("expdp.exe"));
        assert_eq!(flatten_instantclient("instantclient_23_8/network/admin/README").as_deref(), Some("network/admin/README"));
        assert_eq!(flatten_instantclient("instantclient_23_8/"), None);
        assert_eq!(flatten_instantclient("oci.dll").as_deref(), Some("oci.dll"));
    }

    #[test]
    fn bundled_folders_are_found_from_their_manifest() {
        let res = std::env::temp_dir().join(format!("ds-bundle-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&res);
        let bin = res.join("tools").join("postgres").join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let m = BundleManifest { family: Family::Postgres, version: "18.6.1".into(), bin: "bin".into(), source: "t".into() };
        std::fs::write(res.join("tools").join("postgres").join(MANIFEST), serde_json::to_string(&m).unwrap()).unwrap();
        // a folder without a manifest is ignored, and a manifest cannot point outside
        std::fs::create_dir_all(res.join("tools").join("stray")).unwrap();
        let evil = BundleManifest { bin: "../../etc".into(), ..m.clone() };
        std::fs::create_dir_all(res.join("tools").join("evil")).unwrap();
        std::fs::write(res.join("tools").join("evil").join(MANIFEST), serde_json::to_string(&evil).unwrap()).unwrap();
        let got = manifests_in(&res);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].0, m);
        assert_eq!(got[0].1, bin);
        let _ = std::fs::remove_dir_all(&res);
    }
}
