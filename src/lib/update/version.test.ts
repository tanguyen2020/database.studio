import { describe, it, expect } from 'vitest'
import {
  compareVersions,
  formatBytes,
  isNewer,
  mayPrompt,
  parseVersion,
  progressPercent,
} from './version'

describe('parseVersion', () => {
  it('reads a release and a pre-release', () => {
    expect(parseVersion('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3, pre: [] })
    expect(parseVersion('0.1.0-beta.11')).toEqual({ major: 0, minor: 1, patch: 0, pre: ['beta', '11'] })
  })

  it('tolerates a leading v (git tags) and build metadata', () => {
    expect(parseVersion('v0.1.0-beta.12')?.pre).toEqual(['beta', '12'])
    expect(parseVersion('1.0.0+build.5')?.major).toBe(1)
  })

  it('rejects nonsense', () => {
    expect(parseVersion('')).toBeNull()
    expect(parseVersion('latest')).toBeNull()
  })
})

describe('compareVersions', () => {
  it('orders numeric pre-release identifiers numerically', () => {
    // the trap: a string compare puts beta.9 above beta.11 and the update is never offered
    expect(compareVersions('0.1.0-beta.11', '0.1.0-beta.9')).toBe(1)
    expect(isNewer('0.1.0-beta.12', '0.1.0-beta.11')).toBe(true)
    expect(isNewer('0.1.0-beta.9', '0.1.0-beta.11')).toBe(false)
  })

  it('treats a pre-release as older than the same final version', () => {
    expect(isNewer('0.1.0', '0.1.0-beta.11')).toBe(true)
    expect(isNewer('0.1.0-beta.11', '0.1.0')).toBe(false)
  })

  it('orders major/minor/patch first', () => {
    expect(isNewer('0.2.0-beta.1', '0.1.0')).toBe(true)
    expect(isNewer('1.0.0', '0.9.9')).toBe(true)
    expect(compareVersions('0.1.0-beta.11', '0.1.0-beta.11')).toBe(0)
  })

  it('never claims equal versions are newer (no update loop)', () => {
    expect(isNewer('0.1.0-beta.11', '0.1.0-beta.11')).toBe(false)
    expect(isNewer('v0.1.0-beta.11', '0.1.0-beta.11')).toBe(false)
  })

  it('sorts alphanumeric tags after numeric ones, per semver', () => {
    expect(isNewer('0.1.0-rc.1', '0.1.0-beta.11')).toBe(true)
    expect(isNewer('0.1.0-beta.2', '0.1.0-2')).toBe(true)
  })
})

describe('formatBytes', () => {
  it('formats a download size', () => {
    expect(formatBytes(980 * 1024)).toBe('980 KB')
    expect(formatBytes(12.4 * 1024 * 1024)).toBe('12.4 MB')
    expect(formatBytes(120 * 1024 * 1024)).toBe('120 MB')
  })

  it('returns empty when the server sent no length', () => {
    expect(formatBytes(undefined)).toBe('')
    expect(formatBytes(0)).toBe('')
    expect(formatBytes(NaN)).toBe('')
  })
})

describe('progressPercent', () => {
  it('clamps to 0..100 and rounds', () => {
    expect(progressPercent(0, 100)).toBe(0)
    expect(progressPercent(50, 200)).toBe(25)
    expect(progressPercent(300, 200)).toBe(100)
  })

  it('is null when the total is unknown (indeterminate bar)', () => {
    expect(progressPercent(1234, undefined)).toBeNull()
    expect(progressPercent(1234, 0)).toBeNull()
  })
})

describe('mayPrompt', () => {
  it('prompts for a version that was never skipped', () => {
    expect(mayPrompt('0.1.0-beta.12', null, false)).toBe(true)
  })

  it('stays quiet for the exact skipped version, but not for the next one', () => {
    expect(mayPrompt('0.1.0-beta.12', '0.1.0-beta.12', false)).toBe(false)
    expect(mayPrompt('0.1.0-beta.13', '0.1.0-beta.12', false)).toBe(true)
  })

  it('stays quiet for the rest of the run after "Later"', () => {
    expect(mayPrompt('0.1.0-beta.12', null, true)).toBe(false)
  })
})
