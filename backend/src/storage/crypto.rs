//! Password encryption: AES-256-GCM with a per-machine master key held in the
//! OS keychain (Windows Credential Manager via the `keyring` crate).
//!
//! Stored format: base64( nonce(12) || ciphertext ). The master key never
//! leaves the keychain entry; profiles only ever hold ciphertext.

use aes_gcm::aead::{Aead, KeyInit, OsRng};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use rand::RngCore;

use crate::error::{AppError, AppResult};

const SERVICE: &str = "database-studio";
const ACCOUNT: &str = "master-key";
const NONCE_LEN: usize = 12;

fn get_or_create_master_key() -> AppResult<[u8; 32]> {
    let entry = keyring::Entry::new(SERVICE, ACCOUNT)
        .map_err(|e| AppError::Keychain(e.to_string()))?;

    match entry.get_password() {
        Ok(b64) => {
            let bytes = B64
                .decode(b64.trim())
                .map_err(|e| AppError::Keychain(format!("corrupt master key: {e}")))?;
            bytes
                .try_into()
                .map_err(|_| AppError::Keychain("master key has wrong length".into()))
        }
        Err(keyring::Error::NoEntry) => {
            let mut key = [0u8; 32];
            OsRng.fill_bytes(&mut key);
            entry
                .set_password(&B64.encode(key))
                .map_err(|e| AppError::Keychain(e.to_string()))?;
            Ok(key)
        }
        Err(e) => Err(AppError::Keychain(e.to_string())),
    }
}

pub fn encrypt(plaintext: &str) -> AppResult<String> {
    if plaintext.is_empty() {
        return Ok(String::new());
    }
    let key_bytes = get_or_create_master_key()?;
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key_bytes));
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

pub fn decrypt(stored: &str) -> AppResult<String> {
    if stored.is_empty() {
        return Ok(String::new());
    }
    let blob = B64
        .decode(stored)
        .map_err(|e| AppError::Crypto(format!("corrupt ciphertext: {e}")))?;
    if blob.len() < NONCE_LEN {
        return Err(AppError::Crypto("ciphertext too short".into()));
    }
    let key_bytes = get_or_create_master_key()?;
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key_bytes));
    let nonce = Nonce::from_slice(&blob[..NONCE_LEN]);
    let pt = cipher
        .decrypt(nonce, &blob[NONCE_LEN..])
        .map_err(|e| AppError::Crypto(format!("decrypt failed: {e}")))?;
    String::from_utf8(pt).map_err(|e| AppError::Crypto(e.to_string()))
}
