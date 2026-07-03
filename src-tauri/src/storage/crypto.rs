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
}
