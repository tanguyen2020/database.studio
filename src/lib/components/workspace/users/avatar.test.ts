import { describe, expect, it } from 'vitest'
import { AVATAR_HUES, avatarHue, initialsOf } from './avatar'

describe('initialsOf', () => {
  it('takes the first letters of the first two words of an identifier', () => {
    expect(initialsOf('app_user')).toBe('AU')
    expect(initialsOf('svc.reporting')).toBe('SR')
    expect(initialsOf('read-only-group')).toBe('RO')
    expect(initialsOf('Jane Doe')).toBe('JD')
  })
  it('uses two letters of a single word', () => {
    expect(initialsOf('postgres')).toBe('PO')
    expect(initialsOf('APP_USER')).toBe('AU')
    expect(initialsOf('x')).toBe('X')
  })
  it('ignores the host / auth database and a Windows domain', () => {
    expect(initialsOf("app@'%'")).toBe('AP')
    expect(initialsOf('admin@admin')).toBe('AD')
    expect(initialsOf('CORP\\bob')).toBe('BO')
  })
  it('never returns an empty string', () => {
    expect(initialsOf('')).toBe('?')
    expect(initialsOf('___')).toBe('?')
  })
  it('handles non-ASCII names', () => {
    expect(initialsOf('nguyễn_văn')).toBe('NV')
  })
})

describe('avatarHue', () => {
  it('is stable per name and case-insensitive', () => {
    expect(avatarHue('app_user')).toBe(avatarHue('app_user'))
    expect(avatarHue('APP_USER')).toBe(avatarHue('app_user'))
    expect(AVATAR_HUES).toContain(avatarHue('anything'))
  })
  it('spreads names over several hues', () => {
    const hues = new Set(['postgres', 'app_user', 'readonly_group', 'reporting', 'etl', 'admin', 'svc_api', 'analyst'].map(avatarHue))
    expect(hues.size).toBeGreaterThan(3)
  })
})
