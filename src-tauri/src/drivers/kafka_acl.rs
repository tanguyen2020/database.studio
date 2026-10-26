//! Kafka ACLs (SPEC-REDPANDA.md R10) over the Kafka protocol — DescribeAcls /
//! CreateAcls / DeleteAcls. rust-rdkafka 0.38 has no safe wrapper for them, so this
//! drives librdkafka's admin API directly (the bindings rdkafka re-exports): build the
//! request objects, send it on a private queue, wait for the result event, read it,
//! free everything. Works on Apache Kafka and on Redpanda (its principals include
//! `RedpandaRole:<role>`).
//!
//! Every call blocks (it waits on a librdkafka queue), so callers run it in
//! `spawn_blocking` with the client kept alive by an `Arc`.

use std::ffi::{CStr, CString};
use std::os::raw::{c_char, c_int};
use std::ptr;

use rdkafka::bindings as rd;
use serde::{Deserialize, Serialize};

/// One ACL binding, in the words `rpk acl list` / `kafka-acls` use.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct KafkaAcl {
    /// TOPIC | GROUP | CLUSTER | TRANSACTIONAL_ID
    pub resource_type: String,
    pub resource_name: String,
    /// LITERAL | PREFIXED
    pub pattern_type: String,
    /// `User:alice`, `RedpandaRole:readers`, `User:*`
    pub principal: String,
    /// `*` = any host
    pub host: String,
    /// READ | WRITE | CREATE | DELETE | ALTER | DESCRIBE | CLUSTER_ACTION |
    /// DESCRIBE_CONFIGS | ALTER_CONFIGS | IDEMPOTENT_WRITE | ALL
    pub operation: String,
    /// ALLOW | DENY
    pub permission: String,
}

/// Which bindings to describe / delete. `None` / "ANY" match everything.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AclFilter {
    #[serde(default)]
    pub resource_type: Option<String>,
    #[serde(default)]
    pub resource_name: Option<String>,
    #[serde(default)]
    pub pattern_type: Option<String>,
    #[serde(default)]
    pub principal: Option<String>,
    #[serde(default)]
    pub host: Option<String>,
    #[serde(default)]
    pub operation: Option<String>,
    #[serde(default)]
    pub permission: Option<String>,
}

impl From<&KafkaAcl> for AclFilter {
    fn from(a: &KafkaAcl) -> Self {
        AclFilter {
            resource_type: Some(a.resource_type.clone()),
            resource_name: Some(a.resource_name.clone()),
            pattern_type: Some(a.pattern_type.clone()),
            principal: Some(a.principal.clone()),
            host: Some(a.host.clone()),
            operation: Some(a.operation.clone()),
            permission: Some(a.permission.clone()),
        }
    }
}

// ---- names ⇄ librdkafka enums (pure, unit-tested) ------------------------------

/// Kafka protocol resource type 4 is CLUSTER; librdkafka calls the same value BROKER.
pub fn resource_type(s: &str) -> Result<rd::rd_kafka_ResourceType_t, String> {
    use rd::rd_kafka_ResourceType_t::*;
    Ok(match s.trim().to_ascii_uppercase().as_str() {
        "" | "ANY" => RD_KAFKA_RESOURCE_ANY,
        "TOPIC" => RD_KAFKA_RESOURCE_TOPIC,
        "GROUP" => RD_KAFKA_RESOURCE_GROUP,
        "CLUSTER" | "BROKER" => RD_KAFKA_RESOURCE_BROKER,
        "TRANSACTIONAL_ID" => RD_KAFKA_RESOURCE_TRANSACTIONAL_ID,
        other => return Err(format!("Unknown resource type {other} (use TOPIC, GROUP, CLUSTER or TRANSACTIONAL_ID)")),
    })
}

pub fn resource_type_name(t: rd::rd_kafka_ResourceType_t) -> &'static str {
    use rd::rd_kafka_ResourceType_t::*;
    match t {
        RD_KAFKA_RESOURCE_TOPIC => "TOPIC",
        RD_KAFKA_RESOURCE_GROUP => "GROUP",
        RD_KAFKA_RESOURCE_BROKER => "CLUSTER",
        RD_KAFKA_RESOURCE_TRANSACTIONAL_ID => "TRANSACTIONAL_ID",
        RD_KAFKA_RESOURCE_ANY => "ANY",
        _ => "UNKNOWN",
    }
}

pub fn pattern_type(s: &str) -> Result<rd::rd_kafka_ResourcePatternType_t, String> {
    use rd::rd_kafka_ResourcePatternType_t::*;
    Ok(match s.trim().to_ascii_uppercase().as_str() {
        "" | "ANY" => RD_KAFKA_RESOURCE_PATTERN_ANY,
        "MATCH" => RD_KAFKA_RESOURCE_PATTERN_MATCH,
        "LITERAL" => RD_KAFKA_RESOURCE_PATTERN_LITERAL,
        "PREFIXED" => RD_KAFKA_RESOURCE_PATTERN_PREFIXED,
        other => return Err(format!("Unknown pattern type {other} (use LITERAL or PREFIXED)")),
    })
}

pub fn pattern_type_name(t: rd::rd_kafka_ResourcePatternType_t) -> &'static str {
    use rd::rd_kafka_ResourcePatternType_t::*;
    match t {
        RD_KAFKA_RESOURCE_PATTERN_LITERAL => "LITERAL",
        RD_KAFKA_RESOURCE_PATTERN_PREFIXED => "PREFIXED",
        RD_KAFKA_RESOURCE_PATTERN_MATCH => "MATCH",
        RD_KAFKA_RESOURCE_PATTERN_ANY => "ANY",
        _ => "UNKNOWN",
    }
}

pub const OPERATIONS: &[&str] = &[
    "ALL",
    "READ",
    "WRITE",
    "CREATE",
    "DELETE",
    "ALTER",
    "DESCRIBE",
    "CLUSTER_ACTION",
    "DESCRIBE_CONFIGS",
    "ALTER_CONFIGS",
    "IDEMPOTENT_WRITE",
];

pub fn operation(s: &str) -> Result<rd::rd_kafka_AclOperation_t, String> {
    use rd::rd_kafka_AclOperation_t::*;
    Ok(match s.trim().to_ascii_uppercase().as_str() {
        "" | "ANY" => RD_KAFKA_ACL_OPERATION_ANY,
        "ALL" => RD_KAFKA_ACL_OPERATION_ALL,
        "READ" => RD_KAFKA_ACL_OPERATION_READ,
        "WRITE" => RD_KAFKA_ACL_OPERATION_WRITE,
        "CREATE" => RD_KAFKA_ACL_OPERATION_CREATE,
        "DELETE" => RD_KAFKA_ACL_OPERATION_DELETE,
        "ALTER" => RD_KAFKA_ACL_OPERATION_ALTER,
        "DESCRIBE" => RD_KAFKA_ACL_OPERATION_DESCRIBE,
        "CLUSTER_ACTION" => RD_KAFKA_ACL_OPERATION_CLUSTER_ACTION,
        "DESCRIBE_CONFIGS" => RD_KAFKA_ACL_OPERATION_DESCRIBE_CONFIGS,
        "ALTER_CONFIGS" => RD_KAFKA_ACL_OPERATION_ALTER_CONFIGS,
        "IDEMPOTENT_WRITE" => RD_KAFKA_ACL_OPERATION_IDEMPOTENT_WRITE,
        other => return Err(format!("Unknown operation {other}")),
    })
}

pub fn operation_name(o: rd::rd_kafka_AclOperation_t) -> &'static str {
    use rd::rd_kafka_AclOperation_t::*;
    match o {
        RD_KAFKA_ACL_OPERATION_ALL => "ALL",
        RD_KAFKA_ACL_OPERATION_READ => "READ",
        RD_KAFKA_ACL_OPERATION_WRITE => "WRITE",
        RD_KAFKA_ACL_OPERATION_CREATE => "CREATE",
        RD_KAFKA_ACL_OPERATION_DELETE => "DELETE",
        RD_KAFKA_ACL_OPERATION_ALTER => "ALTER",
        RD_KAFKA_ACL_OPERATION_DESCRIBE => "DESCRIBE",
        RD_KAFKA_ACL_OPERATION_CLUSTER_ACTION => "CLUSTER_ACTION",
        RD_KAFKA_ACL_OPERATION_DESCRIBE_CONFIGS => "DESCRIBE_CONFIGS",
        RD_KAFKA_ACL_OPERATION_ALTER_CONFIGS => "ALTER_CONFIGS",
        RD_KAFKA_ACL_OPERATION_IDEMPOTENT_WRITE => "IDEMPOTENT_WRITE",
        RD_KAFKA_ACL_OPERATION_ANY => "ANY",
        _ => "UNKNOWN",
    }
}

pub fn permission(s: &str) -> Result<rd::rd_kafka_AclPermissionType_t, String> {
    use rd::rd_kafka_AclPermissionType_t::*;
    Ok(match s.trim().to_ascii_uppercase().as_str() {
        "" | "ANY" => RD_KAFKA_ACL_PERMISSION_TYPE_ANY,
        "ALLOW" => RD_KAFKA_ACL_PERMISSION_TYPE_ALLOW,
        "DENY" => RD_KAFKA_ACL_PERMISSION_TYPE_DENY,
        other => return Err(format!("Unknown permission {other} (use ALLOW or DENY)")),
    })
}

pub fn permission_name(p: rd::rd_kafka_AclPermissionType_t) -> &'static str {
    use rd::rd_kafka_AclPermissionType_t::*;
    match p {
        RD_KAFKA_ACL_PERMISSION_TYPE_ALLOW => "ALLOW",
        RD_KAFKA_ACL_PERMISSION_TYPE_DENY => "DENY",
        RD_KAFKA_ACL_PERMISSION_TYPE_ANY => "ANY",
        _ => "UNKNOWN",
    }
}

/// A binding to create must name everything concretely (no ANY / MATCH).
pub fn validate_new(a: &KafkaAcl) -> Result<(), String> {
    if a.resource_name.trim().is_empty() {
        return Err("Name the resource (topic, group, transactional id) — or kafka-cluster for CLUSTER".into());
    }
    if !a.principal.contains(':') {
        return Err(format!("Principal must look like User:alice or RedpandaRole:readers (got {})", a.principal));
    }
    if ["ANY", ""].contains(&a.operation.trim().to_ascii_uppercase().as_str()) {
        return Err("Pick an operation".into());
    }
    if !["LITERAL", "PREFIXED"].contains(&a.pattern_type.trim().to_ascii_uppercase().as_str()) {
        return Err("Pattern type must be LITERAL or PREFIXED".into());
    }
    if !["ALLOW", "DENY"].contains(&a.permission.trim().to_ascii_uppercase().as_str()) {
        return Err("Permission must be ALLOW or DENY".into());
    }
    resource_type(&a.resource_type)?;
    operation(&a.operation)?;
    Ok(())
}

// ---- librdkafka calls --------------------------------------------------------

fn cstr_opt(s: &Option<String>) -> Result<Option<CString>, String> {
    match s.as_deref().map(str::trim).filter(|v| !v.is_empty()) {
        Some(v) => CString::new(v).map(Some).map_err(|_| "value contains a NUL byte".to_string()),
        None => Ok(None),
    }
}

unsafe fn text(p: *const c_char) -> String {
    if p.is_null() {
        String::new()
    } else {
        unsafe { CStr::from_ptr(p) }.to_string_lossy().into_owned()
    }
}

unsafe fn binding_of(b: *const rd::rd_kafka_AclBinding_t) -> KafkaAcl {
    unsafe {
        KafkaAcl {
            resource_type: resource_type_name(rd::rd_kafka_AclBinding_restype(b)).into(),
            resource_name: text(rd::rd_kafka_AclBinding_name(b)),
            pattern_type: pattern_type_name(rd::rd_kafka_AclBinding_resource_pattern_type(b)).into(),
            principal: text(rd::rd_kafka_AclBinding_principal(b)),
            host: text(rd::rd_kafka_AclBinding_host(b)),
            operation: operation_name(rd::rd_kafka_AclBinding_operation(b)).into(),
            permission: permission_name(rd::rd_kafka_AclBinding_permission_type(b)).into(),
        }
    }
}

/// Admin options + a private queue, freed on drop.
struct Call {
    opts: *mut rd::rd_kafka_AdminOptions_t,
    queue: *mut rd::rd_kafka_queue_t,
}

impl Call {
    unsafe fn new(rk: *mut rd::rd_kafka_t, op: rd::rd_kafka_admin_op_t, timeout_ms: i32) -> Self {
        unsafe {
            let opts = rd::rd_kafka_AdminOptions_new(rk, op);
            let mut err = [0 as c_char; 256];
            rd::rd_kafka_AdminOptions_set_request_timeout(opts, timeout_ms as c_int, err.as_mut_ptr(), err.len());
            Call { opts, queue: rd::rd_kafka_queue_new(rk) }
        }
    }

    /// Wait for the result event (owned by the caller — destroy it).
    unsafe fn wait(&self, timeout_ms: i32) -> Result<*mut rd::rd_kafka_event_t, String> {
        unsafe {
            let ev = rd::rd_kafka_queue_poll(self.queue, timeout_ms + 2_000);
            if ev.is_null() {
                return Err("The broker did not answer the ACL request in time".into());
            }
            if rd::rd_kafka_event_error(ev) != rd::rd_kafka_resp_err_t::RD_KAFKA_RESP_ERR_NO_ERROR {
                let m = text(rd::rd_kafka_event_error_string(ev));
                rd::rd_kafka_event_destroy(ev);
                return Err(friendly(&m));
            }
            Ok(ev)
        }
    }
}

impl Drop for Call {
    fn drop(&mut self) {
        unsafe {
            rd::rd_kafka_AdminOptions_destroy(self.opts);
            rd::rd_kafka_queue_destroy(self.queue);
        }
    }
}

/// The broker's text, with the case everybody hits explained.
pub fn friendly(m: &str) -> String {
    let lower = m.to_ascii_lowercase();
    if lower.contains("security_disabled") || lower.contains("security features are disabled") || lower.contains("no authorizer") {
        // Apache Kafka says "No Authorizer is configured on the broker." (measured on 3.x) — say what to do
        return "ACLs are not available: the broker has no authorizer configured (set authorizer.class.name on the brokers to use them)".into();
    }
    if lower.contains("cluster_authorization_failed") || lower.contains("not authorized") {
        return format!("{m} — the user needs the ALTER (create / delete) or DESCRIBE (list) permission on the CLUSTER resource");
    }
    m.to_string()
}

unsafe fn new_filter(f: &AclFilter) -> Result<*mut rd::rd_kafka_AclBindingFilter_t, String> {
    let name = cstr_opt(&f.resource_name)?;
    let principal = cstr_opt(&f.principal)?;
    let host = cstr_opt(&f.host)?;
    let mut err = [0 as c_char; 512];
    let p = unsafe {
        rd::rd_kafka_AclBindingFilter_new(
            resource_type(f.resource_type.as_deref().unwrap_or(""))?,
            name.as_ref().map_or(ptr::null(), |c| c.as_ptr()),
            pattern_type(f.pattern_type.as_deref().unwrap_or(""))?,
            principal.as_ref().map_or(ptr::null(), |c| c.as_ptr()),
            host.as_ref().map_or(ptr::null(), |c| c.as_ptr()),
            operation(f.operation.as_deref().unwrap_or(""))?,
            permission(f.permission.as_deref().unwrap_or(""))?,
            err.as_mut_ptr(),
            err.len(),
        )
    };
    if p.is_null() {
        return Err(unsafe { text(err.as_ptr()) });
    }
    Ok(p)
}

/// DescribeAcls on a librdkafka handle.
///
/// # Safety
/// `rk` must be a live librdkafka handle for the whole call.
pub unsafe fn describe(rk: *mut rd::rd_kafka_t, filter: &AclFilter, timeout_ms: i32) -> Result<Vec<KafkaAcl>, String> {
    unsafe {
        let f = new_filter(filter)?;
        let call = Call::new(rk, rd::rd_kafka_admin_op_t::RD_KAFKA_ADMIN_OP_DESCRIBEACLS, timeout_ms);
        rd::rd_kafka_DescribeAcls(rk, f, call.opts, call.queue);
        rd::rd_kafka_AclBinding_destroy(f);
        let ev = call.wait(timeout_ms)?;
        let res = rd::rd_kafka_event_DescribeAcls_result(ev);
        let mut out = Vec::new();
        if !res.is_null() {
            let mut n = 0usize;
            let arr = rd::rd_kafka_DescribeAcls_result_acls(res, &mut n);
            for i in 0..n {
                out.push(binding_of(*arr.add(i)));
            }
        }
        rd::rd_kafka_event_destroy(ev);
        out.sort_by(|a, b| (&a.principal, &a.resource_type, &a.resource_name, &a.operation).cmp(&(&b.principal, &b.resource_type, &b.resource_name, &b.operation)));
        Ok(out)
    }
}

/// CreateAcls; the first per-binding error is returned.
///
/// # Safety
/// `rk` must be a live librdkafka handle for the whole call.
pub unsafe fn create(rk: *mut rd::rd_kafka_t, acls: &[KafkaAcl], timeout_ms: i32) -> Result<usize, String> {
    for a in acls {
        validate_new(a)?;
    }
    unsafe {
        let mut bindings: Vec<*mut rd::rd_kafka_AclBinding_t> = Vec::new();
        let cleanup = |v: &mut Vec<*mut rd::rd_kafka_AclBinding_t>| {
            for b in v.drain(..) {
                rd::rd_kafka_AclBinding_destroy(b);
            }
        };
        for a in acls {
            let name = CString::new(a.resource_name.trim()).map_err(|_| "NUL in name".to_string())?;
            let principal = CString::new(a.principal.trim()).map_err(|_| "NUL in principal".to_string())?;
            let host = CString::new(if a.host.trim().is_empty() { "*" } else { a.host.trim() }).map_err(|_| "NUL in host".to_string())?;
            let mut err = [0 as c_char; 512];
            let b = rd::rd_kafka_AclBinding_new(
                resource_type(&a.resource_type)?,
                name.as_ptr(),
                pattern_type(&a.pattern_type)?,
                principal.as_ptr(),
                host.as_ptr(),
                operation(&a.operation)?,
                permission(&a.permission)?,
                err.as_mut_ptr(),
                err.len(),
            );
            if b.is_null() {
                cleanup(&mut bindings);
                return Err(text(err.as_ptr()));
            }
            bindings.push(b);
        }
        let call = Call::new(rk, rd::rd_kafka_admin_op_t::RD_KAFKA_ADMIN_OP_CREATEACLS, timeout_ms);
        rd::rd_kafka_CreateAcls(rk, bindings.as_mut_ptr(), bindings.len(), call.opts, call.queue);
        cleanup(&mut bindings);
        let ev = call.wait(timeout_ms)?;
        let res = rd::rd_kafka_event_CreateAcls_result(ev);
        let mut first_err: Option<String> = None;
        let mut n = 0usize;
        if !res.is_null() {
            let arr = rd::rd_kafka_CreateAcls_result_acls(res, &mut n);
            for i in 0..n {
                let e = rd::rd_kafka_acl_result_error(*arr.add(i));
                if !e.is_null() && rd::rd_kafka_error_code(e) != rd::rd_kafka_resp_err_t::RD_KAFKA_RESP_ERR_NO_ERROR && first_err.is_none() {
                    first_err = Some(friendly(&text(rd::rd_kafka_error_string(e))));
                }
            }
        }
        rd::rd_kafka_event_destroy(ev);
        match first_err {
            Some(e) => Err(e),
            None => Ok(n),
        }
    }
}

/// DeleteAcls; returns the bindings that were removed.
///
/// # Safety
/// `rk` must be a live librdkafka handle for the whole call.
pub unsafe fn delete(rk: *mut rd::rd_kafka_t, filters: &[AclFilter], timeout_ms: i32) -> Result<Vec<KafkaAcl>, String> {
    unsafe {
        let mut fs: Vec<*mut rd::rd_kafka_AclBindingFilter_t> = Vec::new();
        for f in filters {
            match new_filter(f) {
                Ok(p) => fs.push(p),
                Err(e) => {
                    for p in fs.drain(..) {
                        rd::rd_kafka_AclBinding_destroy(p);
                    }
                    return Err(e);
                }
            }
        }
        let call = Call::new(rk, rd::rd_kafka_admin_op_t::RD_KAFKA_ADMIN_OP_DELETEACLS, timeout_ms);
        rd::rd_kafka_DeleteAcls(rk, fs.as_mut_ptr(), fs.len(), call.opts, call.queue);
        for p in fs.drain(..) {
            rd::rd_kafka_AclBinding_destroy(p);
        }
        let ev = call.wait(timeout_ms)?;
        let res = rd::rd_kafka_event_DeleteAcls_result(ev);
        let mut removed = Vec::new();
        let mut first_err: Option<String> = None;
        if !res.is_null() {
            let mut n = 0usize;
            let arr = rd::rd_kafka_DeleteAcls_result_responses(res, &mut n);
            for i in 0..n {
                let r = *arr.add(i);
                let e = rd::rd_kafka_DeleteAcls_result_response_error(r);
                if !e.is_null() && rd::rd_kafka_error_code(e) != rd::rd_kafka_resp_err_t::RD_KAFKA_RESP_ERR_NO_ERROR {
                    first_err.get_or_insert_with(|| friendly(&text(rd::rd_kafka_error_string(e))));
                    continue;
                }
                let mut m = 0usize;
                let matched = rd::rd_kafka_DeleteAcls_result_response_matching_acls(r, &mut m);
                for j in 0..m {
                    removed.push(binding_of(*matched.add(j)));
                }
            }
        }
        rd::rd_kafka_event_destroy(ev);
        match first_err {
            Some(e) if removed.is_empty() => Err(e),
            _ => Ok(removed),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_round_trip_and_cluster_is_resource_4() {
        for n in ["TOPIC", "GROUP", "CLUSTER", "TRANSACTIONAL_ID"] {
            assert_eq!(resource_type_name(resource_type(n).unwrap()), n);
        }
        // the Kafka protocol's CLUSTER (4) is librdkafka's BROKER
        assert_eq!(resource_type("cluster").unwrap() as i32, 4);
        for n in ["LITERAL", "PREFIXED"] {
            assert_eq!(pattern_type_name(pattern_type(n).unwrap()), n);
        }
        for n in OPERATIONS {
            assert_eq!(operation_name(operation(n).unwrap()), *n);
        }
        for n in ["ALLOW", "DENY"] {
            assert_eq!(permission_name(permission(n).unwrap()), n);
        }
        assert!(resource_type("table").is_err());
        assert_eq!(operation("").unwrap(), rd::rd_kafka_AclOperation_t::RD_KAFKA_ACL_OPERATION_ANY);
    }

    #[test]
    fn a_new_binding_must_be_concrete() {
        let ok = KafkaAcl {
            resource_type: "TOPIC".into(),
            resource_name: "orders".into(),
            pattern_type: "LITERAL".into(),
            principal: "User:bob".into(),
            host: "*".into(),
            operation: "READ".into(),
            permission: "ALLOW".into(),
        };
        assert!(validate_new(&ok).is_ok());
        assert!(validate_new(&KafkaAcl { principal: "bob".into(), ..ok.clone() }).unwrap_err().contains("User:alice"));
        assert!(validate_new(&KafkaAcl { operation: "ANY".into(), ..ok.clone() }).is_err());
        assert!(validate_new(&KafkaAcl { pattern_type: "MATCH".into(), ..ok.clone() }).is_err());
        assert!(validate_new(&KafkaAcl { resource_name: " ".into(), ..ok.clone() }).is_err());
        assert!(validate_new(&KafkaAcl { principal: "RedpandaRole:readers".into(), ..ok }).is_ok());
    }

    #[test]
    fn broker_errors_get_a_hint() {
        assert!(friendly("Broker: Security features are disabled").contains("no authorizer"));
        // measured on Apache Kafka 3.x: one sentence, not the broker text + the same idea again
        assert_eq!(
            friendly("No Authorizer is configured on the broker."),
            "ACLs are not available: the broker has no authorizer configured (set authorizer.class.name on the brokers to use them)"
        );
        assert!(friendly("Broker: Cluster authorization failed (CLUSTER_AUTHORIZATION_FAILED)").contains("CLUSTER resource"));
        assert_eq!(friendly("other"), "other");
    }
}
