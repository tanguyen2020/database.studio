// Format SQL dialect-aware (sql-formatter). Map system → dialect của lib.
import { format, type FormatOptionsWithLanguage } from 'sql-formatter'

function langOf(system: string): FormatOptionsWithLanguage['language'] {
  switch (system) {
    case 'postgres':
      return 'postgresql'
    case 'mysql':
    case 'mariadb':
      return 'mysql'
    case 'mssql':
      return 'transactsql'
    case 'sqlite':
      return 'sqlite'
    case 'oracle':
      return 'plsql'
    case 'clickhouse':
      // sql-formatter chưa có ClickHouse riêng → dùng chuẩn SQL
      return 'sql'
    default:
      return 'sql'
  }
}

export function formatSql(system: string, sql: string): string {
  try {
    return format(sql, {
      language: langOf(system),
      keywordCase: 'upper',
      tabWidth: 2,
    })
  } catch {
    return sql // format lỗi → giữ nguyên (không phá nội dung người dùng)
  }
}
