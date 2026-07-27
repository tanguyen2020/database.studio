import { describe, expect, it } from 'vitest'
import { supportsTxn, txnEffect } from './txn'

describe('txnEffect', () => {
  it('opens on BEGIN / START TRANSACTION (per dialect spelling)', () => {
    expect(txnEffect('BEGIN', 'postgres')).toBe('begin')
    expect(txnEffect('begin;', 'postgres')).toBe('begin')
    expect(txnEffect('START TRANSACTION', 'mysql')).toBe('begin')
    expect(txnEffect('BEGIN TRANSACTION', 'mssql')).toBe('begin')
    expect(txnEffect('BEGIN TRAN', 'mssql')).toBe('begin')
    expect(txnEffect('BEGIN IMMEDIATE', 'sqlite')).toBe('begin')
    expect(txnEffect('BEGIN ISOLATION LEVEL SERIALIZABLE', 'postgres')).toBe('begin')
  })

  it('closes on COMMIT / ROLLBACK / END', () => {
    expect(txnEffect('COMMIT', 'postgres')).toBe('end')
    expect(txnEffect('ROLLBACK;', 'postgres')).toBe('end')
    expect(txnEffect('END', 'postgres')).toBe('end')
    expect(txnEffect('END TRANSACTION;', 'sqlite')).toBe('end')
    expect(txnEffect('COMMIT TRANSACTION', 'mssql')).toBe('end')
  })

  it('ROLLBACK TO SAVEPOINT keeps the transaction open', () => {
    expect(txnEffect('ROLLBACK TO SAVEPOINT sp1', 'postgres')).toBeNull()
    expect(txnEffect('SAVEPOINT sp1', 'postgres')).toBe('begin')
  })

  it('ignores leading comments and casing', () => {
    expect(txnEffect('-- start the batch\nBEGIN;', 'postgres')).toBe('begin')
    expect(txnEffect('/* block */\n  commit ;', 'mysql')).toBe('end')
  })

  it('plain statements do not change the state', () => {
    expect(txnEffect('SELECT 1', 'postgres')).toBeNull()
    expect(txnEffect('UPDATE t SET v = 1', 'mysql')).toBeNull()
    expect(txnEffect('INSERT INTO t VALUES (1)', 'mssql')).toBeNull()
  })

  it('DDL implicitly commits on MySQL/MariaDB/MSSQL but not on PostgreSQL', () => {
    expect(txnEffect('CREATE TABLE t (id int)', 'mysql')).toBe('end')
    expect(txnEffect('DROP TABLE t', 'mariadb')).toBe('end')
    expect(txnEffect('ALTER TABLE t ADD c int', 'mssql')).toBe('end')
    // PostgreSQL has transactional DDL — a CREATE inside a transaction stays in it.
    expect(txnEffect('CREATE TABLE t (id int)', 'postgres')).toBeNull()
    expect(txnEffect('CREATE TABLE t (id int)', 'sqlite')).toBeNull()
  })

  it('Oracle: BEGIN … END is PL/SQL, not a transaction', () => {
    expect(txnEffect('BEGIN NULL; END;', 'oracle')).toBeNull()
    expect(txnEffect('BEGIN', 'oracle')).toBeNull()
    expect(txnEffect('COMMIT', 'oracle')).toBe('end')
    expect(txnEffect('CREATE TABLE t (id NUMBER)', 'oracle')).toBe('end')
  })

  it('supportsTxn covers the SQL engines only', () => {
    expect(supportsTxn('postgres')).toBe(true)
    expect(supportsTxn('mysql')).toBe(true)
    expect(supportsTxn('clickhouse')).toBe(false)
    expect(supportsTxn('mongodb')).toBe(false)
    expect(supportsTxn('cassandra')).toBe(false)
  })
})
