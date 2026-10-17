import { describe, expect, it } from 'vitest'
import { analyzePayload, payloadCount, payloadSize } from './payload'

describe('analyzePayload', () => {
  it('pretty-prints JSON objects and counts their keys', () => {
    const i = analyzePayload('{"id":1,"tags":["a","b"]}')
    expect(i.isJson).toBe(true)
    expect(i.shape).toBe('object')
    expect(i.count).toBe(2)
    expect(i.pretty).toBe('{\n  "id": 1,\n  "tags": [\n    "a",\n    "b"\n  ]\n}')
    expect(i.lines).toBe(7)
    expect(i.raw).toBe('{"id":1,"tags":["a","b"]}')
    expect(payloadCount(i)).toBe('2 keys')
  })

  it('arrays and scalars are JSON too', () => {
    expect(analyzePayload('[1,2,3]')).toMatchObject({ isJson: true, shape: 'array', count: 3 })
    expect(payloadCount(analyzePayload('[1]'))).toBe('1 item')
    expect(analyzePayload('42')).toMatchObject({ isJson: true, shape: 'value' })
    expect(payloadCount(analyzePayload('42'))).toBe('')
  })

  it('anything else stays exactly as received', () => {
    const i = analyzePayload('hello\nworld')
    expect(i).toMatchObject({ isJson: false, shape: 'text', pretty: 'hello\nworld', lines: 2 })
    expect(analyzePayload('')).toMatchObject({ isJson: false, shape: 'empty', lines: 0 })
    expect(analyzePayload('{broken')).toMatchObject({ isJson: false, shape: 'text' })
  })

  it('measures size in UTF-8 bytes', () => {
    expect(analyzePayload('é').bytes).toBe(2)
    expect(payloadSize(512)).toBe('512 B')
    expect(payloadSize(12_700)).toBe('12.4 KB')
    expect(payloadSize(3 * 1024 * 1024)).toBe('3.0 MB')
  })
})
