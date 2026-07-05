//! Azure AD auth for SQL Server (T31). The Service-Principal (client-credentials)
//! OAuth2 flow is a plain HTTPS POST (reqwest) → access token → tiberius
//! `AuthMethod::aad_token`. No secret is ever logged (see `redact`). The pure
//! request/response/cache helpers are unit-tested; the live token endpoint + a
//! real Azure SQL connect are exercised only by an `#[ignore]` manual test.

use serde::Deserialize;

use crate::error::QueryError;

/// Azure SQL Database scope for OAuth2 tokens.
pub const SQL_SCOPE: &str = "https://database.windows.net/.default";

/// OAuth2 v2.0 token endpoint for a tenant.
pub fn sp_token_url(tenant: &str) -> String {
    format!("https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token")
}

/// Client-credentials form body (order stable for testing).
pub fn sp_token_form<'a>(client_id: &'a str, client_secret: &'a str) -> [(&'static str, &'a str); 4] {
    [
        ("grant_type", "client_credentials"),
        ("client_id", client_id),
        ("client_secret", client_secret),
        ("scope", SQL_SCOPE),
    ]
}

#[derive(Debug, Deserialize)]
pub struct TokenResponse {
    pub access_token: String,
    #[serde(default)]
    pub expires_in: u64,
}

/// Parse the token endpoint's JSON. AAD errors come back as `{error, error_description}`.
pub fn parse_token_response(body: &str) -> Result<TokenResponse, String> {
    if let Ok(tok) = serde_json::from_str::<TokenResponse>(body) {
        if !tok.access_token.is_empty() {
            return Ok(tok);
        }
    }
    // surface AAD error without leaking anything sensitive
    let v: serde_json::Value = serde_json::from_str(body).unwrap_or_default();
    let err = v.get("error").and_then(|e| e.as_str()).unwrap_or("unknown_error");
    let desc = v.get("error_description").and_then(|e| e.as_str()).unwrap_or("no access_token in response");
    Err(format!("{err}: {}", desc.lines().next().unwrap_or(desc)))
}

/// Cached token with its absolute expiry (unix secs). `valid` leaves a refresh
/// skew so callers renew slightly before the real expiry.
#[derive(Clone)]
pub struct TokenCache {
    pub token: String,
    pub expires_at: u64,
}

impl TokenCache {
    pub fn new(token: String, expires_in: u64, now: u64) -> Self {
        Self { token, expires_at: now.saturating_add(expires_in) }
    }
    pub fn valid(&self, now: u64, skew: u64) -> bool {
        !self.token.is_empty() && now.saturating_add(skew) < self.expires_at
    }
}

/// Mask a secret for logs/errors — never print it in full.
pub fn redact(secret: &str) -> String {
    match secret.len() {
        0 => "<empty>".into(),
        1..=4 => "****".into(),
        n => format!("{}…**** ({n} chars)", &secret[..2]),
    }
}

/// Parse a Service-Principal user field encoded as `clientId@tenant`.
pub fn parse_sp_user(user: &str) -> Option<(String, String)> {
    let (client_id, tenant) = user.split_once('@')?;
    if client_id.is_empty() || tenant.is_empty() {
        return None;
    }
    Some((client_id.to_string(), tenant.to_string()))
}

/// Acquire an Azure SQL access token via the client-credentials flow. Live —
/// hits login.microsoftonline.com. Errors never contain the client secret.
pub async fn acquire_sp_token(tenant: &str, client_id: &str, client_secret: &str) -> Result<String, QueryError> {
    let resp = reqwest::Client::new()
        .post(sp_token_url(tenant))
        .form(&sp_token_form(client_id, client_secret))
        .send()
        .await
        .map_err(|e| QueryError::new("mssql", format!("Azure AD token request failed: {e}"), "aad token request"))?;
    let body = resp
        .text()
        .await
        .map_err(|e| QueryError::new("mssql", format!("Azure AD token read failed: {e}"), "aad token read"))?;
    parse_token_response(&body)
        .map(|t| t.access_token)
        .map_err(|e| QueryError::new("mssql", format!("Azure AD auth failed: {e}"), "aad auth"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_url_and_form() {
        assert_eq!(sp_token_url("mytenant"), "https://login.microsoftonline.com/mytenant/oauth2/v2.0/token");
        let form = sp_token_form("cid", "secret");
        assert_eq!(form[0], ("grant_type", "client_credentials"));
        assert_eq!(form[1], ("client_id", "cid"));
        assert_eq!(form[2], ("client_secret", "secret"));
        assert_eq!(form[3].1, SQL_SCOPE);
    }

    #[test]
    fn parse_valid_and_error() {
        let ok = parse_token_response(r#"{"token_type":"Bearer","expires_in":3599,"access_token":"eyJ0..."}"#).unwrap();
        assert_eq!(ok.access_token, "eyJ0...");
        assert_eq!(ok.expires_in, 3599);
        let err = parse_token_response(r#"{"error":"invalid_client","error_description":"AADSTS7000215: bad secret\r\nTrace ID: x"}"#).unwrap_err();
        assert!(err.contains("invalid_client"));
        assert!(err.contains("AADSTS7000215"));
        assert!(!err.contains("Trace ID"), "only first line kept");
        // a response with no access_token is an error, not a silent empty token
        assert!(parse_token_response(r#"{"token_type":"Bearer"}"#).is_err());
    }

    #[test]
    fn cache_validity_with_skew() {
        let c = TokenCache::new("tok".into(), 3600, 1000);
        assert_eq!(c.expires_at, 4600);
        assert!(c.valid(1000, 300)); // fresh
        assert!(c.valid(4299, 300)); // 4299+300 < 4600
        assert!(!c.valid(4300, 300)); // within skew of expiry → refresh
        assert!(!c.valid(5000, 0)); // expired
        assert!(!TokenCache::new(String::new(), 3600, 0).valid(0, 0), "empty token never valid");
    }

    #[test]
    fn redact_never_leaks() {
        assert_eq!(redact(""), "<empty>");
        assert_eq!(redact("abc"), "****");
        let r = redact("supersecretvalue");
        assert!(r.starts_with("su"));
        assert!(!r.contains("secret"));
        assert!(r.contains("16 chars"));
    }

    #[test]
    fn parse_sp_user_splits_client_and_tenant() {
        assert_eq!(parse_sp_user("client-id@tenant-id"), Some(("client-id".into(), "tenant-id".into())));
        assert_eq!(parse_sp_user("noatsign"), None);
        assert_eq!(parse_sp_user("@tenant"), None);
        assert_eq!(parse_sp_user("client@"), None);
    }
}
