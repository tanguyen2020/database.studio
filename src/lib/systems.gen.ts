//
// GENERATED — do not edit by hand.
// Sinh bởi scripts/extract-tokens.mjs từ "Database Studio.dc.html" (sha256 0f7fa76d542c).
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
  "valkey": {
    "accent": "#6983FF",
    "bg": "#141a3a",
    "border": "#2b3670",
    "fg": "#aab8ff",
    "badge": "VK",
    "label": "Valkey"
  },
  "kafka": {
    "accent": "#8B5CF6",
    "bg": "#1e1a2e",
    "border": "#3d2f6b",
    "fg": "#c4b5fd",
    "badge": "KF",
    "label": "Kafka"
  },
  "redpanda": {
    "accent": "#E14226",
    "bg": "#3a120b",
    "border": "#6b2416",
    "fg": "#f28a76",
    "badge": "RP",
    "label": "Redpanda"
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
  "scylladb": {
    "accent": "#6CD5E7",
    "bg": "#0b2a30",
    "border": "#1c5560",
    "fg": "#8ae3f0",
    "badge": "SC",
    "label": "ScyllaDB"
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
  "ferretdb": {
    "accent": "#3C78B4",
    "bg": "#0c1a2a",
    "border": "#1d3a5c",
    "fg": "#8fb6e0",
    "badge": "FD",
    "label": "FerretDB"
  },
  "documentdb": {
    "accent": "#527FFF",
    "bg": "#141c3a",
    "border": "#2a3a72",
    "fg": "#a9bcff",
    "badge": "DD",
    "label": "Amazon DocumentDB"
  },
  "oracle": {
    "accent": "#C74634",
    "bg": "#301410",
    "border": "#5e281f",
    "fg": "#e8917a",
    "badge": "OR",
    "label": "Oracle"
  },
  "rabbitmq": {
    "accent": "#FF6600",
    "bg": "#33190a",
    "border": "#6b3412",
    "fg": "#ffa366",
    "badge": "RB",
    "label": "RabbitMQ"
  },
  "duckdb": {
    "accent": "#FFF000",
    "bg": "#2b2a05",
    "border": "#5e5a0c",
    "fg": "#fff36b",
    "badge": "DK",
    "label": "DuckDB"
  },
  "elasticsearch": {
    "accent": "#00BFB3",
    "bg": "#062a28",
    "border": "#0e5a55",
    "fg": "#5ee7df",
    "badge": "ES",
    "label": "Elasticsearch"
  },
  "opensearch": {
    "accent": "#005EB8",
    "bg": "#04223d",
    "border": "#0b3f6b",
    "fg": "#6fb1ea",
    "badge": "OS",
    "label": "OpenSearch"
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
