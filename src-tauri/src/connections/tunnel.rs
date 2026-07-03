//! SSH tunnel (local port-forward) over russh.
//!
//! `open_tunnel` connects + authenticates (password or private-key file — the
//! key is read from its path at use time, never copied into app storage),
//! binds 127.0.0.1:0 and forwards each accepted socket through a
//! direct-tcpip channel to the target host:port.

use std::sync::Arc;

use russh::client::{self, Handle};
use tokio::net::TcpListener;

use crate::connections::profile::{SshAuthMethod, SshConfig};
use crate::error::{AppError, AppResult};

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
) -> AppResult<TunnelHandle> {
    let config = Arc::new(client::Config::default());
    let addr = (ssh.host.as_str(), if ssh.port == 0 { 22 } else { ssh.port });
    let mut session = client::connect(config, addr, AcceptAllHandler)
        .await
        .map_err(|e| AppError::Tunnel(format!("SSH connect {}:{} thất bại: {e}", ssh.host, addr.1)))?;

    let authenticated = match ssh.auth {
        SshAuthMethod::Password => session
            .authenticate_password(&ssh.user, ssh_password)
            .await
            .map_err(|e| AppError::Tunnel(format!("SSH auth lỗi: {e}")))?,
        SshAuthMethod::Key => {
            let key = russh::keys::load_secret_key(&ssh.key_path, None)
                .map_err(|e| AppError::Tunnel(format!("Không đọc được private key '{}': {e}", ssh.key_path)))?;
            let hash_alg = session
                .best_supported_rsa_hash()
                .await
                .map_err(|e| AppError::Tunnel(format!("SSH negotiation lỗi: {e}")))?
                .flatten();
            session
                .authenticate_publickey(
                    &ssh.user,
                    russh::keys::PrivateKeyWithHashAlg::new(Arc::new(key), hash_alg),
                )
                .await
                .map_err(|e| AppError::Tunnel(format!("SSH auth lỗi: {e}")))?
        }
    };
    if !authenticated.success() {
        return Err(AppError::Tunnel(
            "SSH authentication bị từ chối (sai user/mật khẩu/key)".into(),
        ));
    }

    let session = Arc::new(session);
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|e| AppError::Tunnel(format!("Không bind được cổng local: {e}")))?;
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
                        let _ = tokio::io::copy_bidirectional(&mut socket, &mut stream).await;
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
