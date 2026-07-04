import { describe, expect, it } from 'vitest'
import {
  optimizeFinal,
  showPartitions,
  showEngine,
  showMutations,
  detachPartition,
  dropPartition,
  freezePartition,
  mutationUpdate,
  mutationDelete,
  needsFinal,
} from './chops'

describe('ClickHouse ops SQL', () => {
  it('OPTIMIZE … FINAL, qualifies non-default schema', () => {
    expect(optimizeFinal('default', 'lms_events')).toBe('OPTIMIZE TABLE `lms_events` FINAL;')
    expect(optimizeFinal('analytics', 'lms_events')).toBe('OPTIMIZE TABLE `analytics`.`lms_events` FINAL;')
  })
  it('Show Partitions queries system.parts', () => {
    const s = showPartitions('lms_events')
    expect(s).toContain('FROM system.parts')
    expect(s).toContain("WHERE table = 'lms_events' AND active")
  })
  it('Show Engine queries system.tables', () => {
    expect(showEngine('t')).toContain('FROM system.tables')
  })
  it('Show Mutations queries system.mutations', () => {
    expect(showMutations('t')).toContain('FROM system.mutations')
    expect(showMutations('t')).toContain("WHERE table = 't'")
  })
  it('DETACH / DROP / FREEZE partition', () => {
    expect(detachPartition('', 't')).toBe("ALTER TABLE `t` DETACH PARTITION '202606';")
    expect(dropPartition('', 't')).toBe("ALTER TABLE `t` DROP PARTITION '202606';")
    expect(freezePartition('', 't')).toBe("ALTER TABLE `t` FREEZE PARTITION '202606';")
  })
  it('mutation UPDATE/DELETE are ALTER TABLE async', () => {
    expect(mutationUpdate('', 't', "status = 'x'", 'id = 1')).toBe("ALTER TABLE `t` UPDATE status = 'x' WHERE id = 1;")
    expect(mutationDelete('', 't', 'id = 1')).toBe('ALTER TABLE `t` DELETE WHERE id = 1;')
  })
  it('needsFinal true only for merge-on-key engines', () => {
    expect(needsFinal('ReplacingMergeTree')).toBe(true)
    expect(needsFinal('SummingMergeTree((v))')).toBe(true)
    expect(needsFinal('MergeTree')).toBe(false)
    expect(needsFinal(undefined)).toBe(false)
  })
})
