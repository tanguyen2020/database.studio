import { describe, expect, it } from 'vitest'
import {
  ADMIN_BUILTIN_ROLES,
  DB_BUILTIN_ROLES,
  hasRole,
  parseRoleRef,
  parseRolesCsv,
  presetRole,
  roleLabel,
} from './mongodb'

describe('mongodb user helpers', () => {
  it('parseRoleRef / roleLabel', () => {
    expect(parseRoleRef('read@appdb')).toEqual({ role: 'read', db: 'appdb' })
    expect(parseRoleRef('root@admin')).toEqual({ role: 'root', db: 'admin' })
    expect(parseRoleRef('nope')).toBeNull()
    expect(roleLabel({ role: 'readWrite', db: 'x' })).toBe('readWrite@x')
  })

  it('parseRolesCsv', () => {
    expect(parseRolesCsv('read@appdb, readWrite@other')).toEqual([
      { role: 'read', db: 'appdb' },
      { role: 'readWrite', db: 'other' },
    ])
    expect(parseRolesCsv('')).toEqual([])
  })

  it('hasRole', () => {
    const roles = [{ role: 'read', db: 'appdb' }]
    expect(hasRole(roles, 'read', 'appdb')).toBe(true)
    expect(hasRole(roles, 'readWrite', 'appdb')).toBe(false)
    expect(hasRole(roles, 'read', 'other')).toBe(false)
  })

  it('presetRole maps to built-in roles', () => {
    expect(presetRole('read-only')).toBe('read')
    expect(presetRole('read-write')).toBe('readWrite')
    expect(presetRole('admin')).toBe('dbAdmin')
    expect(presetRole('owner')).toBe('dbOwner')
  })

  it('role catalogs are non-empty and distinct', () => {
    expect(DB_BUILTIN_ROLES).toContain('read')
    expect(ADMIN_BUILTIN_ROLES).toContain('root')
    expect(new Set(DB_BUILTIN_ROLES).size).toBe(DB_BUILTIN_ROLES.length)
  })
})
