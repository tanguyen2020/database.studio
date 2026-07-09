import { describe, expect, it } from 'vitest'
import { formatBytes } from './bytes'

describe('formatBytes', () => {
  it('unknown/negative → em dash', () => {
    expect(formatBytes(null)).toBe('—')
    expect(formatBytes(undefined)).toBe('—')
    expect(formatBytes(NaN)).toBe('—')
    expect(formatBytes(-1)).toBe('—')
  })

  it('zero and raw bytes', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1023)).toBe('1023 B')
  })

  it('rounds to 1024-based units, drops trailing .0', () => {
    expect(formatBytes(1024)).toBe('1 KB')
    expect(formatBytes(16384)).toBe('16 KB')
    expect(formatBytes(65536)).toBe('64 KB')
    expect(formatBytes(1024 * 1024)).toBe('1 MB')
    expect(formatBytes(1114112)).toBe('1.1 MB') // matches the demo "students" table
    expect(formatBytes(3686400)).toBe('3.5 MB')
    expect(formatBytes(1024 * 1024 * 1024)).toBe('1 GB')
  })
})
