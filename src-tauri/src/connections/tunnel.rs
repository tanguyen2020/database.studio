//! SSH tunnel (local port-forward) over russh.
//!
//! `open_tunnel` connects + authenticates (password or private-key file — the
//! key is read from its path at use time, never copied into app storage),
//! binds a local port (dynamic) and forwards each accepted socket through a
//! direct-tcpip channel to the target host:port.
//!
//! `rewrite_kafka_metadata`: Kafka is special. librdkafka bootstraps over the
//! tunnel, reads the broker's `advertised.listeners` from the Metadata response,
//! then reconnects to THAT address directly (bypassing the tunnel). Docker
//! brokers advertise an internal hostname / the host's public IP that isn't
//! reachable from this machine, so the reconnect times out. When this flag is
//! set the forwarder becomes a Kafka-protocol-aware proxy: it rewrites every
//! broker address in Metadata responses to `127.0.0.1:<local tunnel port>`, so
//! librdkafka's reconnects loop back through this same tunnel. This makes Kafka
//! work over SSH with NO server-side `advertised.listeners` change.
//! LIMITATION: rewrites all brokers to the one tunnel → correct for a
//! single-broker cluster (all metadata brokers are the same node); a multi-broker
//! cluster would need one tunnel per broker.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use russh::client::{self, Handle};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use crate::connections::profile::{SshAuthMethod, SshConfig};
use crate::error::{AppError, AppResult};

/// Kafka Metadata API key.
const API_KEY_METADATA: i16 = 3;
/// Kafka FindCoordinator API key — its response carries the group/txn coordinator's
/// host:port, which must also be rewritten to loop back through the tunnel (else
/// librdkafka dials the broker's real advertised address directly and stalls).
const API_KEY_FIND_COORDINATOR: i16 = 10;
/// Guard against absurd frame sizes (protocol desync / non-Kafka traffic).
const MAX_FRAME: usize = 100 * 1024 * 1024;

/// Per-proxy-connection label for trace logs.
static PROXY_CONN_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Human name for the Kafka request API keys we care about while tracing.
fn api_key_name(k: i16) -> &'static str {
    match k {
        0 => "Produce",
        1 => "Fetch",
        2 => "ListOffsets",
        3 => "Metadata",
        8 => "OffsetCommit",
        9 => "OffsetFetch",
        10 => "FindCoordinator",
        18 => "ApiVersions",
        _ => "?",
    }
}

struct AcceptAllHandler;

impl client::Handler for AcceptAllHandler {
    type Error = russh::Error;

    // Personal client: accept the host key (known_hosts verification is a
    // later-phase nicety; key material is still never persisted).
    async fn check_server_key(
        &mut self,
        _server_public_key: &russh::keys::ssh_key::PublicKey,
    ) -> Result<bool, Self::Error> {
        Ok(true)
    }
}

pub struct TunnelHandle {
    pub local_port: u16,
    session: Arc<Handle<AcceptAllHandler>>,
    accept_task: tokio::task::JoinHandle<()>,
}

impl TunnelHandle {
    pub async fn shutdown(self) {
        self.accept_task.abort();
        let _ = self
            .session
            .disconnect(russh::Disconnect::ByApplication, "closing tunnel", "en")
            .await;
    }
}

pub async fn open_tunnel(
    ssh: &SshConfig,
    ssh_password: &str,
    target_host: &str,
    target_port: u16,
    rewrite_kafka_metadata: bool,
) -> AppResult<TunnelHandle> {
    let config = Arc::new(client::Config::default());
    let addr = (ssh.host.as_str(), if ssh.port == 0 { 22 } else { ssh.port });
    let mut session = client::connect(config, addr, AcceptAllHandler)
        .await
        .map_err(|e| AppError::Tunnel(format!("SSH connect to {}:{} failed: {e}", ssh.host, addr.1)))?;

    let authenticated = match ssh.auth {
        SshAuthMethod::Password => session
            .authenticate_password(&ssh.user, ssh_password)
            .await
            .map_err(|e| AppError::Tunnel(format!("SSH auth error: {e}")))?,
        SshAuthMethod::Key => {
            let key = russh::keys::load_secret_key(&ssh.key_path, None)
                .map_err(|e| AppError::Tunnel(format!("Failed to read private key '{}': {e}", ssh.key_path)))?;
            let hash_alg = session
                .best_supported_rsa_hash()
                .await
                .map_err(|e| AppError::Tunnel(format!("SSH negotiation error: {e}")))?
                .flatten();
            session
                .authenticate_publickey(
                    &ssh.user,
                    russh::keys::PrivateKeyWithHashAlg::new(Arc::new(key), hash_alg),
                )
                .await
                .map_err(|e| AppError::Tunnel(format!("SSH auth error: {e}")))?
        }
    };
    if !authenticated.success() {
        return Err(AppError::Tunnel(
            "SSH authentication rejected (wrong user/password/key)".into(),
        ));
    }

    let session = Arc::new(session);
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|e| AppError::Tunnel(format!("Failed to bind local port: {e}")))?;
    let local_port = listener
        .local_addr()
        .map_err(|e| AppError::Tunnel(e.to_string()))?
        .port();

    let fwd_session = Arc::clone(&session);
    let target_host = target_host.to_string();
    let accept_task = tokio::spawn(async move {
        loop {
            let Ok((mut socket, peer)) = listener.accept().await else {
                break;
            };
            let session = Arc::clone(&fwd_session);
            let target_host = target_host.clone();
            tokio::spawn(async move {
                match session
                    .channel_open_direct_tcpip(
                        target_host,
                        target_port as u32,
                        peer.ip().to_string(),
                        peer.port() as u32,
                    )
                    .await
                {
                    Ok(channel) => {
                        let mut stream = channel.into_stream();
                        if rewrite_kafka_metadata {
                            // Kafka-aware forwarding: rewrite advertised broker
                            // addresses so reconnects loop back through us.
                            proxy_kafka(socket, stream, local_port).await;
                        } else {
                            let _ = tokio::io::copy_bidirectional(&mut socket, &mut stream).await;
                        }
                    }
                    Err(e) => {
                        eprintln!("tunnel channel error: {e}");
                    }
                }
            });
        }
    });

    Ok(TunnelHandle { local_port, session, accept_task })
}

// ---------------------------------------------------------------------------
// Kafka-aware proxy: rewrite advertised broker addresses in Metadata responses
// ---------------------------------------------------------------------------

/// Forward a single client<->broker connection while rewriting Kafka Metadata
/// responses. Requests are inspected only to learn each correlation id's
/// (api_key, api_version) so the matching response can be parsed correctly.
async fn proxy_kafka<S>(client: tokio::net::TcpStream, upstream: S, local_port: u16)
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Send + 'static,
{
    let trace = std::env::var("DBSTUDIO_KAFKA_TRACE").is_ok();
    let cid = PROXY_CONN_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    if trace {
        eprintln!("kafka-proxy[{cid}]: connection opened (tunnel local port {local_port})");
    }

    let (mut client_rd, mut client_wr) = client.into_split();
    let (mut up_rd, mut up_wr) = tokio::io::split(upstream);
    // correlation_id -> (api_key, api_version), shared between the two directions.
    let pending: Arc<Mutex<HashMap<i32, (i16, i16)>>> = Arc::new(Mutex::new(HashMap::new()));

    let req_map = Arc::clone(&pending);
    let requests = async move {
        while let Some(frame) = read_frame(&mut client_rd).await {
            if frame.len() >= 8 {
                let api_key = i16::from_be_bytes([frame[0], frame[1]]);
                let api_version = i16::from_be_bytes([frame[2], frame[3]]);
                let corr = i32::from_be_bytes([frame[4], frame[5], frame[6], frame[7]]);
                if trace {
                    eprintln!(
                        "kafka-proxy[{cid}] -> {} (api_key={api_key} v={api_version} corr={corr}, {} bytes)",
                        api_key_name(api_key),
                        frame.len()
                    );
                }
                req_map.lock().unwrap().insert(corr, (api_key, api_version));
            }
            if write_frame(&mut up_wr, &frame).await.is_err() {
                break;
            }
        }
        if trace {
            eprintln!("kafka-proxy[{cid}]: client closed (request stream ended)");
        }
    };

    let resp_map = Arc::clone(&pending);
    let responses = async move {
        while let Some(mut frame) = read_frame(&mut up_rd).await {
            if frame.len() >= 4 {
                let corr = i32::from_be_bytes([frame[0], frame[1], frame[2], frame[3]]);
                let meta = resp_map.lock().unwrap().remove(&corr);
                match meta {
                    Some((API_KEY_METADATA, api_version)) => {
                        match rewrite_metadata_response(&frame, api_version, "127.0.0.1", local_port as i32) {
                            Some(rw) => {
                                if trace {
                                    eprintln!("kafka-proxy[{cid}] <- Metadata corr={corr}: rewrote broker address(es) -> 127.0.0.1:{local_port}");
                                }
                                frame = rw;
                            }
                            None if trace => eprintln!(
                                "kafka-proxy[{cid}] <- Metadata corr={corr} v={api_version}: REWRITE FAILED (parse) — forwarding unchanged"
                            ),
                            None => {}
                        }
                    }
                    Some((API_KEY_FIND_COORDINATOR, api_version)) => {
                        match rewrite_findcoordinator_response(&frame, api_version, "127.0.0.1", local_port as i32) {
                            Some(rw) => {
                                if trace {
                                    eprintln!("kafka-proxy[{cid}] <- FindCoordinator corr={corr}: rewrote coordinator address -> 127.0.0.1:{local_port}");
                                }
                                frame = rw;
                            }
                            None if trace => eprintln!(
                                "kafka-proxy[{cid}] <- FindCoordinator corr={corr} v={api_version}: REWRITE FAILED (parse) — forwarding unchanged"
                            ),
                            None => {}
                        }
                    }
                    Some((api_key, _)) if trace => eprintln!(
                        "kafka-proxy[{cid}] <- {} corr={corr} ({} bytes)",
                        api_key_name(api_key),
                        frame.len()
                    ),
                    _ => {}
                }
            }
            if write_frame(&mut client_wr, &frame).await.is_err() {
                break;
            }
        }
        if trace {
            eprintln!("kafka-proxy[{cid}]: upstream closed (response stream ended)");
        }
    };

    tokio::join!(requests, responses);
}

/// Read one length-delimited Kafka frame (the 4-byte big-endian size prefix
/// followed by `size` bytes). Returns the payload without the length prefix, or
/// `None` on clean EOF / protocol desync.
async fn read_frame<R>(r: &mut R) -> Option<Vec<u8>>
where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut len_buf = [0u8; 4];
    r.read_exact(&mut len_buf).await.ok()?;
    let len = u32::from_be_bytes(len_buf) as usize;
    if len == 0 || len > MAX_FRAME {
        return None;
    }
    let mut buf = vec![0u8; len];
    r.read_exact(&mut buf).await.ok()?;
    Some(buf)
}

/// Write a payload back as a length-delimited frame.
async fn write_frame<W>(w: &mut W, payload: &[u8]) -> std::io::Result<()>
where
    W: tokio::io::AsyncWrite + Unpin,
{
    w.write_all(&(payload.len() as u32).to_be_bytes()).await?;
    w.write_all(payload).await?;
    w.flush().await
}

// --- LEB128 unsigned varint (used by Kafka "flexible" protocol versions) -----

fn read_uvarint(buf: &[u8], i: &mut usize) -> Option<u64> {
    let mut val: u64 = 0;
    let mut shift = 0;
    loop {
        let b = *buf.get(*i)?;
        *i += 1;
        val |= ((b & 0x7f) as u64) << shift;
        if b & 0x80 == 0 {
            return Some(val);
        }
        shift += 7;
        if shift >= 64 {
            return None;
        }
    }
}

fn write_uvarint(out: &mut Vec<u8>, mut v: u64) {
    loop {
        let mut b = (v & 0x7f) as u8;
        v >>= 7;
        if v != 0 {
            b |= 0x80;
        }
        out.push(b);
        if v == 0 {
            break;
        }
    }
}

fn read_i16(buf: &[u8], i: &mut usize) -> Option<i16> {
    let v = i16::from_be_bytes([*buf.get(*i)?, *buf.get(*i + 1)?]);
    *i += 2;
    Some(v)
}

fn read_i32(buf: &[u8], i: &mut usize) -> Option<i32> {
    let v = i32::from_be_bytes([
        *buf.get(*i)?,
        *buf.get(*i + 1)?,
        *buf.get(*i + 2)?,
        *buf.get(*i + 3)?,
    ]);
    *i += 4;
    Some(v)
}

/// Advance past an (empty or not) flexible tagged-fields buffer, returning the
/// range consumed so the caller can copy it verbatim.
fn skip_tagged_fields(buf: &[u8], i: &mut usize) -> Option<()> {
    let count = read_uvarint(buf, i)?;
    for _ in 0..count {
        let _tag = read_uvarint(buf, i)?;
        let size = read_uvarint(buf, i)? as usize;
        *i += size;
        if *i > buf.len() {
            return None;
        }
    }
    Some(())
}

/// Rewrite every broker's advertised host/port in a Metadata response to
/// `new_host:new_port`. `payload` is the response frame WITHOUT the length
/// prefix (starts at the correlation id). Returns the rewritten payload, or
/// `None` if parsing failed (in which case the original is forwarded untouched).
///
/// Layout parsed (per the Kafka protocol): correlation id, [header tagged
/// fields if flexible], [throttle_time_ms for v3+], then the brokers array —
/// each broker = node_id, host, port, [rack for v1+], [tagged fields if
/// flexible]. Everything after the brokers array is copied verbatim; the wire
/// format is sequential so no later offsets need fixing. Flexible encoding
/// (compact strings / arrays + tagged fields) applies from Metadata v9.
fn rewrite_metadata_response(
    payload: &[u8],
    api_version: i16,
    new_host: &str,
    new_port: i32,
) -> Option<Vec<u8>> {
    let flexible = api_version >= 9;
    let mut i = 4usize; // skip correlation id
    if flexible {
        skip_tagged_fields(payload, &mut i)?;
    }
    if api_version >= 3 {
        i += 4; // throttle_time_ms
    }
    // Broker array length (compact = uvarint(n+1) when flexible).
    let count = if flexible {
        let c = read_uvarint(payload, &mut i)?;
        if c == 0 {
            return None; // null array — nothing to do
        }
        (c - 1) as i64
    } else {
        read_i32(payload, &mut i)? as i64
    };
    if count < 0 || count > 100_000 {
        return None;
    }

    // Header + array-length prefix are copied verbatim.
    let mut out = payload[..i].to_vec();

    for _ in 0..count {
        // node_id
        out.extend_from_slice(payload.get(i..i + 4)?);
        i += 4;
        // host (rewritten)
        let host_len = if flexible {
            (read_uvarint(payload, &mut i)? as usize).checked_sub(1)?
        } else {
            read_i16(payload, &mut i)? as usize
        };
        i += host_len; // skip original host bytes
        if i > payload.len() {
            return None;
        }
        if flexible {
            write_uvarint(&mut out, new_host.len() as u64 + 1);
        } else {
            out.extend_from_slice(&(new_host.len() as i16).to_be_bytes());
        }
        out.extend_from_slice(new_host.as_bytes());
        // port (rewritten)
        i += 4; // skip original port
        out.extend_from_slice(&new_port.to_be_bytes());
        // rack (v1+): copied verbatim
        if api_version >= 1 {
            let rack_start = i;
            if flexible {
                let rl = read_uvarint(payload, &mut i)?;
                if rl > 0 {
                    i += (rl - 1) as usize;
                }
            } else {
                let rl = read_i16(payload, &mut i)?;
                if rl >= 0 {
                    i += rl as usize;
                }
            }
            out.extend_from_slice(payload.get(rack_start..i)?);
        }
        // per-broker tagged fields (flexible): copied verbatim
        if flexible {
            let tf_start = i;
            skip_tagged_fields(payload, &mut i)?;
            out.extend_from_slice(payload.get(tf_start..i)?);
        }
    }

    // Everything after the brokers array (cluster_id, controller_id, topics, …).
    out.extend_from_slice(payload.get(i..)?);
    Some(out)
}

// --- string / tagged-field helpers for FindCoordinator rewriting ------------

/// Copy a (compact|classic) [nullable] string verbatim from `payload` into `out`,
/// advancing `i`. Handles null (classic len -1 / compact len 0) and empty.
fn copy_str(payload: &[u8], i: &mut usize, out: &mut Vec<u8>, compact: bool) -> Option<()> {
    let start = *i;
    if compact {
        let l = read_uvarint(payload, i)?;
        if l > 1 {
            *i += (l - 1) as usize;
        }
    } else {
        let l = read_i16(payload, i)?;
        if l > 0 {
            *i += l as usize;
        }
    }
    out.extend_from_slice(payload.get(start..*i)?);
    Some(())
}

/// Skip the original (compact|classic) string in `payload`, writing `new` (non-null)
/// into `out` in the same encoding. Advances `i` past the original.
fn put_str(payload: &[u8], i: &mut usize, out: &mut Vec<u8>, compact: bool, new: &str) -> Option<()> {
    if compact {
        let l = read_uvarint(payload, i)?;
        if l > 1 {
            *i += (l - 1) as usize;
        }
        write_uvarint(out, new.len() as u64 + 1);
    } else {
        let l = read_i16(payload, i)?;
        if l > 0 {
            *i += l as usize;
        }
        out.extend_from_slice(&(new.len() as i16).to_be_bytes());
    }
    out.extend_from_slice(new.as_bytes());
    Some(())
}

/// Copy `n` bytes verbatim from `payload` into `out`, advancing `i`.
fn copy_n(payload: &[u8], i: &mut usize, out: &mut Vec<u8>, n: usize) -> Option<()> {
    out.extend_from_slice(payload.get(*i..*i + n)?);
    *i += n;
    Some(())
}

/// Copy a flexible tagged-fields buffer verbatim.
fn copy_tagged(payload: &[u8], i: &mut usize, out: &mut Vec<u8>) -> Option<()> {
    let s = *i;
    skip_tagged_fields(payload, i)?;
    out.extend_from_slice(payload.get(s..*i)?);
    Some(())
}

/// Rewrite the coordinator host:port in a FindCoordinator response so it points at
/// the tunnel (`new_host:new_port`). Layout per version:
///  - v0: error_code, node_id, host, port
///  - v1/v2: throttle_time_ms, error_code, error_message, node_id, host, port
///  - v3: as v2 but flexible (compact strings + tagged fields) with a v1 response header
///  - v4: throttle_time_ms, coordinators[] { key, node_id, host, port, error_code,
///        error_message, tagged }, tagged — flexible.
/// Non-host/port fields are copied verbatim; only host+port are substituted.
fn rewrite_findcoordinator_response(
    payload: &[u8],
    api_version: i16,
    new_host: &str,
    new_port: i32,
) -> Option<Vec<u8>> {
    let flexible = api_version >= 3;
    let mut i = 4usize; // correlation id
    if flexible {
        skip_tagged_fields(payload, &mut i)?; // response header v1 tagged fields
    }
    let mut out = payload[..i].to_vec();

    if api_version >= 1 {
        copy_n(payload, &mut i, &mut out, 4)?; // throttle_time_ms
    }

    if api_version >= 4 {
        // coordinators array (compact when flexible, which v4 always is)
        let n = read_uvarint(payload, &mut i)?;
        write_uvarint(&mut out, n);
        let count = if n == 0 { 0 } else { (n - 1) as usize };
        for _ in 0..count {
            copy_str(payload, &mut i, &mut out, true)?; // key
            copy_n(payload, &mut i, &mut out, 4)?; // node_id
            put_str(payload, &mut i, &mut out, true, new_host)?; // host → tunnel
            i += 4;
            out.extend_from_slice(&new_port.to_be_bytes()); // port → tunnel
            copy_n(payload, &mut i, &mut out, 2)?; // error_code
            copy_str(payload, &mut i, &mut out, true)?; // error_message (nullable)
            copy_tagged(payload, &mut i, &mut out)?; // per-coordinator tagged fields
        }
        copy_tagged(payload, &mut i, &mut out)?; // top-level tagged fields
    } else {
        // single coordinator
        copy_n(payload, &mut i, &mut out, 2)?; // error_code
        if api_version >= 1 {
            copy_str(payload, &mut i, &mut out, flexible)?; // error_message (nullable)
        }
        copy_n(payload, &mut i, &mut out, 4)?; // node_id
        put_str(payload, &mut i, &mut out, flexible, new_host)?; // host → tunnel
        i += 4;
        out.extend_from_slice(&new_port.to_be_bytes()); // port → tunnel
        if flexible {
            copy_tagged(payload, &mut i, &mut out)?; // v3 tagged fields
        }
    }
    // Copy any trailing bytes (defensive; normally none).
    out.extend_from_slice(payload.get(i..)?);
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Parse the brokers out of a rewritten payload to assert the rewrite worked,
    // mirroring rewrite_metadata_response's layout walk.
    fn read_brokers(payload: &[u8], api_version: i16) -> Vec<(String, i32)> {
        let flexible = api_version >= 9;
        let mut i = 4usize;
        if flexible {
            skip_tagged_fields(payload, &mut i).unwrap();
        }
        if api_version >= 3 {
            i += 4;
        }
        let count = if flexible {
            (read_uvarint(payload, &mut i).unwrap() - 1) as i64
        } else {
            read_i32(payload, &mut i).unwrap() as i64
        };
        let mut brokers = Vec::new();
        for _ in 0..count {
            i += 4; // node_id
            let host_len = if flexible {
                read_uvarint(payload, &mut i).unwrap() as usize - 1
            } else {
                read_i16(payload, &mut i).unwrap() as usize
            };
            let host = String::from_utf8(payload[i..i + host_len].to_vec()).unwrap();
            i += host_len;
            let port = read_i32(payload, &mut i).unwrap();
            if api_version >= 1 {
                if flexible {
                    let rl = read_uvarint(payload, &mut i).unwrap();
                    if rl > 0 {
                        i += (rl - 1) as usize;
                    }
                } else {
                    let rl = read_i16(payload, &mut i).unwrap();
                    if rl >= 0 {
                        i += rl as usize;
                    }
                }
            }
            if flexible {
                skip_tagged_fields(payload, &mut i).unwrap();
            }
            brokers.push((host, port));
        }
        brokers
    }

    #[test]
    fn varint_roundtrip() {
        for v in [0u64, 1, 127, 128, 300, 16384, 1_000_000] {
            let mut out = Vec::new();
            write_uvarint(&mut out, v);
            let mut i = 0;
            assert_eq!(read_uvarint(&out, &mut i), Some(v));
            assert_eq!(i, out.len());
        }
    }

    #[test]
    fn rewrite_non_flexible_v1() {
        // Metadata response v1 (not flexible): corr id, brokers[1], then a tail.
        let mut p = Vec::new();
        p.extend_from_slice(&7i32.to_be_bytes()); // correlation id
        p.extend_from_slice(&1i32.to_be_bytes()); // broker count = 1
        p.extend_from_slice(&0i32.to_be_bytes()); // node_id
        p.extend_from_slice(&10i16.to_be_bytes()); // host len
        p.extend_from_slice(b"10.16.71.3"); // host
        p.extend_from_slice(&9092i32.to_be_bytes()); // port
        p.extend_from_slice(&(-1i16).to_be_bytes()); // rack = null (v1+)
        p.extend_from_slice(&[0xAB, 0xCD]); // opaque tail (controller/topics/…)

        let out = rewrite_metadata_response(&p, 1, "127.0.0.1", 54321).unwrap();
        assert_eq!(read_brokers(&out, 1), vec![("127.0.0.1".to_string(), 54321)]);
        // Tail must be preserved verbatim.
        assert_eq!(&out[out.len() - 2..], &[0xAB, 0xCD]);
    }

    #[test]
    fn rewrite_flexible_v12() {
        // Metadata response v12 (flexible): corr id + header tagged fields,
        // throttle, compact brokers[1] with rack=null + tagged fields, tail.
        let mut p = Vec::new();
        p.extend_from_slice(&9i32.to_be_bytes()); // correlation id
        p.push(0x00); // header tagged fields = 0
        p.extend_from_slice(&0i32.to_be_bytes()); // throttle_time_ms (v3+)
        write_uvarint(&mut p, 2); // compact broker count = n+1 = 2 → 1 broker
        p.extend_from_slice(&1i32.to_be_bytes()); // node_id
        write_uvarint(&mut p, 11); // compact host len = 10+1
        p.extend_from_slice(b"10.16.71.3"); // host
        p.extend_from_slice(&9092i32.to_be_bytes()); // port
        write_uvarint(&mut p, 0); // rack = null (compact nullable)
        p.push(0x00); // per-broker tagged fields = 0
        p.push(0xAA); // opaque tail

        let out = rewrite_metadata_response(&p, 12, "127.0.0.1", 40000).unwrap();
        assert_eq!(read_brokers(&out, 12), vec![("127.0.0.1".to_string(), 40000)]);
        assert_eq!(out[out.len() - 1], 0xAA);
    }

    #[test]
    fn rewrite_preserves_multiple_brokers() {
        // Two brokers, non-flexible v1 → both rewritten to the single tunnel.
        let mut p = Vec::new();
        p.extend_from_slice(&3i32.to_be_bytes());
        p.extend_from_slice(&2i32.to_be_bytes()); // count = 2
        for (id, host, port) in [(0i32, "kafka", 9092i32), (1, "kafka-local", 19092)] {
            p.extend_from_slice(&id.to_be_bytes());
            p.extend_from_slice(&(host.len() as i16).to_be_bytes());
            p.extend_from_slice(host.as_bytes());
            p.extend_from_slice(&port.to_be_bytes());
            p.extend_from_slice(&(-1i16).to_be_bytes()); // rack null
        }
        p.push(0x99); // tail

        let out = rewrite_metadata_response(&p, 1, "127.0.0.1", 5000).unwrap();
        assert_eq!(
            read_brokers(&out, 1),
            vec![
                ("127.0.0.1".to_string(), 5000),
                ("127.0.0.1".to_string(), 5000)
            ]
        );
        assert_eq!(out[out.len() - 1], 0x99);
    }

    // --- FindCoordinator rewrite (the bug: coordinator address wasn't rewritten) ---

    fn has(hay: &[u8], needle: &[u8]) -> bool {
        hay.windows(needle.len()).any(|w| w == needle)
    }
    fn cstr(out: &mut Vec<u8>, s: &str) {
        write_uvarint(out, s.len() as u64 + 1);
        out.extend_from_slice(s.as_bytes());
    }

    #[test]
    fn findcoordinator_v2_rewrites_coordinator_addr() {
        // corr, throttle, error_code, error_message(null=-1), node_id, host, port
        let mut p = Vec::new();
        p.extend_from_slice(&99i32.to_be_bytes()); // corr
        p.extend_from_slice(&0i32.to_be_bytes()); // throttle
        p.extend_from_slice(&0i16.to_be_bytes()); // error_code
        p.extend_from_slice(&(-1i16).to_be_bytes()); // error_message = null
        p.extend_from_slice(&1i32.to_be_bytes()); // node_id
        p.extend_from_slice(&("10.16.71.3".len() as i16).to_be_bytes());
        p.extend_from_slice(b"10.16.71.3"); // host
        p.extend_from_slice(&9092i32.to_be_bytes()); // port

        let out = rewrite_findcoordinator_response(&p, 2, "127.0.0.1", 64045).expect("rewrite v2");
        // node_id preserved (bytes 12..16), host + port substituted
        assert_eq!(&out[12..16], &1i32.to_be_bytes());
        let hl = i16::from_be_bytes([out[16], out[17]]) as usize;
        assert_eq!(&out[18..18 + hl], b"127.0.0.1");
        let port = i32::from_be_bytes([out[18 + hl], out[19 + hl], out[20 + hl], out[21 + hl]]);
        assert_eq!(port, 64045);
        assert!(!has(&out, b"10.16.71.3"), "old coordinator host must be gone");
    }

    #[test]
    fn findcoordinator_v3_flexible_rewrites() {
        // v3: header tagged, throttle, error_code, error_message(compact null=0),
        // node_id, host(compact), port, tagged
        let mut p = Vec::new();
        p.extend_from_slice(&7i32.to_be_bytes()); // corr
        p.push(0x00); // response header tagged fields (empty)
        p.extend_from_slice(&0i32.to_be_bytes()); // throttle
        p.extend_from_slice(&0i16.to_be_bytes()); // error_code
        p.push(0x00); // error_message = compact null
        p.extend_from_slice(&1i32.to_be_bytes()); // node_id
        cstr(&mut p, "kafka"); // host (compact)
        p.extend_from_slice(&9092i32.to_be_bytes()); // port
        p.push(0x00); // tagged fields

        let out = rewrite_findcoordinator_response(&p, 3, "127.0.0.1", 64045).expect("rewrite v3");
        assert!(has(&out, b"127.0.0.1") && !has(&out, b"kafka"), "coordinator host rewritten");
        assert!(has(&out, &64045i32.to_be_bytes()), "coordinator port rewritten");
    }

    #[test]
    fn findcoordinator_v4_batched_rewrites_each() {
        // v4: header tagged, throttle, coordinators[compact array], top tagged
        let mut p = Vec::new();
        p.extend_from_slice(&5i32.to_be_bytes()); // corr
        p.push(0x00); // header tagged
        p.extend_from_slice(&0i32.to_be_bytes()); // throttle
        write_uvarint(&mut p, 2); // 1 coordinator (compact count = n+1)
        cstr(&mut p, "mygroup"); // key
        p.extend_from_slice(&1i32.to_be_bytes()); // node_id
        cstr(&mut p, "10.16.71.3"); // host
        p.extend_from_slice(&9092i32.to_be_bytes()); // port
        p.extend_from_slice(&0i16.to_be_bytes()); // error_code
        p.push(0x00); // error_message compact null
        p.push(0x00); // per-coord tagged
        p.push(0x00); // top-level tagged

        let out = rewrite_findcoordinator_response(&p, 4, "127.0.0.1", 64045).expect("rewrite v4");
        assert!(has(&out, b"mygroup"), "coordinator key preserved");
        assert!(has(&out, b"127.0.0.1") && !has(&out, b"10.16.71.3"), "coordinator host rewritten");
        assert!(has(&out, &64045i32.to_be_bytes()), "coordinator port rewritten");
    }
}
