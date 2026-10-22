import { describe, expect, it } from 'vitest'
import { hexDump, hexPreview, payloadBytes } from './hex'

describe('hex view', () => {
  it('uses the UTF-8 bytes of text and the raw bytes of binary', () => {
    expect(Array.from(payloadBytes('{"a":1}'))).toEqual([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x31, 0x7d])
    // "é" is two bytes in UTF-8
    expect(Array.from(payloadBytes('é'))).toEqual([0xc3, 0xa9])
    // a payload that is not valid UTF-8 arrives as base64 of the original bytes
    expect(Array.from(payloadBytes('�\u0001', btoa(String.fromCharCode(0xff, 0x01))))).toEqual([0xff, 0x01])
    // a broken base64 copy never throws — it falls back to the text
    expect(Array.from(payloadBytes('A', '%%%'))).toEqual([0x41])
  })

  it('previews the first bytes on one line', () => {
    expect(hexPreview(payloadBytes('{"id":1}'))).toBe('7b 22 69 64 22 3a 31 7d')
    expect(hexPreview(new Uint8Array(30).fill(0xab), 4)).toBe('ab ab ab ab …')
    expect(hexPreview(new Uint8Array())).toBe('')
  })

  it('dumps offset, 16 bytes in two groups and the printable text', () => {
    const dump = hexDump(payloadBytes('{"id":1001,"note":"hello world"}'))
    const lines = dump.split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toBe('00000000  7b 22 69 64 22 3a 31 30  30 31 2c 22 6e 6f 74 65  |{"id":1001,"note|')
    expect(lines[1].startsWith('00000010  22 3a 22 68 65 6c 6c 6f  20 77 6f 72 6c 64 22 7d  |":"hello world"}|')).toBe(true)
    // short last row keeps the ASCII column aligned
    const short = hexDump(new Uint8Array([0x00, 0x41]))
    expect(short).toBe(`00000000  00 41${' '.repeat(3 * 6)}  ${' '.repeat(3 * 8 - 1)}  |.A|`)
  })

  it('stops at the limit and says how much is hidden', () => {
    const dump = hexDump(new Uint8Array(40), 32)
    expect(dump.split('\n')).toHaveLength(3)
    expect(dump).toContain('8 more bytes not shown')
  })
})
