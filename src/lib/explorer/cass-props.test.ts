import { describe, expect, it } from 'vitest'
import { cassandraProps } from './cass-props'

describe('Cassandra / ScyllaDB Properties footer', () => {
  it('names objects instead of showing the raw tree key', () => {
    expect(cassandraProps('cass:t:campus_ks:orders')).toEqual({ type: 'Table', schema: 'campus_ks', name: 'orders', scopeLabel: 'keyspace' })
    expect(cassandraProps('cass:ks:campus_ks')).toMatchObject({ type: 'Keyspace', name: 'campus_ks', schema: '' })
    expect(cassandraProps('cass:c:campus_ks:orders.total')).toMatchObject({ type: 'Column', schema: 'campus_ks', name: 'orders.total' })
    expect(cassandraProps('cass:v:ks:by_name')).toMatchObject({ type: 'Materialized view', name: 'by_name' })
    expect(cassandraProps('cass:f:ks:avg_state(double, double)')).toMatchObject({ type: 'Function', name: 'avg_state' })
    expect(cassandraProps('cass:cdc:ks:orders')).toMatchObject({ type: 'Change log', name: 'orders' })
  })
  it('folders and setting rows are navigation, not objects', () => {
    for (const k of ['cass:tables:ks', 'cass:views:ks', 'cass:repl:ks', 'cass:dist:ks', 'cass:idx:ks']) expect(cassandraProps(k)).toBeNull()
    expect(cassandraProps('t:public.students')).toBeNull()
  })
})
