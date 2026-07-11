//
// GENERATED — do not edit by hand.
// Sinh bởi scripts/extract-tokens.mjs từ "Database Studio.dc.html" (sha256 af89d4d232c2).
// Chạy lại: npm run tokens
// 

export interface SysGenEntry {
  accent: string
  bg: string
  border: string
  fg: string
  badge: string
  label: string
}

export const SYS_GEN = {
  "postgres": {
    "accent": "#336791",
    "bg": "#1a3a52",
    "border": "#2a5a7a",
    "fg": "#7ec8f0",
    "badge": "PG",
    "label": "PostgreSQL"
  },
  "mysql": {
    "accent": "#F29111",
    "bg": "#3d2800",
    "border": "#6b4400",
    "fg": "#f5b84a",
    "badge": "MY",
    "label": "MySQL"
  },
  "mssql": {
    "accent": "#CC2927",
    "bg": "#3d0a09",
    "border": "#6b1515",
    "fg": "#f08080",
    "badge": "MS",
    "label": "SQL Server"
  },
  "redis": {
    "accent": "#D82C20",
    "bg": "#3d0c08",
    "border": "#6b1a14",
    "fg": "#f07070",
    "badge": "RE",
    "label": "Redis"
  },
  "kafka": {
    "accent": "#8B5CF6",
    "bg": "#1e1a2e",
    "border": "#3d2f6b",
    "fg": "#c4b5fd",
    "badge": "KF",
    "label": "Kafka"
  },
  "nats": {
    "accent": "#27AE60",
    "bg": "#0d2e1a",
    "border": "#1a5c35",
    "fg": "#6ee7a0",
    "badge": "NT",
    "label": "NATS"
  },
  "clickhouse": {
    "accent": "#FFCC00",
    "bg": "#33290a",
    "border": "#665514",
    "fg": "#ffe066",
    "badge": "CH",
    "label": "ClickHouse"
  },
  "mariadb": {
    "accent": "#C0765A",
    "bg": "#2e1a12",
    "border": "#5c3020",
    "fg": "#e8a882",
    "badge": "MA",
    "label": "MariaDB"
  },
  "cassandra": {
    "accent": "#1287B1",
    "bg": "#0a2030",
    "border": "#134f72",
    "fg": "#5cc4e8",
    "badge": "CS",
    "label": "Cassandra"
  },
  "sqlite": {
    "accent": "#0F80CC",
    "bg": "#0a1e35",
    "border": "#12406a",
    "fg": "#60b8f5",
    "badge": "SL",
    "label": "SQLite"
  },
  "mongodb": {
    "accent": "#00ED64",
    "bg": "#04231a",
    "border": "#0a5c3c",
    "fg": "#57e39a",
    "badge": "MG",
    "label": "MongoDB"
  },
  "orphan": {
    "accent": "#5b6473",
    "bg": "#2a2f3a",
    "border": "#3a4150",
    "fg": "#9aa4b8",
    "badge": "⚠",
    "label": "Orphaned"
  }
} as const

export type SysGenKey = keyof typeof SYS_GEN

export const ENV_GEN = {
  "production": {
    "label": "PROD",
    "bg": "#3d0c08",
    "fg": "#f07070"
  },
  "staging": {
    "label": "STG",
    "bg": "#2e2600",
    "fg": "#ffe066"
  },
  "development": {
    "label": "DEV",
    "bg": "#0d2e1a",
    "fg": "#6ee7a0"
  },
  "local": {
    "label": "LOCAL",
    "bg": "#1a1a2e",
    "fg": "#c4b5fd"
  }
} as const

export type EnvGenKey = keyof typeof ENV_GEN
