//! Index Scanner/Analyzer (Phase 5 · T7b). Quét index toàn schema + tính cờ
//! sức khỏe. `compute_flags` thuần (không I/O) → unit-test được; fetch catalog
//! ở mỗi driver (postgres/mysql/sqlite/mssql).

use serde::Serialize;

/// Một index đã quét (đủ cột cho bảng TanStack + panel chi tiết).
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct IndexScanRow {
    pub name: String,
    pub table: String,
    pub columns: Vec<String>,
    pub index_type: String,
    pub unique: bool,
    pub primary: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size_bytes: Option<i64>,
    /// Số lần index được dùng (idx_scan) khi hệ cung cấp; None nếu không có.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fragmentation_pct: Option<f64>,
    pub valid: bool,
    /// Cờ sức khỏe: unused / redundant / fragmented / invalid.
    pub flags: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct IndexScanSummary {
    pub total: usize,
    pub total_size_bytes: i64,
    pub unused: usize,
    pub redundant: usize,
    pub fragmented: usize,
    pub invalid: usize,
}

/// Gợi ý tạo index (missing-index). Nguồn: PG pg_stat_user_tables (nhiều seq
/// scan), MSSQL missing-index DMV. Dùng pattern chuẩn (không "anti_pattern").
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct MissingIndexSuggestion {
    pub table: String,
    /// Cột đề xuất (MSSQL DMV cung cấp; PG heuristic để trống).
    pub columns: Vec<String>,
    pub reason: String,
    /// Lợi ích ước lượng (MSSQL avg_user_impact %); None nếu không có.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub estimated_benefit: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct IndexScanResult {
    pub system: String,
    pub scope: String,
    pub indexes: Vec<IndexScanRow>,
    pub summary: IndexScanSummary,
    /// Gợi ý tạo index (missing-index) — rỗng nếu hệ không hỗ trợ.
    pub suggestions: Vec<MissingIndexSuggestion>,
}

/// Số liệu table-scan (PG pg_stat_user_tables) để suy ra missing-index.
pub struct TableScanStat {
    pub table: String,
    pub seq_scan: i64,
    pub idx_scan: i64,
    pub seq_tup_read: i64,
    pub live_rows: i64,
}

/// Heuristic missing-index cho Postgres (thuần, test được): bảng bị quét tuần
/// tự nhiều hơn quét index, có kích thước đáng kể, và đọc trung bình mỗi seq
/// scan lớn → khả năng thiếu index. Ngưỡng thận trọng để tránh báo động giả.
pub fn suggest_missing_pg(stats: &[TableScanStat]) -> Vec<MissingIndexSuggestion> {
    stats
        .iter()
        .filter(|s| {
            s.seq_scan > s.idx_scan
                && s.seq_scan >= 50
                && s.live_rows >= 1_000
                && (s.seq_tup_read / s.seq_scan.max(1)) >= 500
        })
        .map(|s| MissingIndexSuggestion {
            table: s.table.clone(),
            columns: Vec::new(),
            reason: format!(
                "{} seq scans ({} index scans), avg {} rows/scan read over ~{} rows — consider adding an index on the filter column",
                s.seq_scan,
                s.idx_scan,
                s.seq_tup_read / s.seq_scan.max(1),
                s.live_rows
            ),
            estimated_benefit: None,
        })
        .collect()
}

/// Tính cờ sức khỏe trên tập index (in-place) + trả summary. Thuần.
/// - unused: usage == Some(0) và KHÔNG phải primary.
/// - redundant: cột của index là *prefix* của một index khác CÙNG bảng.
/// - fragmented: fragmentation_pct > 30.
/// - invalid: valid == false.
pub fn compute_flags(rows: &mut [IndexScanRow]) -> IndexScanSummary {
    // redundant: so từng cặp cùng bảng.
    let snapshot: Vec<(String, Vec<String>)> =
        rows.iter().map(|r| (r.table.clone(), r.columns.clone())).collect();
    for (i, row) in rows.iter_mut().enumerate() {
        if row.usage == Some(0) && !row.primary {
            row.flags.push("unused".into());
        }
        if let Some(f) = row.fragmentation_pct {
            if f > 30.0 {
                row.flags.push("fragmented".into());
            }
        }
        if !row.valid {
            row.flags.push("invalid".into());
        }
        // redundant: tồn tại index KHÁC cùng bảng mà columns của row là prefix thực sự.
        let is_prefix_of_other = snapshot.iter().enumerate().any(|(j, (tbl, cols))| {
            j != i
                && *tbl == row.table
                && cols.len() > row.columns.len()
                && cols.starts_with(&row.columns)
                && !row.columns.is_empty()
        });
        if is_prefix_of_other && !row.primary && !row.unique {
            row.flags.push("redundant".into());
        }
    }

    IndexScanSummary {
        total: rows.len(),
        total_size_bytes: rows.iter().filter_map(|r| r.size_bytes).sum(),
        unused: rows.iter().filter(|r| r.flags.iter().any(|f| f == "unused")).count(),
        redundant: rows.iter().filter(|r| r.flags.iter().any(|f| f == "redundant")).count(),
        fragmented: rows.iter().filter(|r| r.flags.iter().any(|f| f == "fragmented")).count(),
        invalid: rows.iter().filter(|r| r.flags.iter().any(|f| f == "invalid")).count(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(name: &str, table: &str, cols: &[&str], unique: bool, primary: bool) -> IndexScanRow {
        IndexScanRow {
            name: name.into(),
            table: table.into(),
            columns: cols.iter().map(|s| s.to_string()).collect(),
            index_type: "BTREE".into(),
            unique,
            primary,
            size_bytes: Some(1024),
            usage: None,
            fragmentation_pct: None,
            valid: true,
            flags: Vec::new(),
        }
    }

    #[test]
    fn redundant_prefix_detected() {
        let mut rows = vec![
            row("idx_a", "t", &["x"], false, false),        // prefix của idx_ab → redundant
            row("idx_ab", "t", &["x", "y"], false, false),
        ];
        let s = compute_flags(&mut rows);
        assert!(rows[0].flags.contains(&"redundant".to_string()));
        assert!(!rows[1].flags.contains(&"redundant".to_string()));
        assert_eq!(s.redundant, 1);
    }

    #[test]
    fn unused_and_invalid_and_fragmented() {
        let mut rows = vec![row("idx_u", "t", &["a"], false, false)];
        rows[0].usage = Some(0);
        rows[0].valid = false;
        rows[0].fragmentation_pct = Some(55.0);
        let s = compute_flags(&mut rows);
        assert!(rows[0].flags.contains(&"unused".to_string()));
        assert!(rows[0].flags.contains(&"invalid".to_string()));
        assert!(rows[0].flags.contains(&"fragmented".to_string()));
        assert_eq!((s.unused, s.invalid, s.fragmented), (1, 1, 1));
    }

    #[test]
    fn primary_and_unique_never_redundant_or_unused() {
        let mut rows = vec![
            row("pk", "t", &["id"], true, true),
            row("pk_ext", "t", &["id", "x"], false, false),
        ];
        rows[0].usage = Some(0);
        compute_flags(&mut rows);
        assert!(rows[0].flags.is_empty(), "primary không bị gắn cờ: {:?}", rows[0].flags);
    }

    #[test]
    fn missing_index_suggests_only_heavy_seq_scan() {
        let stats = vec![
            // đủ ngưỡng → gợi ý
            TableScanStat { table: "orders".into(), seq_scan: 200, idx_scan: 5, seq_tup_read: 400_000, live_rows: 50_000 },
            // idx_scan > seq_scan → bỏ qua
            TableScanStat { table: "users".into(), seq_scan: 10, idx_scan: 900, seq_tup_read: 5_000, live_rows: 50_000 },
            // bảng nhỏ → bỏ qua (seq scan bảng nhỏ là bình thường)
            TableScanStat { table: "lookup".into(), seq_scan: 500, idx_scan: 0, seq_tup_read: 2_500, live_rows: 5 },
        ];
        let sug = suggest_missing_pg(&stats);
        assert_eq!(sug.len(), 1);
        assert_eq!(sug[0].table, "orders");
        assert!(sug[0].reason.contains("seq scan"));
    }
}
