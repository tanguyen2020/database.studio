//! Backup & Restore commands. One entry point per direction for every engine:
//!
//! | engine            | how                                                     | file lives on |
//! |-------------------|---------------------------------------------------------|---------------|
//! | PostgreSQL        | pg_dump · pg_restore / psql                             | this computer |
//! | MySQL / MariaDB   | mysqldump / mariadb-dump · mysql / mariadb              | this computer |
//! | MongoDB           | mongodump · mongorestore (archive)                      | this computer |
//! | SQLite / DuckDB   | in-process (rusqlite backup API / ATTACH + COPY)        | this computer |
//! | Cassandra         | built-in CQL dump (schema + `INSERT … JSON` rows)       | this computer |
//! | Redis             | built-in DUMP / RESTORE of every key of one database    | this computer |
//! | SQL Server        | native `BACKUP` / `RESTORE DATABASE`                    | the server    |
//! | ClickHouse        | native `BACKUP` / `RESTORE DATABASE … Disk(…)`          | the server    |
//! | Oracle            | Data Pump expdp / impdp                                 | the server    |
//!
//! What used to make Backup unusable, and is handled here:
//! * the Explorer passes derived ids (`{base}::db`, `{base}#tab-…`) that are not
//!   in storage — the target is resolved from the LIVE connection first;
//! * client tools are found in the vendors' install folders, not only on PATH;
//! * tools connect through the SSH tunnel's local endpoint when there is one;
//! * a tool never waits for a password prompt (`-w` / env / config file) and
//!   never flashes a console window;
//! * a running job can be cancelled (the child process is killed).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

use futures::StreamExt;
use serde::Serialize;
use tauri::State;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
use tokio_util::sync::CancellationToken;

use crate::connections::profile::ConnectionProfile;
use crate::drivers::backup::{backup_tool, oracle_dir_sql, oracle_expdp_cmd, oracle_impdp_cmd, oracle_parfile, oracle_with_parfile, BackupTarget};
use crate::drivers::backup_tools::*;
use crate::drivers::types::StatementOutcome;
use crate::drivers::LiveConnection;
use crate::error::{AppError, QueryError};
use crate::state::AppState;
use crate::storage::crypto;

// ---------------------------------------------------------------------------
// shapes
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct BackupToolStatus {
    /// Tool name (or "(in-process)" for SQLite); None when unsupported.
    pub tool: Option<String>,
    pub available: bool,
}

#[derive(Serialize, Clone)]
pub struct ToolInfo {
    pub name: String,
    pub path: Option<String>,
    pub version: Option<String>,
    pub found: bool,
    /// The copy shipped inside the installer (not one installed on the machine).
    pub bundled: bool,
}

#[derive(Serialize)]
pub struct ServerBackup {
    pub path: String,
    pub finished: String,
    pub size: Option<i64>,
}

#[derive(Serialize)]
pub struct BackupPlan {
    pub system: String,
    pub database: String,
    /// `tool` | `server` | `in-process` | `built-in` | `unsupported`
    pub method: String,
    /// Human name of the method ("pg_dump", "Native BACKUP DATABASE", …).
    pub method_label: String,
    /// The backup file is read/written by the database SERVER (path on its disk).
    pub server_side: bool,
    pub backup_tool: Option<ToolInfo>,
    pub restore_tools: Vec<ToolInfo>,
    pub backup_ready: bool,
    pub restore_ready: bool,
    pub default_dir: String,
    /// Folder on THIS computer for files the app writes (equal to `default_dir`
    /// except for server-side engines, whose `default_dir` is on the server).
    pub local_dir: String,
    pub server_version: Option<String>,
    pub warnings: Vec<String>,
    pub install_hint: Option<String>,
    /// SQL Server: recent backups of this database recorded in msdb.
    pub recent: Vec<ServerBackup>,
    /// ClickHouse: disks the server knows (one must be allowed for backups).
    pub disks: Vec<String>,
    /// The connection must be open for this method (server-side / built-in).
    pub needs_connection: bool,
    pub connected: bool,
}

#[derive(Serialize)]
pub struct BackupOutcome {
    pub message: String,
    pub path: String,
    pub bytes: Option<u64>,
    pub duration_ms: u64,
    pub server_side: bool,
    /// Tail of the tool's output (warnings worth reading).
    pub log: String,
    pub notes: Vec<String>,
    /// Keys / rows / statements processed by the built-in methods.
    pub items: Option<u64>,
}

// ---------------------------------------------------------------------------
// cancellable jobs
// ---------------------------------------------------------------------------

fn jobs() -> &'static Mutex<HashMap<String, CancellationToken>> {
    static J: OnceLock<Mutex<HashMap<String, CancellationToken>>> = OnceLock::new();
    J.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Live progress of one backup / restore, sent to the dialog while it runs.
#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BackupProgress {
    pub job_id: String,
    /// "Preparing" · "Backing up" · "Restoring" · "Finishing"
    pub stage: String,
    pub done: u64,
    /// Known up front (tables in the catalog, bytes of the file…); None = count only.
    pub total: Option<u64>,
    /// "tables" · "collections" · "keys" · "bytes" · "files" · "%"
    pub unit: String,
    /// The object being worked on (`public.orders`).
    pub current: Option<String>,
}

type ProgressSink = std::sync::Arc<dyn Fn(BackupProgress) + Send + Sync>;

fn sinks() -> &'static Mutex<HashMap<String, ProgressSink>> {
    static S: OnceLock<Mutex<HashMap<String, ProgressSink>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Where the progress of job `id` goes (the dialog's channel; tests record it).
/// Removed again when the job ends.
pub fn set_progress_sink(id: &str, sink: impl Fn(BackupProgress) + Send + Sync + 'static) {
    sinks().lock().unwrap().insert(id.to_string(), std::sync::Arc::new(sink));
}

/// Cancel a running job by id (the dialog's Stop; tests use it too).
pub fn cancel_job(id: &str) -> bool {
    match jobs().lock().unwrap().get(id).cloned() {
        Some(t) => {
            t.cancel();
            true
        }
        None => false,
    }
}

struct Job {
    id: Option<String>,
    token: CancellationToken,
    /// throttle: at most ~6 updates a second reach the UI
    last: Mutex<Option<Instant>>,
    state: Mutex<BackupProgress>,
}

impl Job {
    fn start(id: Option<String>) -> Self {
        let token = CancellationToken::new();
        if let Some(id) = &id {
            jobs().lock().unwrap().insert(id.clone(), token.clone());
        }
        let state = BackupProgress { job_id: id.clone().unwrap_or_default(), stage: "Preparing".into(), ..Default::default() };
        Job { id, token, last: Mutex::new(None), state: Mutex::new(state) }
    }
    fn cancelled(&self) -> bool {
        self.token.is_cancelled()
    }
    /// Update the progress and send it (throttled unless `force`).
    fn report(&self, force: bool, f: impl FnOnce(&mut BackupProgress)) {
        let snapshot = {
            let mut st = self.state.lock().unwrap();
            f(&mut st);
            if let Some(t) = st.total {
                if st.done > t {
                    st.done = t;
                }
            }
            st.clone()
        };
        let Some(id) = &self.id else { return };
        {
            let mut last = self.last.lock().unwrap();
            if !force && last.is_some_and(|l| l.elapsed() < std::time::Duration::from_millis(160)) {
                return;
            }
            *last = Some(Instant::now());
        }
        let sink = sinks().lock().unwrap().get(id).cloned();
        if let Some(s) = sink {
            s(snapshot);
        }
    }
    /// A new stage with a fresh counter.
    fn stage(&self, stage: &str, total: Option<u64>, unit: &str) {
        self.report(true, |p| {
            p.stage = stage.into();
            p.done = 0;
            p.total = total;
            p.unit = unit.into();
            p.current = None;
        });
    }
    fn tick(&self, current: Option<String>) {
        self.report(false, |p| {
            p.done += 1;
            if current.is_some() {
                p.current = current;
            }
        });
    }
    fn set_done(&self, done: u64, current: Option<String>) {
        self.report(false, |p| {
            p.done = done;
            if current.is_some() {
                p.current = current;
            }
        });
    }
}

impl Drop for Job {
    fn drop(&mut self) {
        if let Some(id) = &self.id {
            jobs().lock().unwrap().remove(id);
            sinks().lock().unwrap().remove(id);
        }
    }
}

/// How to read progress out of a client tool's output while it runs.
struct Track {
    stage: &'static str,
    total: Option<u64>,
    unit: &'static str,
    /// A line naming an object the tool just finished (or started).
    parse: Option<fn(&str) -> Option<String>>,
    /// The tool exited non-zero, but every error line is harmless: a success.
    tolerate: Option<fn(&[String]) -> bool>,
    /// A line announcing one more object the run will go through: the total is
    /// counted from the tool's own output (and settles at what was done).
    counts_total: Option<fn(&str) -> bool>,
    /// The total is an expectation, not a count (steps of a tool): when the run
    /// ends it settles at what was really done.
    settle: bool,
}

impl Track {
    fn lines(stage: &'static str, total: Option<u64>, unit: &'static str, parse: fn(&str) -> Option<String>) -> Self {
        Track { stage, total, unit, parse: Some(parse), tolerate: None, counts_total: None, settle: false }
    }
    /// Progress = bytes of the input file fed to the tool's stdin.
    fn bytes(stage: &'static str) -> Self {
        Track { stage, total: None, unit: "bytes", parse: None, tolerate: None, counts_total: None, settle: false }
    }
}

/// The dialog's progress channel becomes the sink of its job.
fn attach_channel(options: &Option<BackupOptions>, ch: tauri::ipc::Channel<BackupProgress>) {
    if let Some(id) = options.as_ref().and_then(|o| o.job_id.clone()) {
        set_progress_sink(&id, move |p| {
            let _ = ch.send(p);
        });
    }
}

fn cancelled_err() -> AppError {
    AppError::Driver("Cancelled — nothing more was written.".into())
}

#[tauri::command]
pub async fn cancel_backup(job_id: String) -> Result<bool, AppError> {
    Ok(cancel_job(&job_id))
}

// ---------------------------------------------------------------------------
// target resolution
// ---------------------------------------------------------------------------

fn base_conn_id(id: &str) -> String {
    let no_tab = id.split('#').next().unwrap_or(id);
    no_tab.split("::").next().unwrap_or(no_tab).to_string()
}

struct Target {
    system: String,
    base_id: String,
    /// A connected id to run statements on (the given one, else its base).
    live_id: Option<String>,
    profile: ConnectionProfile,
    password: String,
    host: String,
    port: u16,
    database: String,
}

impl Target {
    fn tool_target(&self) -> BackupTarget {
        BackupTarget {
            host: self.host.clone(),
            port: self.port,
            database: self.database.clone(),
            user: self.profile.user.clone(),
        }
    }
    fn live(&self) -> Result<&str, AppError> {
        self.live_id
            .as_deref()
            .ok_or_else(|| AppError::Driver("Open the connection first — this runs through it.".into()))
    }
}

fn resolve(state: &AppState, conn_id: &str, database: Option<&str>) -> Result<Target, AppError> {
    let base = base_conn_id(conn_id);
    let live = [conn_id.to_string(), base.clone()]
        .into_iter()
        .find(|id| state.registry.is_connected(id));
    let (profile, password, host, port) = match &live {
        Some(id) => {
            let (p, pw, _) = state.registry.live_credentials(id)?;
            let ep = state.registry.live_endpoint(id);
            let (h, po) = ep.map(|e| (e.host, e.port)).unwrap_or((p.host.clone(), p.port));
            (p, pw, h, po)
        }
        None => {
            let p = state
                .storage
                .get_connection(&base)
                .map_err(|_| AppError::Driver("This connection is not saved and not open — open it first.".into()))?;
            let pw = crypto::decrypt(&p.password_enc).unwrap_or_default();
            let (h, po) = (p.host.clone(), p.port);
            (p, pw, h, po)
        }
    };
    let database = database
        .map(str::trim)
        .filter(|d| !d.is_empty())
        .map(String::from)
        .unwrap_or_else(|| profile.database.clone());
    Ok(Target {
        system: profile.system.as_str().to_string(),
        base_id: base,
        live_id: live,
        password,
        host,
        port,
        database,
        profile,
    })
}

/// External tools need the tunnel's local port, which only exists while the
/// connection is open.
fn require_reachable(t: &Target) -> Result<(), AppError> {
    if t.profile.ssh.enabled && t.live_id.is_none() {
        return Err(AppError::Driver(
            "This connection goes through an SSH tunnel — open it first so the backup tool can use the tunnel.".into(),
        ));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// tools
// ---------------------------------------------------------------------------

fn backup_tool_names(system: &str) -> &'static [&'static str] {
    match system {
        "postgres" => &["pg_dump"],
        "mysql" => &["mysqldump", "mariadb-dump"],
        "mariadb" => &["mariadb-dump", "mysqldump"],
        "mongodb" => &["mongodump"],
        "oracle" => &["expdp"],
        _ => &[],
    }
}

fn restore_tool_names(system: &str) -> &'static [&'static str] {
    match system {
        "postgres" => &["pg_restore", "psql"],
        "mysql" => &["mysql", "mariadb"],
        "mariadb" => &["mariadb", "mysql"],
        "mongodb" => &["mongorestore"],
        "oracle" => &["impdp"],
        _ => &[],
    }
}

/// A quick helper call (`--version`, `pg_restore -l`): no console window, normal
/// priority — it must answer promptly even while the machine is busy (a starved
/// `--version` made the dialog report an installed tool as missing).
fn no_window(cmd: &mut tokio::process::Command) {
    #[cfg(windows)]
    {
        // CREATE_NO_WINDOW — a GUI app spawning a console tool must not flash one.
        cmd.creation_flags(0x0800_0000);
    }
    let _ = cmd;
}

/// A long backup / restore job: no console window, BELOW_NORMAL priority — a dump
/// of thousands of tables keeps the machine (and this app's UI) responsive.
fn background(cmd: &mut tokio::process::Command) {
    #[cfg(windows)]
    {
        // CREATE_NO_WINDOW | BELOW_NORMAL_PRIORITY_CLASS
        cmd.creation_flags(0x0800_0000 | 0x0000_4000);
    }
    #[cfg(unix)]
    unsafe {
        // the same on Linux / macOS: run the tool `nice`d
        cmd.pre_exec(|| {
            let _ = libc::nice(10);
            Ok(())
        });
    }
    let _ = cmd;
}

/// `<tool> --version`, bounded so a broken install cannot hang the dialog.
async fn probe_version(path: &Path) -> Option<String> {
    let mut cmd = tokio::process::Command::new(path);
    // SqlPackage takes Windows-style switches
    let is_sqlpackage = path.file_stem().is_some_and(|s| s.to_string_lossy().eq_ignore_ascii_case("sqlpackage"));
    cmd.arg(if is_sqlpackage { "/version" } else { "--version" }).stdin(std::process::Stdio::null()).kill_on_drop(true);
    bundled_lib_path(&mut cmd, path);
    no_window(&mut cmd);
    let out = match tokio::time::timeout(std::time::Duration::from_secs(20), cmd.output()).await {
        Ok(r) => r.ok()?,
        // it exists and started, it just did not answer in time: still a tool
        Err(_) => {
            let name = path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
            return Some(format!("{name} (did not report its version in time)"));
        }
    };
    let text = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
    text.lines().map(str::trim).find(|l| !l.is_empty()).map(String::from)
}

struct Located {
    name: String,
    path: PathBuf,
    version: Option<String>,
}

/// Best copy of one of `names`. For pg_dump/pg_restore/psql the newest major
/// wins (an older pg_dump refuses a newer server); otherwise the first found,
/// in `names` preference order.
async fn locate(names: &[&str], tool_dir: Option<&str>, newest: bool) -> Option<Located> {
    let mut best: Option<(Located, (u64, u64), usize)> = None;
    for path in find_tool_candidates(names, tool_dir) {
        let stem = path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
        let rank = names.iter().position(|n| n.eq_ignore_ascii_case(&stem)).unwrap_or(names.len());
        let version = probe_version(&path).await;
        let Some(v) = version.as_deref() else { continue };
        let ver = parse_version(v).unwrap_or((0, 0));
        let cand = Located { name: stem, path, version };
        let better = match &best {
            None => true,
            Some((_, bv, br)) => {
                if newest {
                    ver > *bv
                } else {
                    rank < *br
                }
            }
        };
        if better {
            best = Some((cand, ver, rank));
        }
        if !newest && rank == 0 {
            break;
        }
    }
    best.map(|b| b.0)
}

fn tool_info(name: &str, l: &Option<Located>) -> ToolInfo {
    match l {
        Some(l) => ToolInfo {
            name: l.name.clone(),
            path: Some(l.path.to_string_lossy().to_string()),
            version: l.version.clone(),
            found: true,
            bundled: crate::drivers::bundled_tools::is_bundled(&l.path),
        },
        None => ToolInfo { name: name.into(), path: None, version: None, found: false, bundled: false },
    }
}

fn install_hint(system: &str) -> Option<String> {
    let s = match system {
        "postgres" => "Install the PostgreSQL client tools (they come with PostgreSQL, pgAdmin, or `brew install libpq` / `apt install postgresql-client`), then press Check again — or pick the folder that contains pg_dump with Locate….",
        "mysql" => "Install the MySQL client (MySQL Server, MySQL Workbench or `mysql-client`), then press Check again — or pick the folder that contains mysqldump with Locate….",
        "mariadb" => "Install the MariaDB client (it ships with MariaDB Server, or `apt install mariadb-client`), then press Check again — or pick the folder that contains mariadb-dump with Locate….",
        "mongodb" => "Install the MongoDB Database Tools (mongodump / mongorestore, a separate download from MongoDB), then press Check again — or pick their folder with Locate….",
        "mssql" => "Saving to this computer (.bacpac) needs SqlPackage, Microsoft's free command-line tool (https://aka.ms/sqlpackage). Install it, then press Check again — or pick its folder with Locate…. The server-side .bak backup needs nothing.",
        "oracle" => "Data Pump needs the Oracle Instant Client Tools package (expdp / impdp) on this computer, and the dump is written to a directory on the database server.",
        _ => return None,
    };
    // Normally the installer ships these (see drivers/bundled_tools.rs), so this
    // only shows on a build without them (a dev build, or a platform the vendor
    // publishes no build for).
    Some(format!("This build of Database Studio does not include the {} client tools for your system. {s}", tool_family_name(system)))
}

fn tool_family_name(system: &str) -> &'static str {
    match system {
        "postgres" => "PostgreSQL",
        "mysql" => "MySQL",
        "mariadb" => "MariaDB",
        "mongodb" => "MongoDB",
        "mssql" => "SqlPackage",
        "oracle" => "Oracle Data Pump",
        _ => "",
    }
}

/// A copy shipped inside the installer finds its shared libraries next to it
/// (Windows does that for DLLs by itself; Linux / macOS need the search path).
fn bundled_lib_path(cmd: &mut tokio::process::Command, prog: &Path) {
    if cfg!(windows) || !crate::drivers::bundled_tools::is_bundled(prog) {
        return;
    }
    let Some(bin) = prog.parent() else { return };
    let mut dirs = vec![bin.to_path_buf(), bin.join("..").join("lib")];
    let var = if cfg!(target_os = "macos") { "DYLD_LIBRARY_PATH" } else { "LD_LIBRARY_PATH" };
    if let Some(old) = std::env::var_os(var) {
        dirs.extend(std::env::split_paths(&old));
    }
    if let Ok(joined) = std::env::join_paths(dirs) {
        cmd.env(var, joined);
    }
}

/// Run a client tool to completion (or until cancelled — the child is killed).
async fn run_tool(
    prog: &Path,
    args: &[String],
    env: &[(&str, &str)],
    stdin_file: Option<&str>,
    job: &Job,
) -> Result<String, AppError> {
    run_tool_tracked(prog, args, env, stdin_file, job, None).await
}

/// The last lines a tool printed (bounded: a verbose dump of 3000 tables prints
/// thousands of lines, only the end matters for the result / error).
struct TailLines {
    lines: std::collections::VecDeque<String>,
    /// every "…error: …" line of the run (the tail alone can miss early ones)
    errors: Vec<String>,
}

impl TailLines {
    fn push(&mut self, l: String) {
        if (l.contains("error:") || is_ora_error(&l)) && self.errors.len() < 2000 {
            self.errors.push(l.clone());
        }
        if self.lines.len() >= 400 {
            self.lines.pop_front();
        }
        self.lines.push_back(l);
    }
    fn text(&self) -> String {
        self.lines.iter().cloned().collect::<Vec<_>>().join("\n")
    }
}

/// Run a client tool, streaming its output: every line is read as it comes
/// (never waiting for the end — a full pipe would stall the tool), progress is
/// read from it or from the bytes fed to stdin, and Stop kills the process.
async fn run_tool_tracked(
    prog: &Path,
    args: &[String],
    env: &[(&str, &str)],
    stdin_file: Option<&str>,
    job: &Job,
    track: Option<Track>,
) -> Result<String, AppError> {
    use std::process::Stdio;
    use tokio::io::{AsyncBufReadExt, AsyncReadExt};
    let mut cmd = tokio::process::Command::new(prog);
    cmd.args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(if stdin_file.is_some() { Stdio::piped() } else { Stdio::null() })
        .kill_on_drop(true);
    for (k, v) in env {
        cmd.env(k, v);
    }
    bundled_lib_path(&mut cmd, prog);
    background(&mut cmd);
    let mut child = cmd
        .spawn()
        .map_err(|e| AppError::Driver(format!("Could not start {}: {e}", prog.display())))?;
    let name = prog.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let by_bytes = track.as_ref().is_some_and(|t| t.parse.is_none());
    if let Some(t) = &track {
        let total = if by_bytes { stdin_file.and_then(file_size) } else { t.total };
        job.stage(t.stage, total, t.unit);
    }
    let parse = track.as_ref().and_then(|t| t.parse);
    let tolerate = track.as_ref().and_then(|t| t.tolerate);
    let counts_total = track.as_ref().and_then(|t| t.counts_total);
    let settle = counts_total.is_some() || track.as_ref().is_some_and(|t| t.settle);

    let stdin = child.stdin.take();
    let feed = async {
        let (Some(f), Some(mut sin)) = (stdin_file, stdin) else { return Ok::<(), AppError>(()) };
        let mut file = tokio::fs::File::open(f).await.map_err(|e| AppError::Driver(format!("Cannot open {f}: {e}")))?;
        let mut buf = vec![0u8; 64 * 1024]; // small chunks: the bar moves as the tool reads
        let mut sent = 0u64;
        loop {
            let n = file.read(&mut buf).await.map_err(|e| AppError::Driver(format!("Cannot read {f}: {e}")))?;
            if n == 0 {
                break;
            }
            // the tool may stop reading (it failed) — its own error is the one to show
            if sin.write_all(&buf[..n]).await.is_err() {
                break;
            }
            sent += n as u64;
            if by_bytes {
                job.set_done(sent, None);
            }
        }
        drop(sin);
        Ok(())
    };
    let prefix_owned = format!("{name}: ");
    let prefix = prefix_owned.as_str();
    let read = |pipe: Option<Box<dyn tokio::io::AsyncRead + Unpin + Send>>| async move {
        let mut tail = TailLines { lines: Default::default(), errors: Vec::new() };
        let Some(pipe) = pipe else { return tail };
        let mut r = tokio::io::BufReader::new(pipe);
        let mut buf: Vec<u8> = Vec::new();
        loop {
            buf.clear();
            match r.read_until(b'\n', &mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    // tools print in the console code page on Windows: lossy, never fatal
                    let line = String::from_utf8_lossy(&buf).trim_end().to_string();
                    if let Some(p) = parse {
                        // a parallel tool (pg_restore -j) writes from several processes
                        // into one pipe, so messages can arrive glued into one line —
                        // read every message in it, not just the first
                        for msg in tool_messages(&line, &prefix) {
                            if let Some(obj) = p(msg) {
                                job.tick(Some(obj));
                            } else if counts_total.is_some_and(|f| f(msg)) {
                                job.report(false, |p| p.total = Some(p.total.unwrap_or(0) + 1));
                            }
                        }
                    }
                    tail.push(line);
                }
            }
        }
        tail
    };
    let out_pipe = child.stdout.take().map(|p| Box::new(p) as Box<dyn tokio::io::AsyncRead + Unpin + Send>);
    let err_pipe = child.stderr.take().map(|p| Box::new(p) as Box<dyn tokio::io::AsyncRead + Unpin + Send>);
    let work = async {
        let (fed, stdout, stderr) = tokio::join!(feed, read(out_pipe), read(err_pipe));
        let status = child.wait().await.map_err(|e| AppError::Driver(format!("{name} failed: {e}")))?;
        Ok::<_, AppError>((fed, status, stdout, stderr))
    };
    let (fed, status, stdout, stderr) = tokio::select! {
        r = work => r?,
        _ = job.token.cancelled() => return Err(cancelled_err()),
    };
    let tolerated = !status.success() && tolerate.is_some_and(|f| {
        let all: Vec<String> = stderr.errors.iter().chain(stdout.errors.iter()).cloned().collect();
        f(&all)
    });
    // the cause can be far above the tail (Data Pump prints every table first)
    let error_lines: Vec<String> = stderr.errors.iter().chain(stdout.errors.iter()).take(20).cloned().collect();
    let stderr = stderr.text();
    let stdout = stdout.text();
    if !status.success() && !tolerated {
        let mut raw = tail(if stderr.trim().is_empty() { &stdout } else { &stderr }, 4000);
        if error_lines.iter().any(|e| !raw.contains(e.as_str())) {
            raw = format!("{}\n…\n{}", error_lines.join("\n"), tail(&raw, 3000));
        }
        return Err(tool_failure(&name, &raw, status.code()));
    }
    fed?;
    // the last count may have been held back by the throttle — send it now; a
    // total counted from the output settles at what was actually done
    job.report(true, |p| {
        if settle {
            p.total = Some(p.done);
        }
    });
    Ok(tail(if stderr.trim().is_empty() { &stdout } else { &stderr }, 4000))
}

/// The messages in one line read from a tool's output. Every message a PostgreSQL /
/// MySQL client prints starts with `<tool>: `; when several processes share the
/// pipe (pg_restore -j) a line can hold more than one: `pg_restore: finished item
/// 1 TABLE DATA t_1pg_restore: finished item 2 TABLE DATA t_2`.
fn tool_messages<'a>(line: &'a str, prefix: &str) -> Vec<&'a str> {
    if prefix.len() <= 2 {
        return vec![line];
    }
    let mut cuts: Vec<usize> = line.match_indices(prefix).map(|(i, _)| i).filter(|&i| i > 0).collect();
    cuts.push(line.len());
    let mut out = Vec::with_capacity(cuts.len());
    let mut start = 0;
    for end in cuts {
        out.push(&line[start..end]);
        start = end;
    }
    out
}

fn tool_failure(name: &str, raw: &str, code: Option<i32>) -> AppError {
    let sys = if name.starts_with("pg_") || name == "psql" {
        "postgres"
    } else if name.starts_with("mariadb") {
        "mariadb"
    } else if name.starts_with("mysql") {
        "mysql"
    } else {
        "mongodb"
    };
    let code = code.map(|c| format!(" (exit code {c})")).unwrap_or_default();
    let mut msg = format!("{name} failed{code}.");
    if let Some(h) = explain_tool_error(sys, raw) {
        msg.push_str("\n\n");
        msg.push_str(&h);
    }
    if !raw.is_empty() {
        msg.push_str("\n\n");
        msg.push_str(raw);
    }
    AppError::Driver(msg)
}

fn file_size(p: &str) -> Option<u64> {
    std::fs::metadata(p).ok().map(|m| m.len())
}

fn ensure_parent(dest: &str) -> Result<(), AppError> {
    if let Some(parent) = Path::new(dest).parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            std::fs::create_dir_all(parent).map_err(|e| AppError::Driver(format!("Cannot create folder {}: {e}", parent.display())))?;
        }
    }
    Ok(())
}

fn require_file(src: &str) -> Result<(), AppError> {
    if !Path::new(src).is_file() {
        return Err(AppError::Driver(format!("Backup file not found: {src}")));
    }
    Ok(())
}

/// Client-side destinations must be absolute — a bare file name would land in
/// whatever folder the app happened to start in.
fn require_absolute(p: &str) -> Result<(), AppError> {
    if !Path::new(p).is_absolute() {
        return Err(AppError::Driver(format!(
            "Choose a full path for the backup file (Browse…) — \"{p}\" is not one."
        )));
    }
    Ok(())
}

fn default_client_dir() -> String {
    dirs::document_dir()
        .or_else(dirs::home_dir)
        .map(|d| d.join("Database Studio").join("Backups"))
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default()
}

/// Temp `--config` file for mongodump/mongorestore (holds the URI incl. password).
/// How many user tables the dump will go through (None when it cannot be read).
async fn table_total(state: &AppState, t: &Target) -> Option<u64> {
    total_by(state, t, table_count_sql(&t.system, &t.database)?).await
}

/// The number a `SELECT count(*) AS n …` returns in the database being backed up.
/// 0 is not a total (it would pin the bar at 0%): None.
async fn total_by(state: &AppState, t: &Target, sql: String) -> Option<u64> {
    let id = count_conn(state, t).await?;
    let o = exec_on(state, &id, sql).await.ok()?;
    rows_of(&o).first().and_then(|r| cell_str(r, "n").or_else(|| cell_str(r, "N"))).and_then(|v| v.parse().ok()).filter(|n: &u64| *n > 0)
}

/// A connection INTO the database being backed up. PostgreSQL's pg_class and SQL
/// Server's sys.tables only list the database a session is in, while the job's
/// connection may sit in another one (the profile's default) — counting there
/// gave "0 of 0 tables". The same `{id}::{db}` sub-connection the Explorer uses.
async fn count_conn(state: &AppState, t: &Target) -> Option<String> {
    let live = t.live_id.clone()?;
    if !matches!(t.system.as_str(), "postgres" | "mssql") || t.database.is_empty() {
        return Some(live);
    }
    let (mut profile, password, ssh_password) = state.registry.live_credentials(&live).ok()?;
    if profile.database == t.database {
        return Some(live);
    }
    let sub = format!("{}::{}", t.base_id, t.database);
    if state.registry.is_connected(&sub) {
        return Some(sub);
    }
    profile.id = sub.clone();
    profile.database = t.database.clone();
    state.registry.connect(profile, password, ssh_password).await.ok()?;
    Some(sub)
}

/// MongoDB: collections of the database being dumped.
async fn mongo_collection_total(state: &AppState, t: &Target) -> Option<u64> {
    if t.database.is_empty() {
        return None;
    }
    let id = t.live_id.clone()?;
    let db = t.database.clone();
    state
        .registry
        .with_driver(&id, move |d| async move {
            let g = d.lock().await;
            match &*g {
                LiveConnection::Mongo(m) => Ok(m.collections(&db).await.map(|c| c.len() as u64).ok()),
                _ => Ok(None),
            }
        })
        .await
        .ok()?
        .ok()
        .flatten()
}

/// TABLE DATA entries of a pg_dump custom archive (`pg_restore -l`), the total
/// a restore of it goes through.
async fn pg_archive_tables(pg_restore: &Path, src: &str) -> Option<u64> {
    let mut cmd = tokio::process::Command::new(pg_restore);
    cmd.arg("-l").arg(src).stdin(std::process::Stdio::null()).kill_on_drop(true);
    bundled_lib_path(&mut cmd, pg_restore);
    no_window(&mut cmd);
    let out = tokio::time::timeout(std::time::Duration::from_secs(60), cmd.output()).await.ok()?.ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    Some(text.lines().filter(|l| !l.starts_with(';') && l.contains(" TABLE DATA ")).count() as u64)
}

/// psql reading the script from stdin (so the bytes fed give the progress).
fn psql_stdin_args(t: &BackupTarget, o: &BackupOptions) -> Vec<String> {
    let mut a = psql_restore_args(t, "-", o);
    // drop the trailing `-f <file>`
    if a.len() >= 2 && a[a.len() - 2] == "-f" {
        a.truncate(a.len() - 2);
    }
    a
}

/// Major version of the PostgreSQL server (through the open connection).
async fn pg_major_of(state: &AppState, t: &Target) -> Option<u64> {
    let id = t.live_id.as_ref()?;
    let o = exec_on(state, id, "SHOW server_version_num".into()).await.ok()?;
    rows_of(&o).first().and_then(|r| cell_str(r, "server_version_num")).as_deref().and_then(pg_server_major)
}

/// First KBs of a file (the pg_dump header lives there).
fn read_head(path: &str, max: usize) -> Vec<u8> {
    use std::io::Read;
    let mut buf = Vec::new();
    if let Ok(f) = std::fs::File::open(path) {
        let _ = f.take(max as u64).read_to_end(&mut buf);
    }
    buf
}

/// Plain dump written by a newer pg_dump for an older server: neutralise the
/// 17+-only header setting in place (same length — nothing else in the file moves).
fn patch_pg_dump_header(path: &str, server_major: u64) -> Result<bool, AppError> {
    use std::io::{Seek, SeekFrom, Write};
    let head = read_head(path, 64 * 1024);
    let Some((at, rep)) = pg_plain_header_fix(&head, server_major) else { return Ok(false) };
    let mut f = std::fs::OpenOptions::new().write(true).open(path).map_err(|e| AppError::Driver(format!("Cannot update {path}: {e}")))?;
    f.seek(SeekFrom::Start(at as u64)).and_then(|_| f.write_all(&rep)).map_err(|e| AppError::Driver(format!("Cannot update {path}: {e}")))?;
    Ok(true)
}

/// A plain dump from elsewhere that an older server would reject at its header:
/// a temporary copy with the header fixed (the user's file is never changed).
fn pg_restorable_copy(src: &str, server_major: u64) -> Result<Option<TempFile>, AppError> {
    let head = read_head(src, 64 * 1024);
    if pg_plain_header_fix(&head, server_major).is_none() {
        return Ok(None);
    }
    let copy = std::env::temp_dir().join(format!("ds-restore-{}-{}.sql", std::process::id(), rand_suffix()));
    std::fs::copy(src, &copy).map_err(|e| AppError::Driver(format!("Cannot prepare {src} for restore: {e}")))?;
    let tmp = TempFile(copy);
    patch_pg_dump_header(&tmp.0.to_string_lossy(), server_major)?;
    Ok(Some(tmp))
}

/// ClickHouse BACKUP / RESTORE: no progress to read while it runs, but Stop
/// KILLs the query (through a second HTTP session — the first one is busy).
async fn clickhouse_cancellable(
    state: &AppState,
    t: &Target,
    id: &str,
    sql: String,
    stage: &str,
    file: &str,
    job: &Job,
) -> Result<StatementOutcome, AppError> {
    job.stage(stage, None, "");
    let run = exec_on(state, id, sql);
    tokio::pin!(run);
    tokio::select! {
        r = &mut run => r,
        _ = job.token.cancelled() => {
            if let Ok(k) = connection_to(state, t, "system").await {
                let pat = file.replace('\\', "\\\\").replace('\'', "\\'");
                let _ = exec_on(state, &k, format!("KILL QUERY WHERE query LIKE '%{pat}%' AND query NOT LIKE '%KILL QUERY%' SYNC")).await;
                if k.contains("::") {
                    let _ = state.registry.disconnect(&k).await;
                }
            }
            // the killed statement returns with an error — wait for it so the
            // connection is free again for the next action
            let _ = tokio::time::timeout(std::time::Duration::from_secs(15), &mut run).await;
            Err(cancelled_err())
        }
    }
}

/// A long SQL Server statement (BACKUP / RESTORE) with its `percent_complete`
/// polled from a second connection. `kill_command` set: Stop KILLs the session
/// running it (a cancelled BACKUP leaves nothing behind); empty: the statement
/// cannot be stopped safely (a killed RESTORE leaves the database "restoring").
async fn mssql_exec_with_progress(
    state: &AppState,
    t: &Target,
    exec_id: &str,
    sql: String,
    poll_db: &str,
    stage: &str,
    kill_command: &str,
    job: &Job,
) -> Result<StatementOutcome, AppError> {
    job.stage(stage, Some(100), "%");
    let poll = connection_to(state, t, poll_db).await.ok().filter(|p| p != exec_id);
    let run = exec_on(state, exec_id, sql);
    tokio::pin!(run);
    let mut tick = tokio::time::interval(std::time::Duration::from_millis(700));
    let mut stopping = false;
    let res = loop {
        tokio::select! {
            r = &mut run => break r,
            _ = tick.tick() => {
                if let Some(p) = &poll {
                    if let Ok(o) = exec_on(state, p, MSSQL_PROGRESS_SQL.into()).await {
                        if let Some(v) = rows_of(&o).first().and_then(|r| cell_str(r, "p")).and_then(|v| v.parse::<u64>().ok()) {
                            job.set_done(v, None);
                        }
                    }
                }
            }
            _ = job.token.cancelled(), if !stopping && !kill_command.is_empty() => {
                stopping = true;
                if let Some(p) = &poll {
                    let find = format!(
                        "SELECT TOP 1 session_id AS s FROM sys.dm_exec_requests WHERE command = '{}' AND database_id = DB_ID(N'{}')",
                        kill_command,
                        t.database.replace('\'', "''")
                    );
                    if let Ok(o) = exec_on(state, p, find).await {
                        if let Some(sid) = rows_of(&o).first().and_then(|r| cell_str(r, "s")).and_then(|v| v.parse::<i64>().ok()) {
                            let _ = exec_on(state, p, format!("KILL {sid}")).await;
                        }
                    }
                }
            }
        }
    };
    if let Some(p) = &poll {
        if p.contains("::") {
            let _ = state.registry.disconnect(p).await;
        }
    }
    if stopping {
        heal_connections_to(state, t, &t.database).await;
        return Err(cancelled_err());
    }
    let out = res?;
    job.report(true, |p| p.done = 100);
    Ok(out)
}

/// SqlPackage with its arguments in a private `@response` file (deleted on return)
/// so the password never appears on the command line.
async fn run_sqlpackage(prog: &Path, rsp: &str, job: &Job, track: Track) -> Result<String, AppError> {
    let file = TempFile(std::env::temp_dir().join(format!("ds-sqlpackage-{}-{}.rsp", std::process::id(), rand_suffix())));
    write_private(&file.0, rsp)?;
    let arg = format!("@{}", file.0.to_string_lossy());
    run_tool_tracked(prog, &[arg], &[], None, job, Some(track)).await
}

/// A file only the current user can read (it holds a password briefly).
fn write_private(path: &Path, content: &str) -> Result<(), AppError> {
    use std::io::Write;
    let mut o = std::fs::OpenOptions::new();
    o.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        o.mode(0o600);
    }
    let mut f = o.open(path).map_err(|e| AppError::Driver(format!("Cannot write {}: {e}", path.display())))?;
    f.write_all(content.as_bytes()).map_err(|e| AppError::Driver(format!("Cannot write {}: {e}", path.display())))
}

struct TempFile(PathBuf);
impl Drop for TempFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

fn mongo_config(t: &Target) -> Result<TempFile, AppError> {
    let ep = crate::drivers::Endpoint { host: t.host.clone(), port: t.port };
    let params = crate::drivers::mongo_params(&t.profile, &ep, &t.password);
    let uri = crate::drivers::mongo::connection_uri(&params);
    let path = std::env::temp_dir().join(format!("ds-mongo-{}-{}.yaml", std::process::id(), rand_suffix()));
    std::fs::write(&path, mongo_config_yaml(&uri)).map_err(|e| AppError::Driver(format!("temp config: {e}")))?;
    Ok(TempFile(path))
}

fn rand_suffix() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// statements through the app's connection
// ---------------------------------------------------------------------------

async fn exec_on(state: &AppState, id: &str, sql: String) -> Result<StatementOutcome, AppError> {
    state
        .registry
        .exec_statement(id, sql)
        .await?
        .map_err(|e| AppError::Driver(if e.hint.as_deref().is_some_and(|h| !h.is_empty()) {
            format!("{}\n\n{}", e.message, e.hint.unwrap_or_default())
        } else {
            e.message
        }))
}

fn rows_of(o: &StatementOutcome) -> Vec<serde_json::Value> {
    match o {
        StatementOutcome::Rows { result } => result.rows.clone(),
        _ => Vec::new(),
    }
}

fn cell_str(v: &serde_json::Value, key: &str) -> Option<String> {
    match v.get(key)? {
        serde_json::Value::Null => None,
        serde_json::Value::String(s) => Some(s.clone()),
        other => Some(other.to_string()),
    }
}

/// A connection to `database` on the same server, for statements that must not
/// run inside the database they act on (SQL Server RESTORE runs from master).
async fn connection_to(state: &AppState, t: &Target, database: &str) -> Result<String, AppError> {
    if t.profile.database.eq_ignore_ascii_case(database) {
        return Ok(t.live()?.to_string());
    }
    let id = format!("{}::{database}", t.base_id);
    if state.registry.is_connected(&id) {
        return Ok(id);
    }
    let live = t.live()?;
    let (mut profile, password, ssh_password) = state.registry.live_credentials(live)?;
    profile.id = id.clone();
    profile.database = database.to_string();
    state.registry.connect(profile, password, ssh_password).await?;
    Ok(id)
}

// ---------------------------------------------------------------------------
// plan
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn backup_tool_status(
    state: State<'_, AppState>,
    conn_id: String,
) -> Result<BackupToolStatus, AppError> {
    let system = resolve(&state, &conn_id, None).map(|t| t.system).unwrap_or_default();
    if matches!(system.as_str(), "sqlite" | "duckdb") {
        return Ok(BackupToolStatus { tool: Some("(in-process)".into()), available: true });
    }
    if matches!(system.as_str(), "mssql" | "clickhouse" | "cassandra" | "redis") {
        return Ok(BackupToolStatus { tool: Some("(via connection)".into()), available: true });
    }
    let names = backup_tool_names(&system);
    let found = locate(names, None, system == "postgres").await;
    Ok(BackupToolStatus {
        tool: found.as_ref().map(|l| l.name.clone()).or_else(|| backup_tool(&system).map(String::from)),
        available: found.is_some(),
    })
}

#[tauri::command]
pub async fn backup_plan(
    state: State<'_, AppState>,
    conn_id: String,
    database: Option<String>,
    tool_dir: Option<String>,
) -> Result<BackupPlan, AppError> {
    // Boxed: the per-engine branches make a large future (see run_backup).
    Box::pin(plan_for(&state, conn_id, database, tool_dir)).await
}

/// What Backup & Restore can do on `conn_id` (+ database) right now.
pub async fn plan_for(
    state: &AppState,
    conn_id: String,
    database: Option<String>,
    tool_dir: Option<String>,
) -> Result<BackupPlan, AppError> {
    let t = resolve(&state, &conn_id, database.as_deref())?;
    let connected = t.live_id.is_some();
    let mut plan = BackupPlan {
        system: t.system.clone(),
        database: t.database.clone(),
        method: "unsupported".into(),
        method_label: String::new(),
        server_side: false,
        backup_tool: None,
        restore_tools: Vec::new(),
        backup_ready: false,
        restore_ready: false,
        default_dir: default_client_dir(),
        local_dir: default_client_dir(),
        server_version: None,
        warnings: Vec::new(),
        install_hint: None,
        recent: Vec::new(),
        disks: Vec::new(),
        needs_connection: false,
        connected,
    };
    let td = tool_dir.as_deref();
    match t.system.as_str() {
        "postgres" | "mysql" | "mariadb" | "mongodb" => {
            plan.method = "tool".into();
            let newest = t.system == "postgres";
            let b = locate(backup_tool_names(&t.system), td, newest).await;
            let names = restore_tool_names(&t.system);
            let mut restores = Vec::new();
            if t.system == "postgres" {
                for n in names {
                    restores.push(tool_info(n, &locate(&[n], td, true).await));
                }
            } else {
                restores.push(tool_info(names[0], &locate(names, td, false).await));
            }
            plan.method_label = b.as_ref().map(|l| l.name.clone()).unwrap_or_else(|| backup_tool_names(&t.system)[0].to_string());
            plan.backup_ready = b.is_some();
            plan.restore_ready = restores.iter().any(|r| r.found);
            if b.is_none() || !plan.restore_ready {
                plan.install_hint = install_hint(&t.system);
            }
            // pg_dump refuses to dump a server newer than itself.
            if t.system == "postgres" {
                if let Some(id) = &t.live_id {
                    if let Ok(o) = exec_on(&state, id, "SHOW server_version_num".into()).await {
                        let v = rows_of(&o).first().and_then(|r| cell_str(r, "server_version_num"));
                        if let (Some(server), Some(l)) = (v.as_deref().and_then(pg_server_major), b.as_ref()) {
                            plan.server_version = Some(format!("PostgreSQL {server}"));
                            // only a KNOWN older version blocks; an unread one (slow to
                            // answer) is left to pg_dump itself, which reports a mismatch
                            let tool_major = l.version.as_deref().and_then(parse_version).map(|v| v.0);
                            if tool_major.is_some_and(|m| m < server) {
                                plan.backup_ready = false;
                                plan.warnings.push(format!(
                                    "{} {} is older than the server (PostgreSQL {server}) and will refuse to back it up. Install PostgreSQL {server} client tools or newer, then press Check again.",
                                    l.name,
                                    l.version.as_deref().and_then(parse_version).map(|v| format!("{}.{}", v.0, v.1)).unwrap_or_default()
                                ));
                            }
                        }
                    }
                }
            }
            if t.system == "mariadb" {
                if let Some(l) = &b {
                    if my_flavor(l.version.as_deref().unwrap_or("")) == MyFlavor::Mysql {
                        plan.warnings.push("Using MySQL's mysqldump against MariaDB. It works for tables and data; MariaDB-only features are dumped best when mariadb-dump is installed.".into());
                    }
                }
            }
            if t.profile.ssh.enabled && !connected {
                plan.warnings.push("This connection uses an SSH tunnel — open it before backing up so the tool can use the tunnel.".into());
            }
            plan.backup_tool = Some(tool_info(backup_tool_names(&t.system)[0], &b));
            plan.restore_tools = restores;
        }
        "oracle" => {
            plan.method = "tool".into();
            plan.server_side = true;
            plan.needs_connection = true;
            let b = locate(&["expdp"], td, false).await;
            let r = locate(&["impdp"], td, false).await;
            plan.method_label = "Data Pump (expdp / impdp)".into();
            plan.backup_ready = b.is_some() && connected;
            plan.restore_ready = r.is_some() && connected;
            if b.is_none() || r.is_none() {
                plan.install_hint = install_hint("oracle");
            }
            plan.backup_tool = Some(tool_info("expdp", &b));
            plan.restore_tools = vec![tool_info("impdp", &r)];
            plan.default_dir = String::new();
            if let Some(id) = &t.live_id {
                if let Ok(o) = exec_on(
                    &state,
                    id,
                    "SELECT directory_path AS p FROM all_directories WHERE directory_name = 'DATA_PUMP_DIR'".into(),
                )
                .await
                {
                    if let Some(p) = rows_of(&o).first().and_then(|r| cell_str(r, "p").or_else(|| cell_str(r, "P"))) {
                        plan.default_dir = p;
                    }
                }
            }
        }
        "mssql" => {
            plan.method = "server".into();
            plan.method_label = "Native BACKUP DATABASE".into();
            plan.server_side = true;
            plan.needs_connection = true;
            plan.backup_ready = connected;
            plan.restore_ready = connected;
            plan.default_dir = String::new();
            // .bacpac to / from this computer: SqlPackage (shipped with the app)
            let sp = locate(&["sqlpackage"], td, false).await;
            if sp.is_none() {
                plan.install_hint = install_hint("mssql");
            }
            plan.backup_tool = Some(tool_info("sqlpackage", &sp));
            plan.restore_tools = vec![tool_info("sqlpackage", &sp)];
            if let Some(id) = &t.live_id {
                if let Ok(o) = exec_on(&state, id, MSSQL_DEFAULT_PATH_SQL.into()).await {
                    if let Some(p) = rows_of(&o).first().and_then(|r| cell_str(r, "p")) {
                        plan.default_dir = p;
                    }
                }
                if let Ok(o) = exec_on(&state, id, mssql_recent_backups_sql(&t.database)).await {
                    plan.recent = rows_of(&o)
                        .iter()
                        .filter_map(|r| {
                            Some(ServerBackup {
                                path: cell_str(r, "path")?,
                                finished: cell_str(r, "finished").unwrap_or_default(),
                                size: r.get("size").and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok()))),
                            })
                        })
                        .collect();
                }
            }
        }
        "clickhouse" => {
            plan.method = "server".into();
            plan.method_label = "Native BACKUP DATABASE".into();
            plan.server_side = true;
            plan.needs_connection = true;
            plan.backup_ready = connected;
            plan.restore_ready = connected;
            plan.default_dir = String::new();
            if let Some(id) = &t.live_id {
                if let Ok(o) = exec_on(&state, id, "SELECT name FROM system.disks ORDER BY name".into()).await {
                    plan.disks = rows_of(&o).iter().filter_map(|r| cell_str(r, "name")).collect();
                }
                if !plan.disks.iter().any(|d| d == "backups") {
                    plan.warnings.push("ClickHouse writes backups to a disk allowed in its server config (<backups><allowed_disk>…). No disk named \"backups\" was found — pick the configured one, or ask the server admin to add it.".into());
                }
            }
        }
        "sqlite" | "duckdb" => {
            plan.method = "in-process".into();
            plan.method_label = if t.system == "sqlite" { "SQLite online backup".into() } else { "DuckDB copy".into() };
            plan.needs_connection = true;
            plan.backup_ready = connected;
            plan.restore_ready =
                connected && !matches!(t.profile.sqlite_mode, crate::connections::profile::SqliteMode::ReadOnly);
        }
        "cassandra" => {
            plan.method = "built-in".into();
            plan.method_label = "Built-in CQL dump".into();
            plan.needs_connection = true;
            plan.backup_ready = connected;
            plan.restore_ready = connected;
            plan.warnings.push("Rows are written as INSERT … JSON. Counter tables are skipped (counters cannot be inserted), and remaining TTLs are not carried over.".into());
        }
        "redis" => {
            plan.method = "built-in".into();
            plan.method_label = "Built-in DUMP / RESTORE".into();
            plan.needs_connection = true;
            plan.backup_ready = connected;
            plan.restore_ready = connected;
            plan.warnings.push("Backs up one logical database. The file restores on the same Redis version or newer.".into());
        }
        _ => {}
    }
    if plan.needs_connection && !connected {
        plan.warnings.insert(0, "Open the connection first — this backup runs through it.".into());
    }
    Ok(plan)
}

// ---------------------------------------------------------------------------
// backup
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn backup_database(
    state: State<'_, AppState>,
    conn_id: String,
    dest: String,
    options: Option<BackupOptions>,
    on_progress: tauri::ipc::Channel<BackupProgress>,
) -> Result<BackupOutcome, AppError> {
    attach_channel(&options, on_progress);
    // Boxed: one branch per engine makes this a large future; keep it on the heap.
    Box::pin(run_backup(&state, conn_id, dest, options)).await
}

/// Back up `conn_id` (+ options.database) to `dest`.
pub async fn run_backup(
    state: &AppState,
    conn_id: String,
    dest: String,
    options: Option<BackupOptions>,
) -> Result<BackupOutcome, AppError> {
    let o = options.unwrap_or_default();
    let job = Job::start(o.job_id.clone());
    let t = resolve(&state, &conn_id, o.database.as_deref())?;
    let started = Instant::now();
    let dest = dest.trim().to_string();
    if dest.is_empty() {
        return Err(AppError::Driver("Choose where to save the backup.".into()));
    }
    let mut out = BackupOutcome {
        message: String::new(),
        path: dest.clone(),
        bytes: None,
        duration_ms: 0,
        server_side: false,
        log: String::new(),
        notes: Vec::new(),
        items: None,
    };
    // SQL Server writes a .bak on the server, or a .bacpac here (SqlPackage)
    let bacpac = t.system == "mssql" && mssql_is_bacpac(o.format.as_deref(), &dest);
    let client_file = bacpac || !matches!(t.system.as_str(), "mssql" | "clickhouse" | "oracle");
    if client_file {
        require_absolute(&dest)?;
        ensure_parent(&dest)?;
    }
    let result: Result<(), AppError> = async {
        match t.system.as_str() {
            "postgres" => {
                require_reachable(&t)?;
                let tool = locate(&["pg_dump"], o.tool_dir.as_deref(), true)
                    .await
                    .ok_or_else(|| AppError::Driver(install_hint("postgres").unwrap_or_default()))?;
                let mut args = pg_dump_args(&t.tool_target(), &dest, &o);
                args.insert(0, "-v".into()); // one line per table → progress
                // what pg_dump prints per table depends on the format and content —
                // count by the line it really prints, to the total it really reaches
                let count = pg_dump_count(o.format.as_deref(), o.content.as_deref());
                let total = match pg_table_count_sql(count) {
                    Some(sql) => total_by(state, &t, sql).await,
                    None => None,
                };
                let track = match count {
                    PgDumpCount::Data => Track::lines("Backing up", total, "tables", pg_dump_progress),
                    PgDumpCount::Schema => Track::lines("Backing up", total, "tables", pg_dump_schema_progress),
                    // a structure-only custom archive names no table — it is
                    // counted by the catalog steps pg_dump prints instead
                    PgDumpCount::Unmeasured => {
                        let mut t = Track::lines("Reading the catalog", Some(PG_DUMP_CATALOG_STEPS), "steps", pg_dump_step);
                        t.settle = true;
                        t
                    }
                };
                out.log = run_tool_tracked(
                    &tool.path,
                    &args,
                    &[("PGPASSWORD", &t.password), ("PGCONNECT_TIMEOUT", "15")],
                    None,
                    &job,
                    Some(track),
                )
                .await?;
                // a newer pg_dump (the bundled one) writes a header the older
                // server it came from would refuse when the file is restored
                if o.format.as_deref() != Some("custom") {
                    if let Some(major) = pg_major_of(state, &t).await {
                        if patch_pg_dump_header(&dest, major)? {
                            out.notes.push(format!("Left out the PostgreSQL 17+ setting transaction_timeout so the file restores into this PostgreSQL {major} server."));
                        }
                    }
                }
                out.message = format!("Backed up {} with {}", t.database, tool.version.unwrap_or(tool.name));
            }
            "mysql" | "mariadb" => {
                require_reachable(&t)?;
                if t.database.is_empty() {
                    return Err(AppError::Driver("Choose the database to back up.".into()));
                }
                let tool = locate(backup_tool_names(&t.system), o.tool_dir.as_deref(), false)
                    .await
                    .ok_or_else(|| AppError::Driver(install_hint(&t.system).unwrap_or_default()))?;
                let flavor = my_flavor(tool.version.as_deref().unwrap_or(""));
                let mut args = mysqldump_args(&t.system, &t.tool_target(), &dest, &o, flavor);
                args.insert(0, "--verbose".into()); // one line per table → progress
                with_plugin_dir(&mut args, &tool.path);
                let total = table_total(state, &t).await;
                out.log = run_tool_tracked(
                    &tool.path,
                    &args,
                    &[("MYSQL_PWD", &t.password)],
                    None,
                    &job,
                    Some(Track::lines("Backing up", total, "tables", mysqldump_progress)),
                )
                .await?;
                out.message = format!("Backed up {} with {}", t.database, tool.name);
            }
            "mongodb" => {
                require_reachable(&t)?;
                let tool = locate(&["mongodump"], o.tool_dir.as_deref(), false)
                    .await
                    .ok_or_else(|| AppError::Driver(install_hint("mongodb").unwrap_or_default()))?;
                let cfg = mongo_config(&t)?;
                let args = mongodump_args(&cfg.0.to_string_lossy(), &t.database, &dest, &o);
                let total = mongo_collection_total(state, &t).await;
                out.log = run_tool_tracked(&tool.path, &args, &[], None, &job, Some(Track::lines("Backing up", total, "collections", mongodump_progress))).await?;
                out.message = if t.database.is_empty() {
                    "Backed up every database with mongodump".into()
                } else {
                    format!("Backed up {} with mongodump", t.database)
                };
            }
            "sqlite" => {
                job.stage("Backing up", None, "");
                let id = t.live()?.to_string();
                let d = dest.clone();
                state
                    .registry
                    .with_driver(&id, move |drv| async move {
                        let g = drv.lock().await;
                        match &*g {
                            LiveConnection::Sqlite(s) => s.backup_to(d).await,
                            _ => Err(QueryError::new("sqlite", "Connection is not SQLite", "")),
                        }
                    })
                    .await?
                    .map_err(|e| AppError::Driver(e.message))?;
                out.message = "Backed up the SQLite database".into();
            }
            "duckdb" => {
                job.stage("Backing up", None, "");
                let id = t.live()?.to_string();
                let d = dest.clone();
                state
                    .registry
                    .with_driver(&id, move |drv| async move {
                        let g = drv.lock().await;
                        match &*g {
                            LiveConnection::Duckdb(s) => s.backup_to(d).await,
                            _ => Err(QueryError::new("duckdb", "Connection is not DuckDB", "")),
                        }
                    })
                    .await?
                    .map_err(|e| AppError::Driver(e.message))?;
                out.message = format!("Backed up {} to a DuckDB file", if t.database.is_empty() { "the database" } else { &t.database });
            }
            "mssql" if bacpac => {
                require_reachable(&t)?;
                let tool = locate(&["sqlpackage"], o.tool_dir.as_deref(), false)
                    .await
                    .ok_or_else(|| AppError::Driver(install_hint("mssql").unwrap_or_default()))?;
                let rsp = sqlpackage_export_rsp(&t.tool_target(), &t.password, &t.profile.mssql_auth, &dest).map_err(AppError::Driver)?;
                let total = table_total(state, &t).await;
                out.log = run_sqlpackage(&tool.path, &rsp, &job, Track::lines("Exporting", total, "tables", sqlpackage_progress)).await?;
                out.message = format!("Exported {} to this computer with SqlPackage", t.database);
            }
            "mssql" => {
                let id = t.live()?.to_string();
                let sql = mssql_backup_sql_opts(&t.database, &dest, o.copy_only.unwrap_or(true), o.compression.unwrap_or(false));
                mssql_exec_with_progress(state, &t, &id, sql, "master", "Backing up", "BACKUP DATABASE", &job).await?;
                out.server_side = true;
                out.message = format!("Backed up {} on the SQL Server host", t.database);
                if let Ok(o2) = exec_on(&state, &id, mssql_recent_backups_sql(&t.database)).await {
                    if let Some(r) = rows_of(&o2).first() {
                        out.bytes = r.get("size").and_then(|v| v.as_u64().or_else(|| v.as_str().and_then(|s| s.parse().ok())));
                    }
                }
            }
            "clickhouse" => {
                let id = t.live()?.to_string();
                let disk = o.disk.clone().filter(|d| !d.is_empty()).unwrap_or_else(|| "backups".into());
                let file = clickhouse_file_name(&dest);
                out.path = format!("Disk('{disk}', '{file}')");
                let res = clickhouse_cancellable(state, &t, &id, clickhouse_backup_sql(&t.database, &disk, &file), "Backing up", &file, &job).await?;
                check_clickhouse_status(&res, "BACKUP_CREATED")?;
                out.server_side = true;
                out.message = format!("Backed up {} on the ClickHouse server", t.database);
            }
            "oracle" => {
                let id = t.live()?.to_string();
                let (os_dir, dumpfile, logfile) = datapump_paths(&dest);
                exec_on(&state, &id, oracle_dir_sql("DBSTUDIO_DUMP", &os_dir)).await?;
                let tool = locate(&["expdp"], o.tool_dir.as_deref(), false)
                    .await
                    .ok_or_else(|| AppError::Driver(install_hint("oracle").unwrap_or_default()))?;
                let (_, args) = oracle_expdp_cmd(&t.tool_target(), "DBSTUDIO_DUMP", &dumpfile, &logfile);
                let total = table_total(state, &t).await;
                out.log = run_datapump(state, &tool.path, args, &t, &job, "Exporting", total).await?;
                out.server_side = true;
                out.message = format!("Exported schema {} with Data Pump", t.profile.user);
            }
            "cassandra" => {
                let (rows, notes) = Box::pin(cassandra_dump(&state, &t, &dest, &job)).await?;
                out.items = Some(rows);
                out.notes = notes;
                out.message = format!("Backed up keyspace {}", t.database);
            }
            "redis" => {
                let keys = Box::pin(redis_dump(&state, &t, &dest, &job)).await?;
                out.items = Some(keys);
                out.message = format!("Backed up {keys} key(s) of db{}", redis_db(&t));
            }
            other => {
                return Err(AppError::Driver(format!("Backup is not available for {other}.")));
            }
        }
        Ok(())
    }
    .await;
    if let Err(e) = result {
        if client_file && job.cancelled() {
            // the killed tool may still hold the file for a moment (Windows)
            for _ in 0..20 {
                match std::fs::remove_file(&dest) {
                    Err(e) if e.kind() != std::io::ErrorKind::NotFound => tokio::time::sleep(std::time::Duration::from_millis(100)).await,
                    _ => break,
                }
            }
        }
        return Err(e);
    }
    out.duration_ms = started.elapsed().as_millis() as u64;
    if client_file {
        out.bytes = file_size(&dest);
    }
    Ok(out)
}

fn check_clickhouse_status(o: &StatementOutcome, ok: &str) -> Result<(), AppError> {
    if let Some(r) = rows_of(o).first() {
        if let Some(status) = cell_str(r, "status") {
            if status != ok {
                let err = cell_str(r, "error").unwrap_or_default();
                return Err(AppError::Driver(format!("ClickHouse reported {status}. {err}")));
            }
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// restore
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn restore_database(
    state: State<'_, AppState>,
    conn_id: String,
    src: String,
    options: Option<BackupOptions>,
    on_progress: tauri::ipc::Channel<BackupProgress>,
) -> Result<BackupOutcome, AppError> {
    attach_channel(&options, on_progress);
    Box::pin(run_restore(&state, conn_id, src, options)).await
}

/// Restore `src` into `conn_id` (+ options.database).
pub async fn run_restore(
    state: &AppState,
    conn_id: String,
    src: String,
    options: Option<BackupOptions>,
) -> Result<BackupOutcome, AppError> {
    let o = options.unwrap_or_default();
    let job = Job::start(o.job_id.clone());
    let t = resolve(&state, &conn_id, o.database.as_deref())?;
    let started = Instant::now();
    let src = src.trim().to_string();
    if src.is_empty() {
        return Err(AppError::Driver("Choose the backup file to restore.".into()));
    }
    let mut out = BackupOutcome {
        message: String::new(),
        path: src.clone(),
        bytes: None,
        duration_ms: 0,
        server_side: false,
        log: String::new(),
        notes: Vec::new(),
        items: None,
    };
    match t.system.as_str() {
        "postgres" => {
            require_reachable(&t)?;
            require_file(&src)?;
            let mut head = [0u8; 5];
            let n = {
                use std::io::Read;
                std::fs::File::open(&src).and_then(|mut f| f.read(&mut head)).unwrap_or(0)
            };
            let archive = is_pg_archive(&head[..n]);
            let name = if archive { "pg_restore" } else { "psql" };
            let tool = locate(&[name], o.tool_dir.as_deref(), true).await.ok_or_else(|| {
                AppError::Driver(format!(
                    "This is {} — restoring it needs {name}. {}",
                    if archive { "a pg_dump custom-format archive" } else { "an SQL script" },
                    install_hint("postgres").unwrap_or_default()
                ))
            })?;
            let pg_env = [("PGPASSWORD", t.password.as_str()), ("PGCONNECT_TIMEOUT", "15")];
            let server = pg_major_of(state, &t).await;
            let tool_major = tool.version.as_deref().and_then(parse_version).map(|v| v.0).unwrap_or(0);
            let newer_tool = tool_major >= 17 && server.is_some_and(|s| s < 17);
            let single = o.single_transaction.unwrap_or(false);
            if archive && newer_tool && single {
                // pg_restore 17+ sends `SET transaction_timeout` even to an older
                // server, which rejects it — harmless on its own, but inside
                // "single transaction" it aborts everything. Turn the archive into
                // a script, fix its header, and apply it with psql instead.
                let psql = locate(&["psql"], o.tool_dir.as_deref(), true)
                    .await
                    .ok_or_else(|| AppError::Driver(install_hint("postgres").unwrap_or_default()))?;
                let script = TempFile(std::env::temp_dir().join(format!("ds-restore-{}-{}.sql", std::process::id(), rand_suffix())));
                let script_path = script.0.to_string_lossy().to_string();
                job.stage("Preparing", None, "");
                let mut log = run_tool(&tool.path, &pg_restore_to_script_args(&src, &script_path, &o), &[], None, &job).await?;
                patch_pg_dump_header(&script_path, server.unwrap_or(0))?;
                log.push_str(
                    &run_tool_tracked(&psql.path, &psql_stdin_args(&t.tool_target(), &o), &pg_env, Some(&script_path), &job, Some(Track::bytes("Restoring"))).await?,
                );
                out.log = log;
                out.notes.push(format!(
                    "Restored through psql: this pg_restore ({}) is newer than the PostgreSQL {} server, so its 17+-only setting was left out.",
                    tool.version.clone().unwrap_or_default(),
                    server.unwrap_or(0)
                ));
                out.message = format!("Restored {} with pg_restore + psql", t.database);
            } else {
                // an SQL dump from a newer pg_dump: restore a header-fixed copy
                let fixed = match (archive, server) {
                    (false, Some(major)) => pg_restorable_copy(&src, major)?,
                    _ => None,
                };
                let script = fixed.as_ref().map(|f| f.0.to_string_lossy().to_string()).unwrap_or_else(|| src.clone());
                out.log = if archive {
                    // straight into the database, several tables at once
                    let cores = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(2);
                    let jobs = pg_restore_jobs(single, cores);
                    let mut args = pg_restore_args(&t.tool_target(), &src, &o);
                    args.insert(0, "-v".into());
                    if jobs > 1 {
                        args.insert(0, format!("-j{jobs}"));
                    }
                    let total = pg_archive_tables(&tool.path, &src).await;
                    let parse = if jobs > 1 { pg_restore_parallel_progress } else { pg_restore_progress };
                    let mut track = Track::lines("Restoring", total, "tables", parse);
                    if newer_tool {
                        // the 17+-only `SET transaction_timeout` is the one thing an
                        // older server rejects; any other error still fails the run
                        track.tolerate = Some(pg_only_transaction_timeout_errors);
                    }
                    let log = run_tool_tracked(&tool.path, &args, &pg_env, None, &job, Some(track)).await?;
                    if jobs > 1 {
                        out.notes.push(format!("Restored with {jobs} parallel jobs."));
                    }
                    if newer_tool && log.contains("transaction_timeout") {
                        out.notes.push(format!(
                            "This pg_restore ({}) is newer than the PostgreSQL {} server; the server skipped its 17+-only transaction_timeout setting. Nothing else was affected.",
                            tool.version.clone().unwrap_or_default(),
                            server.unwrap_or(0)
                        ));
                    }
                    log
                } else {
                    // the script is fed through stdin: progress = bytes applied
                    run_tool_tracked(&tool.path, &psql_stdin_args(&t.tool_target(), &o), &pg_env, Some(&script), &job, Some(Track::bytes("Restoring"))).await?
                };
                if fixed.is_some() {
                    out.notes.push("This SQL file was made by a newer pg_dump; its PostgreSQL 17+ setting was left out (your file is unchanged).".into());
                }
                out.message = format!("Restored {} with {name}", t.database);
            }
        }
        "mysql" | "mariadb" => {
            require_reachable(&t)?;
            require_file(&src)?;
            if t.database.is_empty() {
                return Err(AppError::Driver("Choose the database to restore into.".into()));
            }
            let tool = locate(restore_tool_names(&t.system), o.tool_dir.as_deref(), false)
                .await
                .ok_or_else(|| AppError::Driver(install_hint(&t.system).unwrap_or_default()))?;
            let mut args = mysql_restore_args(&t.tool_target());
            with_plugin_dir(&mut args, &tool.path);
            out.log = run_tool_tracked(&tool.path, &args, &[("MYSQL_PWD", &t.password)], Some(&src), &job, Some(Track::bytes("Restoring"))).await?;
            out.message = format!("Restored {} with {}", t.database, tool.name);
        }
        "mongodb" => {
            require_reachable(&t)?;
            require_file(&src)?;
            let tool = locate(&["mongorestore"], o.tool_dir.as_deref(), false)
                .await
                .ok_or_else(|| AppError::Driver(install_hint("mongodb").unwrap_or_default()))?;
            let cfg = mongo_config(&t)?;
            // the archive is fed through stdin; progress = collections restored. The
            // archive is small next to the work the server does per collection, so
            // counting bytes jumped to 100% and then sat there.
            let args: Vec<String> = mongorestore_args(&cfg.0.to_string_lossy(), &t.database, &src, &o)
                .into_iter()
                .map(|a| if a.starts_with("--archive=") { "--archive".to_string() } else { a })
                .collect();
            let mut track = Track::lines("Restoring", None, "collections", mongorestore_progress);
            track.counts_total = Some(mongorestore_announces);
            out.log = run_tool_tracked(&tool.path, &args, &[], Some(&src), &job, Some(track)).await?;
            out.message = "Restored with mongorestore".into();
        }
        "sqlite" => {
            require_file(&src)?;
            job.stage("Restoring", None, "");
            let id = t.live()?.to_string();
            let s2 = src.clone();
            state
                .registry
                .with_driver(&id, move |drv| async move {
                    let g = drv.lock().await;
                    match &*g {
                        LiveConnection::Sqlite(s) => s.restore_from(s2).await,
                        _ => Err(QueryError::new("sqlite", "Connection is not SQLite", "")),
                    }
                })
                .await?
                .map_err(|e| AppError::Driver(e.message))?;
            out.message = "Restored the SQLite database".into();
        }
        "duckdb" => {
            require_file(&src)?;
            job.stage("Restoring", None, "");
            let id = t.live()?.to_string();
            let s2 = src.clone();
            state
                .registry
                .with_driver(&id, move |drv| async move {
                    let g = drv.lock().await;
                    match &*g {
                        LiveConnection::Duckdb(s) => s.restore_from(s2).await,
                        _ => Err(QueryError::new("duckdb", "Connection is not DuckDB", "")),
                    }
                })
                .await?
                .map_err(|e| AppError::Driver(e.message))?;
            out.message = "Restored the DuckDB database".into();
        }
        "mssql" if mssql_is_bacpac(o.format.as_deref(), &src) => {
            require_reachable(&t)?;
            require_file(&src)?;
            let tool = locate(&["sqlpackage"], o.tool_dir.as_deref(), false)
                .await
                .ok_or_else(|| AppError::Driver(install_hint("mssql").unwrap_or_default()))?;
            let target = o.as_database.clone().filter(|a| !a.trim().is_empty()).unwrap_or_else(|| t.database.clone());
            // SqlPackage only imports into a new (or empty) database
            if o.clean.unwrap_or(false) {
                let master = connection_to(&state, &t, "master").await?;
                let res = exec_on(&state, &master, mssql_drop_database_batch(&target)).await;
                if master.contains("::") {
                    let _ = state.registry.disconnect(&master).await;
                }
                res?;
            }
            let rsp = sqlpackage_import_rsp(&t.tool_target(), &t.password, &t.profile.mssql_auth, &src, &target).map_err(AppError::Driver)?;
            out.log = run_sqlpackage(&tool.path, &rsp, &job, Track::lines("Importing", None, "tables", sqlpackage_progress)).await?;
            // the app's sessions in the dropped database are gone — reopen them
            heal_connections_to(&state, &t, &target).await;
            out.message = format!("Imported {target} from the .bacpac with SqlPackage");
        }
        "mssql" => {
            // From master: the target database must have no sessions, ours included.
            let master = connection_to(&state, &t, "master").await?;
            let res = mssql_exec_with_progress(state, &t, &master, mssql_restore_batch(&t.database, &src), "msdb", "Restoring", "", &job).await;
            if master.contains("::") {
                let _ = state.registry.disconnect(&master).await;
            }
            res?;
            // Sessions the app had in that database were killed by SINGLE_USER.
            heal_connections_to(&state, &t, &t.database).await;
            out.server_side = true;
            out.message = format!("Restored {} on the SQL Server host", t.database);
        }
        "clickhouse" => {
            let id = t.live()?.to_string();
            let disk = o.disk.clone().filter(|d| !d.is_empty()).unwrap_or_else(|| "backups".into());
            let file = clickhouse_file_name(&src);
            let target = o.as_database.clone().filter(|a| !a.is_empty()).unwrap_or_else(|| t.database.clone());
            if o.clean.unwrap_or(false) {
                exec_on(&state, &id, clickhouse_drop_sql(&target)).await?;
            }
            let res = clickhouse_cancellable(state, &t, &id, clickhouse_restore_sql(&t.database, Some(&target), &disk, &file), "Restoring", &file, &job).await?;
            check_clickhouse_status(&res, "RESTORED")?;
            out.server_side = true;
            out.path = format!("Disk('{disk}', '{file}')");
            out.message = format!("Restored {target} on the ClickHouse server");
        }
        "oracle" => {
            let id = t.live()?.to_string();
            let (os_dir, dumpfile, logfile) = datapump_paths(&src);
            exec_on(&state, &id, oracle_dir_sql("DBSTUDIO_DUMP", &os_dir)).await?;
            let tool = locate(&["impdp"], o.tool_dir.as_deref(), false)
                .await
                .ok_or_else(|| AppError::Driver(install_hint("oracle").unwrap_or_default()))?;
            let (_, args) = oracle_impdp_cmd(&t.tool_target(), "DBSTUDIO_DUMP", &dumpfile, &logfile);
            out.log = run_datapump(state, &tool.path, args, &t, &job, "Importing", None).await?;
            if out.log.contains("ORA-31684") {
                out.notes.push(format!("The schema user {} already existed, so it was kept as it is — only its objects and data were imported.", t.profile.user));
            }
            out.server_side = true;
            out.message = format!("Imported schema {} with Data Pump", t.profile.user);
        }
        "cassandra" => {
            require_file(&src)?;
            let n = Box::pin(cassandra_restore(&state, &t, &src, &job)).await?;
            out.items = Some(n);
            out.message = format!("Ran {n} statement(s) from the backup");
        }
        "redis" => {
            require_file(&src)?;
            let (restored, skipped) = Box::pin(redis_restore(&state, &t, &src, o.clean.unwrap_or(false), &job)).await?;
            out.items = Some(restored);
            if skipped > 0 {
                out.notes.push(format!("{skipped} key(s) already existed and were kept (turn on \"Replace existing keys\" to overwrite them)."));
            }
            out.message = format!("Restored {restored} key(s) into db{}", redis_db(&t));
        }
        other => return Err(AppError::Driver(format!("Restore is not available for {other}."))),
    }
    out.duration_ms = started.elapsed().as_millis() as u64;
    if !out.server_side {
        out.bytes = file_size(&src);
    }
    Ok(out)
}

/// After a restore that killed sessions in `database`, reconnect the app's own
/// connections to it so the next query does not hit a dead socket.
async fn heal_connections_to(state: &AppState, t: &Target, database: &str) {
    let sub = format!("{}::{database}", t.base_id);
    for id in state.registry.connected_ids() {
        let into_db = id == sub
            || ((id == t.base_id || id.starts_with(&format!("{}#", t.base_id)))
                && state
                    .registry
                    .live_credentials(&id)
                    .map(|(p, _, _)| p.database.eq_ignore_ascii_case(database))
                    .unwrap_or(false));
        if into_db {
            let _ = state.registry.reconnect_now(&id).await;
        }
    }
}

// ---------------------------------------------------------------------------
// Oracle Data Pump
// ---------------------------------------------------------------------------

async fn run_datapump(state: &AppState, prog: &Path, args: Vec<String>, t: &Target, job: &Job, stage: &'static str, total: Option<u64>) -> Result<String, AppError> {
    // a named job, so Stop can end it on the server too (killing the client
    // alone leaves a Data Pump job running there)
    let job_name = format!("DBSTUDIO_{}", rand_suffix() % 1_000_000_000);
    let mut args = args;
    args.push(format!("JOB_NAME={job_name}"));
    let par = TempFile(std::env::temp_dir().join(format!("ds-datapump-{}-{}.par", std::process::id(), rand_suffix())));
    write_private(&par.0, &oracle_parfile(&t.tool_target(), &t.password))?;
    let args = oracle_with_parfile(args, &par.0.to_string_lossy());
    let mut track = Track::lines(stage, total, "tables", datapump_progress);
    if stage == "Importing" {
        track.tolerate = Some(datapump_only_already_exists);
    }
    let r = run_tool_tracked(prog, &args, &[], None, job, Some(track)).await;
    if job.cancelled() {
        if let Some(id) = &t.live_id {
            let stop = format!(
                "DECLARE h NUMBER; BEGIN h := DBMS_DATAPUMP.ATTACH('{job_name}', USER); DBMS_DATAPUMP.STOP_JOB(h, 1, 0); EXCEPTION WHEN OTHERS THEN NULL; END;"
            );
            let _ = exec_on(state, id, stop).await;
        }
    }
    r
}

#[allow(dead_code)]
async fn run_datapump_untracked(prog: &Path, args: Vec<String>, t: &Target, job: &Job) -> Result<String, AppError> {
    use std::process::Stdio;
    // The login goes in a private parameter file (deleted on return): on Windows
    // expdp/impdp read a password from the console, never from a piped stdin.
    let par = TempFile(std::env::temp_dir().join(format!("ds-datapump-{}-{}.par", std::process::id(), rand_suffix())));
    write_private(&par.0, &oracle_parfile(&t.tool_target(), &t.password))?;
    let args = oracle_with_parfile(args, &par.0.to_string_lossy());
    let mut cmd = tokio::process::Command::new(prog);
    cmd.args(&args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    background(&mut cmd);
    bundled_lib_path(&mut cmd, prog);
    let child = cmd.spawn().map_err(|e| AppError::Driver(format!("Could not start {}: {e}", prog.display())))?;
    let out = tokio::select! {
        o = child.wait_with_output() => o.map_err(|e| AppError::Driver(format!("Data Pump failed: {e}")))?,
        _ = job.token.cancelled() => return Err(cancelled_err()),
    };
    let text = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
    if !out.status.success() {
        return Err(AppError::Driver(format!("Data Pump failed.\n\n{}", tail(&text, 4000))));
    }
    Ok(tail(&text, 4000))
}

/// Split a dump path into (server os-dir, dumpfile, logfile) for a Data Pump
/// DIRECTORY object. The directory must exist on the DB SERVER.
fn datapump_paths(p: &str) -> (String, String, String) {
    let path = Path::new(p);
    let os_dir = path
        .parent()
        .map(|d| d.to_string_lossy().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| ".".into());
    let dumpfile = path
        .file_name()
        .map(|f| f.to_string_lossy().to_string())
        .unwrap_or_else(|| "dbstudio.dmp".into());
    let logfile = format!("{dumpfile}.log");
    (os_dir, dumpfile, logfile)
}

// ---------------------------------------------------------------------------
// Cassandra (built-in)
// ---------------------------------------------------------------------------

async fn cassandra_parts(
    state: &AppState,
    t: &Target,
) -> Result<(std::sync::Arc<scylla::client::session::Session>, Option<crate::drivers::cassandra::CassKeyspaceTree>, Vec<String>), AppError> {
    let id = t.live()?.to_string();
    let ks = t.database.clone();
    state
        .registry
        .with_driver(&id, move |drv| async move {
            let g = drv.lock().await;
            let LiveConnection::Cassandra(c) = &*g else {
                return Err(QueryError::new("cassandra", "Connection is not Cassandra", ""));
            };
            if ks.is_empty() {
                return Ok((c.session(), None, Vec::new()));
            }
            let tree = c.keyspace_tree(&ks).await?;
            // ScyllaDB: the server's own DESCRIBE keeps every option the
            // reconstruction below loses — tablets on CREATE KEYSPACE, cdc on
            // tables, the CDC-log ALTER — and never lists the views that back
            // secondary indexes (SPEC-SCYLLADB.md §3.3).
            if c.is_scylla() {
                if let Some(what) = crate::drivers::cassandra::describe_target("keyspace", &ks, "") {
                    if let Ok(stmts) = c.describe(&what).await {
                        return Ok((c.session(), Some(tree), stmts));
                    }
                }
            }
            let mut ddl: Vec<String> = Vec::new();
            let types: Vec<(String, Vec<(String, String)>)> =
                tree.types.iter().map(|x| (x.name.clone(), x.fields.clone())).collect();
            for i in order_types(&types) {
                ddl.push(c.object_ddl(&ks, "type", &types[i].0).await?);
            }
            for f in tree.functions.iter().filter(|f| f.kind == "function") {
                if let Ok(d) = c.object_ddl(&ks, "function", &f.name).await {
                    ddl.push(d);
                }
            }
            for f in tree.functions.iter().filter(|f| f.kind == "aggregate") {
                if let Ok(d) = c.object_ddl(&ks, "aggregate", &f.name).await {
                    ddl.push(d);
                }
            }
            for tb in &tree.tables {
                ddl.push(c.table_ddl(&ks, &tb.name).await?);
            }
            for ix in &tree.indexes {
                if let Ok(d) = c.object_ddl(&ks, "index", &ix.name).await {
                    ddl.push(d);
                }
            }
            for v in &tree.views {
                if let Ok(d) = c.object_ddl(&ks, "view", &v.name).await {
                    ddl.push(d);
                }
            }
            Ok((c.session(), Some(tree), ddl))
        })
        .await?
        .map_err(|e| AppError::Driver(e.message))
}

async fn cassandra_dump(state: &AppState, t: &Target, dest: &str, job: &Job) -> Result<(u64, Vec<String>), AppError> {
    use scylla::statement::unprepared::Statement;
    if t.database.is_empty() {
        return Err(AppError::Driver("Choose the keyspace to back up.".into()));
    }
    let (session, tree, ddl) = Box::pin(cassandra_parts(state, t)).await?;
    let tree = tree.expect("keyspace given");
    let ks = &t.database;
    let file = tokio::fs::File::create(dest)
        .await
        .map_err(|e| AppError::Driver(format!("Cannot write {dest}: {e}")))?;
    let mut w = tokio::io::BufWriter::new(file);
    let werr = |e: std::io::Error| AppError::Driver(format!("Write failed: {e}"));
    let repl = if tree.replication.trim().is_empty() {
        "{ 'class': 'SimpleStrategy', 'replication_factor': '1' }".to_string()
    } else {
        tree.replication.clone()
    };
    // ScyllaDB's DESCRIBE already starts with the exact CREATE KEYSPACE
    // (including `tablets = {…}`), so ours would only shadow it.
    let ddl_has_keyspace = ddl
        .first()
        .is_some_and(|d| d.trim_start().to_ascii_uppercase().starts_with("CREATE KEYSPACE"));
    let create_ks = if ddl_has_keyspace {
        String::new()
    } else {
        format!("CREATE KEYSPACE IF NOT EXISTS {} WITH replication = {repl};\n\n", cql_ident(ks))
    };
    let head = format!(
        "{CQL_DUMP_HEADER}\n-- keyspace: {ks}\n-- created: {}\n\n{create_ks}",
        chrono::Utc::now().to_rfc3339(),
    );
    w.write_all(head.as_bytes()).await.map_err(werr)?;
    for d in &ddl {
        let mut s = cql_idempotent(d);
        if !s.trim_end().ends_with(';') {
            s.push(';');
        }
        w.write_all(format!("{s}\n\n").as_bytes()).await.map_err(werr)?;
    }
    let mut rows: u64 = 0;
    let mut notes = Vec::new();
    job.stage("Backing up", Some(tree.tables.len() as u64), "tables");
    for tb in &tree.tables {
        if job.cancelled() {
            return Err(cancelled_err());
        }
        job.tick(Some(format!("{ks}.{}", tb.name)));
        if let Some(base) = &tb.cdc_of {
            // ScyllaDB writes the CDC log itself when the restored rows go into the base table.
            notes.push(format!("Skipped the data of {} — ScyllaDB rebuilds the CDC log of {base} on restore.", tb.name));
            continue;
        }
        if tb.columns.iter().any(|c| c.data_type.eq_ignore_ascii_case("counter")) {
            notes.push(format!("Skipped the data of counter table {} (counters cannot be restored with INSERT).", tb.name));
            continue;
        }
        w.write_all(format!("-- data: {}\n", tb.name).as_bytes()).await.map_err(werr)?;
        let mut stmt = Statement::new(format!("SELECT JSON * FROM {}.{}", cql_ident(ks), cql_ident(&tb.name)));
        stmt.set_page_size(1000);
        let pager = session
            .query_iter(stmt, &[])
            .await
            .map_err(|e| AppError::Driver(format!("Reading {}: {e}", tb.name)))?;
        let mut stream = pager
            .rows_stream::<(String,)>()
            .map_err(|e| AppError::Driver(format!("Reading {}: {e}", tb.name)))?;
        while let Some(row) = stream.next().await {
            let (json,) = row.map_err(|e| AppError::Driver(format!("Reading {}: {e}", tb.name)))?;
            w.write_all(cql_insert_json(ks, &tb.name, &json).as_bytes()).await.map_err(werr)?;
            w.write_all(b"\n").await.map_err(werr)?;
            rows += 1;
            if rows % 2000 == 0 && job.cancelled() {
                return Err(cancelled_err());
            }
        }
        w.write_all(b"\n").await.map_err(werr)?;
    }
    job.report(true, |_| {});
    w.flush().await.map_err(werr)?;
    Ok((rows, notes))
}

async fn cassandra_restore(state: &AppState, t: &Target, src: &str, job: &Job) -> Result<u64, AppError> {
    use scylla::statement::unprepared::Statement;
    let text = tokio::fs::read_to_string(src)
        .await
        .map_err(|e| AppError::Driver(format!("Cannot read {src}: {e}")))?;
    if !text.starts_with(CQL_DUMP_HEADER) && !text.trim_start().to_ascii_uppercase().starts_with("CREATE") {
        return Err(AppError::Driver("This file is not a Database Studio Cassandra backup (or a CQL script).".into()));
    }
    let (session, _, _) = Box::pin(cassandra_parts(state, &Target { database: String::new(), ..clone_target(t) })).await?;
    let stmts = split_cql_script(&text);
    let mut n: u64 = 0;
    job.stage("Restoring", Some(stmts.len() as u64), "statements");
    for (i, s) in stmts.iter().enumerate() {
        if job.cancelled() {
            return Err(AppError::Driver(format!("Cancelled after {n} statement(s).")));
        }
        job.set_done(n, None);
        session.query_unpaged(Statement::new(s.clone()), &[]).await.map_err(|e| {
            let head: String = s.chars().take(160).collect();
            AppError::Driver(format!("Statement {} of {} failed: {e}\n\n{head}", i + 1, stmts.len()))
        })?;
        n += 1;
    }
    job.report(true, |p| p.done = n);
    // The Explorer's view of the keyspace is stale now.
    Ok(n)
}

fn clone_target(t: &Target) -> Target {
    Target {
        system: t.system.clone(),
        base_id: t.base_id.clone(),
        live_id: t.live_id.clone(),
        profile: t.profile.clone(),
        password: t.password.clone(),
        host: t.host.clone(),
        port: t.port,
        database: t.database.clone(),
    }
}

// ---------------------------------------------------------------------------
// Redis (built-in)
// ---------------------------------------------------------------------------

fn redis_db(t: &Target) -> i64 {
    // Profiles store it as "0" or "db0".
    t.database.trim().trim_start_matches("db").parse::<i64>().unwrap_or(0)
}

/// A dedicated connection on the chosen logical database — SELECT on the app's
/// shared multiplexed connection would switch the Explorer's database too.
async fn redis_conn(state: &AppState, t: &Target) -> Result<redis::aio::MultiplexedConnection, AppError> {
    let id = t.live()?;
    let mut p = state.registry.redis_params(id)?;
    p.db = redis_db(t);
    let client = crate::drivers::redis::RedisDriver::client(&p).map_err(|e| AppError::Driver(e.message))?;
    client
        .get_multiplexed_async_connection()
        .await
        .map_err(|e| AppError::Driver(format!("Redis connection failed: {e}")))
}

async fn redis_dump(state: &AppState, t: &Target, dest: &str, job: &Job) -> Result<u64, AppError> {
    let mut conn = redis_conn(state, t).await?;
    let file = tokio::fs::File::create(dest)
        .await
        .map_err(|e| AppError::Driver(format!("Cannot write {dest}: {e}")))?;
    let mut w = tokio::io::BufWriter::new(file);
    let werr = |e: std::io::Error| AppError::Driver(format!("Write failed: {e}"));
    w.write_all(redis_header_line(redis_db(t), &chrono::Utc::now().to_rfc3339()).as_bytes()).await.map_err(werr)?;
    w.write_all(b"\n").await.map_err(werr)?;
    let mut cursor: u64 = 0;
    let mut count: u64 = 0;
    let size: Option<u64> = redis::cmd("DBSIZE").query_async(&mut conn).await.ok();
    job.stage("Backing up", size, "keys");
    loop {
        if job.cancelled() {
            return Err(cancelled_err());
        }
        job.set_done(count, None);
        let (next, keys): (u64, Vec<Vec<u8>>) = redis::cmd("SCAN")
            .arg(cursor)
            .arg("COUNT")
            .arg(1000)
            .query_async(&mut conn)
            .await
            .map_err(|e| AppError::Driver(format!("SCAN failed: {e}")))?;
        if !keys.is_empty() {
            let mut pipe = redis::pipe();
            for k in &keys {
                pipe.cmd("DUMP").arg(k).cmd("PTTL").arg(k);
            }
            let replies: Vec<redis::Value> = pipe
                .query_async(&mut conn)
                .await
                .map_err(|e| AppError::Driver(format!("DUMP failed: {e}")))?;
            for (i, k) in keys.iter().enumerate() {
                let payload = match replies.get(2 * i) {
                    Some(redis::Value::BulkString(b)) => b.clone(),
                    _ => continue, // expired / deleted between SCAN and DUMP
                };
                let pttl = match replies.get(2 * i + 1) {
                    Some(redis::Value::Int(n)) => *n,
                    _ => -1,
                };
                if pttl == -2 {
                    continue;
                }
                w.write_all(redis_key_line(k, pttl, &payload).as_bytes()).await.map_err(werr)?;
                w.write_all(b"\n").await.map_err(werr)?;
                count += 1;
            }
            // name the batch's last key, so the dialog shows where it is
            if let Some(k) = keys.last() {
                job.set_done(count, Some(String::from_utf8_lossy(k).chars().take(120).collect()));
            }
        }
        cursor = next;
        if cursor == 0 {
            break;
        }
    }
    job.report(true, |p| p.done = count);
    w.flush().await.map_err(werr)?;
    Ok(count)
}

async fn redis_restore(state: &AppState, t: &Target, src: &str, replace: bool, job: &Job) -> Result<(u64, u64), AppError> {
    let mut conn = redis_conn(state, t).await?;
    let file = tokio::fs::File::open(src)
        .await
        .map_err(|e| AppError::Driver(format!("Cannot read {src}: {e}")))?;
    let size = file.metadata().await.ok().map(|m| m.len());
    let mut lines = tokio::io::BufReader::new(file).lines();
    let mut read_bytes: u64 = 0;
    job.stage("Restoring", size, "bytes");
    let mut restored: u64 = 0;
    let mut skipped: u64 = 0;
    let mut batch: Vec<RedisDumpEntry> = Vec::new();
    let mut first = true;
    loop {
        let line = lines.next_line().await.map_err(|e| AppError::Driver(format!("Read failed: {e}")))?;
        let done = line.is_none();
        if let Some(l) = &line {
            read_bytes += l.len() as u64 + 1;
            job.set_done(read_bytes, None);
        }
        if let Some(l) = line {
            if l.trim().is_empty() {
                continue;
            }
            match parse_redis_line(&l) {
                Ok(None) => {
                    first = false;
                    continue;
                }
                Ok(Some(e)) => {
                    if first {
                        return Err(AppError::Driver("This file is not a Database Studio Redis backup.".into()));
                    }
                    batch.push(e)
                }
                Err(e) => return Err(AppError::Driver(format!("Not a Database Studio Redis backup: {e}"))),
            }
        }
        if batch.len() >= 500 || (done && !batch.is_empty()) {
            if job.cancelled() {
                return Err(AppError::Driver(format!("Cancelled after {restored} key(s).")));
            }
            let todo: Vec<&RedisDumpEntry> = if replace {
                batch.iter().collect()
            } else {
                let mut pipe = redis::pipe();
                for e in &batch {
                    pipe.cmd("EXISTS").arg(&e.key);
                }
                let exists: Vec<i64> = pipe.query_async(&mut conn).await.map_err(|e| AppError::Driver(format!("EXISTS failed: {e}")))?;
                let keep: Vec<&RedisDumpEntry> = batch.iter().zip(exists).filter(|(_, x)| *x == 0).map(|(e, _)| e).collect();
                skipped += (batch.len() - keep.len()) as u64;
                keep
            };
            if !todo.is_empty() {
                let mut pipe = redis::pipe();
                for e in &todo {
                    let c = pipe.cmd("RESTORE").arg(&e.key).arg(e.ttl_ms).arg(&e.payload);
                    if replace {
                        c.arg("REPLACE");
                    }
                    c.ignore();
                }
                let _: () = pipe.query_async(&mut conn).await.map_err(|e| {
                    AppError::Driver(format!(
                        "RESTORE failed: {e}. A backup restores on the same Redis version or newer."
                    ))
                })?;
                restored += todo.len() as u64;
            }
            batch.clear();
        }
        if done {
            break;
        }
    }
    if first {
        return Err(AppError::Driver("This file is not a Database Studio Redis backup.".into()));
    }
    job.report(true, |p| p.done = read_bytes);
    Ok((restored, skipped))
}


/// MariaDB client tools look for auth plugins (caching_sha2_password for MySQL 8)
/// in a compiled-in folder; the copy shipped with Database Studio keeps them in
/// `lib/plugin` next to its `bin`.
fn with_plugin_dir(args: &mut Vec<String>, tool: &Path) {
    let Some(bin) = tool.parent() else { return };
    let dir = bin.join("..").join("lib").join("plugin");
    if dir.is_dir() {
        // must be the first option after the program for some client versions
        args.insert(0, format!("--plugin-dir={}", dir.to_string_lossy()));
    }
}

#[cfg(test)]
mod tests {
    use super::tool_messages;

    #[test]
    fn glued_parallel_messages_are_read_one_by_one() {
        let p = "pg_restore: ";
        assert_eq!(tool_messages("pg_restore: finished item 1 TABLE DATA t_1", p).len(), 1);
        let glued = "pg_restore: finished item 1 TABLE DATA t_1pg_restore: finished item 2 TABLE DATA t_2";
        assert_eq!(
            tool_messages(glued, p),
            vec!["pg_restore: finished item 1 TABLE DATA t_1", "pg_restore: finished item 2 TABLE DATA t_2"]
        );
        // a doubled prefix still yields the message exactly once
        let doubled: Vec<String> = tool_messages("pg_restore:pg_restore:  processing data for table \"public.t_9\"", p)
            .into_iter()
            .filter_map(crate::drivers::backup_tools::pg_restore_progress)
            .collect();
        assert_eq!(doubled, vec!["public.t_9"]);
        // non-ASCII text before a glued prefix is cut on a char boundary
        let v = tool_messages("Nguyễn ở đâypg_restore: finished item 3 TABLE DATA bảng", p);
        assert_eq!(v, vec!["Nguyễn ở đây", "pg_restore: finished item 3 TABLE DATA bảng"]);
        let tables: Vec<String> = tool_messages(glued, p)
            .into_iter()
            .filter_map(crate::drivers::backup_tools::pg_restore_parallel_progress)
            .collect();
        assert_eq!(tables, vec!["t_1", "t_2"]);
    }
}
