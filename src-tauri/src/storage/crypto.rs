//! Password encryption: AES-256-GCM with a per-machine master key.
//!
//! The key is kept in the OS keychain (Windows Credential Manager / macOS
//! Keychain / Linux Secret Service via the `keyring` crate) AND mirrored to a
//! 0600 key-file next to `studio.db`. Both always hold the SAME key.
//!
//! Why the file mirror: an **unsigned / ad-hoc-signed** macOS build changes its
//! code identity on every rebuild, so the Keychain ACL stops trusting it →
//! reads prompt or fail with `errSecInteractionNotAllowed`. Without a durable
//! fallback that means "master key lost" → every launch derives a fresh key →
//! AES-GCM decrypt of stored passwords fails with `aead::Error`. The file
//! fallback makes persistence deterministic regardless of code signing.
//!
//! Resolution order (read): Keychain (authoritative when reachable) → file.
//! The Keychain never self-generates a key; only the "nothing anywhere" path
//! generates, and it writes BOTH stores — so the two can never diverge.
//!
//! Stored password format: base64( nonce(12) || ciphertext ). Profiles only
//! ever hold ciphertext.

use std::path::PathBuf;
use std::sync::OnceLock;

use aes_gcm::aead::{Aead, KeyInit, OsRng};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use rand::RngCore;

use crate::error::{AppError, AppResult};

const SERVICE: &str = "database-studio";
const ACCOUNT: &str = "master-key";
const NONCE_LEN: usize = 12;
const KEY_FILE: &str = "master.key";

/// Directory holding the file-based master-key fallback (same dir as
/// `studio.db`). Registered once at startup from `lib.rs`.
static KEY_DIR: OnceLock<PathBuf> = OnceLock::new();

/// Register the fallback key-file directory. Call once, before any
/// encrypt/decrypt, with the same path used for `Storage::open`.
pub fn set_key_dir(dir: PathBuf) {
    let _ = KEY_DIR.set(dir);
}

fn key_file_path() -> Option<PathBuf> {
    KEY_DIR.get().map(|d| d.join(KEY_FILE))
}

fn decode_key(b64: &str) -> AppResult<[u8; 32]> {
    let bytes = B64
        .decode(b64.trim())
        .map_err(|e| AppError::Keychain(format!("corrupt master key: {e}")))?;
    bytes
        .try_into()
        .map_err(|_| AppError::Keychain("master key has wrong length".into()))
}

/// Read the key from the OS keychain.
/// `Ok(Some)` = found, `Ok(None)` = keychain reachable but empty (NoEntry),
/// `Err` = keychain unreachable/denied (unsigned app, no backend, locked, …).
fn read_keychain() -> AppResult<Option<[u8; 32]>> {
    let entry = keyring::Entry::new(SERVICE, ACCOUNT)
        .map_err(|e| AppError::Keychain(e.to_string()))?;
    match entry.get_password() {
        Ok(b64) => Ok(Some(decode_key(&b64)?)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(AppError::Keychain(e.to_string())),
    }
}

fn write_keychain(key: &[u8; 32]) -> AppResult<()> {
    let entry = keyring::Entry::new(SERVICE, ACCOUNT)
        .map_err(|e| AppError::Keychain(e.to_string()))?;
    entry
        .set_password(&B64.encode(key))
        .map_err(|e| AppError::Keychain(e.to_string()))
}

fn read_key_file() -> Option<[u8; 32]> {
    let path = key_file_path()?;
    let b64 = std::fs::read_to_string(&path).ok()?;
    decode_key(&b64).ok()
}

fn write_key_file(key: &[u8; 32]) -> AppResult<()> {
    let path = key_file_path()
        .ok_or_else(|| AppError::Keychain("key-file dir not registered".into()))?;
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    std::fs::write(&path, B64.encode(key))
        .map_err(|e| AppError::Keychain(format!("cannot write key file: {e}")))?;
    // Lock down to owner-only on unix (0600). No-op elsewhere.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

fn get_or_create_master_key() -> AppResult<[u8; 32]> {
    let kc = read_keychain();
    let file = read_key_file();

    // 1. Keychain is authoritative when it has a key. Mirror to file so a later
    //    denied/unavailable keychain read (e.g. after an unsigned rebuild) still
    //    finds the SAME key.
    if let Ok(Some(key)) = kc {
        if file != Some(key) {
            let _ = write_key_file(&key);
        }
        return Ok(key);
    }

    // 2. Keychain empty or unreachable, but the file has our key → use it.
    //    If the keychain is merely empty (reachable), backfill it.
    if let Some(key) = file {
        if matches!(kc, Ok(None)) {
            let _ = write_keychain(&key);
        }
        return Ok(key);
    }

    // 3. Nothing anywhere → generate once and persist to both stores.
    let mut key = [0u8; 32];
    OsRng.fill_bytes(&mut key);
    let kc_ok = write_keychain(&key).is_ok();
    let file_ok = write_key_file(&key).is_ok();
    if !kc_ok && !file_ok {
        return Err(AppError::Keychain(
            "no writable key store (keychain unavailable and no key-file dir)".into(),
        ));
    }
    Ok(key)
}

pub fn encrypt(plaintext: &str) -> AppResult<String> {
    if plaintext.is_empty() {
        return Ok(String::new());
    }
    encrypt_with_key(plaintext, &get_or_create_master_key()?)
}

pub fn decrypt(stored: &str) -> AppResult<String> {
    if stored.is_empty() {
        return Ok(String::new());
    }
    decrypt_with_key(stored, &get_or_create_master_key()?)
}

fn encrypt_with_key(plaintext: &str, key_bytes: &[u8; 32]) -> AppResult<String> {
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key_bytes));
    let mut nonce_bytes = [0u8; NONCE_LEN];
    OsRng.fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ct = cipher
        .encrypt(nonce, plaintext.as_bytes())
        .map_err(|e| AppError::Crypto(e.to_string()))?;
    let mut blob = Vec::with_capacity(NONCE_LEN + ct.len());
    blob.extend_from_slice(&nonce_bytes);
    blob.extend_from_slice(&ct);
    Ok(B64.encode(blob))
}

fn decrypt_with_key(stored: &str, key_bytes: &[u8; 32]) -> AppResult<String> {
    let blob = B64
        .decode(stored)
        .map_err(|e| AppError::Crypto(format!("corrupt ciphertext: {e}")))?;
    if blob.len() < NONCE_LEN {
        return Err(AppError::Crypto("ciphertext too short".into()));
    }
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key_bytes));
    let nonce = Nonce::from_slice(&blob[..NONCE_LEN]);
    let pt = cipher
        .decrypt(nonce, &blob[NONCE_LEN..])
        .map_err(|e| AppError::Crypto(format!("decrypt failed: {e}")))?;
    String::from_utf8(pt).map_err(|e| AppError::Crypto(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: [u8; 32] = [7u8; 32];

    #[test]
    fn round_trip() {
        let ct = encrypt_with_key("mật khẩu bí mật 🔑", &KEY).unwrap();
        assert_ne!(ct, "mật khẩu bí mật 🔑");
        assert_eq!(decrypt_with_key(&ct, &KEY).unwrap(), "mật khẩu bí mật 🔑");
    }

    #[test]
    fn nonce_random_per_encrypt() {
        let a = encrypt_with_key("x", &KEY).unwrap();
        let b = encrypt_with_key("x", &KEY).unwrap();
        assert_ne!(a, b, "cùng plaintext phải ra ciphertext khác (nonce ngẫu nhiên)");
    }

    #[test]
    fn tamper_detected() {
        let ct = encrypt_with_key("secret", &KEY).unwrap();
        let mut blob = B64.decode(&ct).unwrap();
        let last = blob.len() - 1;
        blob[last] ^= 0x01;
        let tampered = B64.encode(blob);
        assert!(decrypt_with_key(&tampered, &KEY).is_err(), "GCM phải phát hiện sửa đổi");
    }

    #[test]
    fn wrong_key_fails() {
        let ct = encrypt_with_key("secret", &KEY).unwrap();
        assert!(decrypt_with_key(&ct, &[8u8; 32]).is_err());
    }

    #[test]
    fn invalid_inputs() {
        assert!(decrypt_with_key("not-base64!!!", &KEY).is_err());
        assert!(decrypt_with_key(&B64.encode([0u8; 4]), &KEY).is_err(), "ngắn hơn nonce");
    }

    #[test]
    fn key_file_round_trip_and_perms() {
        // KEY_DIR is a process-global OnceLock; this is the only test that sets it.
        let dir = std::env::temp_dir().join("dbstudio-crypto-test");
        let _ = std::fs::remove_dir_all(&dir);
        set_key_dir(dir.clone());

        assert!(read_key_file().is_none(), "chưa ghi thì không có key file");
        write_key_file(&KEY).unwrap();
        assert_eq!(read_key_file(), Some(KEY), "key file phải round-trip đúng key");

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(dir.join(KEY_FILE)).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600, "key file phải là 0600 (chỉ chủ sở hữu)");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
