// Typed wrappers around Tauri IPC commands (backend/src/commands/*).

import { invoke } from '@tauri-apps/api/core'
import type {
  ColumnInfo,
  ConstraintInfo,
  ExecResponse,
  IndexInfo,
  ProfileDraft,
  ProfilePublic,
  RoutineInfo,
  SchemaInfo,
  SequenceInfo,
  TableInfo,
  TestResult,
  TriggerInfo,
} from './types'

// ---- connections -----------------------------------------------------------

export const listConnections = () => invoke<ProfilePublic[]>('list_connections')

export const saveConnection = (draft: ProfileDraft) =>
  invoke<ProfilePublic>('save_connection', { draft })

export const deleteConnection = (id: string) => invoke<void>('delete_connection', { id })

export const duplicateConnection = (id: string) =>
  invoke<ProfilePublic>('duplicate_connection', { id })

export const connect = (id: string) => invoke<number>('connect', { id })

export const disconnect = (id: string) => invoke<void>('disconnect', { id })

export const reconnect = (id: string) => invoke<number>('reconnect', { id })

export const testConnection = (draft: ProfileDraft) =>
  invoke<TestResult>('test_connection', { draft })

export const pingConnection = (id: string) => invoke<boolean>('ping_connection', { id })

// ---- query -----------------------------------------------------------------

export const execStatement = (connId: string, sql: string, statementIndex?: number) =>
  invoke<ExecResponse>('exec_statement', { connId, sql, statementIndex })

export const cancelQuery = (connId: string) =>
  invoke<{ cancelled: boolean }>('cancel_query', { connId })

// ---- schema (Object Explorer) ----------------------------------------------

export const listSchemas = (connId: string) => invoke<SchemaInfo[]>('list_schemas', { connId })

export const listTables = (connId: string, schema: string) =>
  invoke<TableInfo[]>('list_tables', { connId, schema })

export const listColumns = (connId: string, schema: string, table: string) =>
  invoke<ColumnInfo[]>('list_columns', { connId, schema, table })

export const listIndexes = (connId: string, schema: string, table: string) =>
  invoke<IndexInfo[]>('list_indexes', { connId, schema, table })

export const listConstraints = (connId: string, schema: string, table: string) =>
  invoke<ConstraintInfo[]>('list_constraints', { connId, schema, table })

export const listRoutines = (connId: string, schema: string) =>
  invoke<RoutineInfo[]>('list_routines', { connId, schema })

export const listTriggers = (connId: string, schema: string) =>
  invoke<TriggerInfo[]>('list_triggers', { connId, schema })

export const listSequences = (connId: string, schema: string) =>
  invoke<SequenceInfo[]>('list_sequences', { connId, schema })

// ---- tabs + app state --------------------------------------------------------

export interface PersistedTab {
  id: string
  is_pinned: boolean
  payload: unknown
}

export const saveTabs = (tabs: PersistedTab[]) => invoke<void>('save_tabs', { tabs })

export const loadTabs = <T = unknown>() => invoke<T[]>('load_tabs')

export const getAppState = (key: string) => invoke<string | null>('get_app_state', { key })

export const setAppState = (key: string, value: string) =>
  invoke<void>('set_app_state', { key, value })
