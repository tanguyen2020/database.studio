import { describe, expect, it } from 'vitest'
import { firstByName, messagesSection, opensWorkspace, WORKSPACE_SYSTEMS } from './workspace-systems'

describe('opensWorkspace', () => {
  it('is true for the four engines whose workspace tab is the view', () => {
    expect([...WORKSPACE_SYSTEMS].sort()).toEqual(['kafka', 'nats', 'rabbitmq', 'redis'])
    for (const s of WORKSPACE_SYSTEMS) expect(opensWorkspace(s)).toBe(true)
  })

  it('keeps an object tree for every other engine', () => {
    for (const s of ['postgres', 'mysql', 'mariadb', 'mssql', 'sqlite', 'oracle', 'duckdb', 'clickhouse', 'cassandra', 'mongodb', 'elasticsearch']) {
      expect(opensWorkspace(s)).toBe(false)
    }
  })

  it('treats a missing or unknown system as having a tree', () => {
    expect(opensWorkspace(undefined)).toBe(false)
    expect(opensWorkspace(null)).toBe(false)
    expect(opensWorkspace('')).toBe(false)
    expect(opensWorkspace('REDIS')).toBe(false) // system ids are lower case
  })
})

describe('messagesSection / firstByName', () => {
  it('opens each workspace on the list where messages or keys are read', () => {
    expect(messagesSection('kafka')).toBe('topics')
    expect(messagesSection('nats')).toBe('streams')
    expect(messagesSection('rabbitmq')).toBe('queues')
    expect(messagesSection('redis')).toBe('browser')
    expect(messagesSection('postgres')).toBe('overview')
    expect(messagesSection(undefined)).toBe('overview')
  })

  it('picks the first name in A to Z order, or nothing for an empty list', () => {
    expect(firstByName(['payments', 'enrollment.events'])).toBe('enrollment.events')
    expect(firstByName(['orders.us', 'orders.eu'])).toBe('orders.eu')
    expect(firstByName([])).toBeNull()
  })
})
