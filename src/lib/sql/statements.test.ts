// Unit test statement splitter — tách theo `;` tôn trọng string/quoted ident/
// comment; offset/line/col chính xác để map lỗi tầng 2 về đúng vị trí document
// (QUERY_EDITOR_ERROR_HANDLING_ADDENDUM §2.3).

import { describe, expect, it } from 'vitest'
import { lineColToOffset, offsetToLineCol, splitStatements, statementAtOffset } from './statements'

describe('splitStatements', () => {
  it('tách nhiều statement theo ;', () => {
    const doc = 'SELECT 1;\nSELECT 2;\nSELECT 3'
    const out = splitStatements(doc)
    expect(out.map((s) => s.sql)).toEqual(['SELECT 1', 'SELECT 2', 'SELECT 3'])
  })

  it('không tách ; nằm trong string literal', () => {
    const out = splitStatements(`INSERT INTO t VALUES ('a;b');SELECT 1`)
    expect(out).toHaveLength(2)
    expect(out[0].sql).toBe(`INSERT INTO t VALUES ('a;b')`)
  })

  it("escape trong string: '' (doubled) và \\' (MySQL)", () => {
    const out = splitStatements(`SELECT 'it''s;ok';SELECT 'a\\';b';SELECT 3`)
    expect(out).toHaveLength(3)
    expect(out[0].sql).toBe(`SELECT 'it''s;ok'`)
    expect(out[1].sql).toBe(`SELECT 'a\\';b'`)
  })

  it('không tách ; trong quoted identifier "..." / `...` / [...]', () => {
    expect(splitStatements(`SELECT "a;b" FROM t;SELECT 1`)).toHaveLength(2)
    expect(splitStatements('SELECT `a;b` FROM t;SELECT 1')).toHaveLength(2)
    expect(splitStatements('SELECT [a;b] FROM t;SELECT 1')).toHaveLength(2)
  })

  it('không tách ; trong comment -- và /* */', () => {
    const out = splitStatements('SELECT 1 -- chú thích; vẫn là 1 câu\n;SELECT 2 /* x;y */;')
    expect(out.map((s) => s.sql)).toEqual(['SELECT 1 -- chú thích; vẫn là 1 câu', 'SELECT 2 /* x;y */'])
  })

  it('không tách ; bên trong BEGIN…END của CREATE FUNCTION/PROCEDURE', () => {
    const fn =
      'CREATE FUNCTION seq_next(seqCode VARCHAR(50)) RETURNS BIGINT\nBEGIN\n' +
      '  DECLARE sequence BIGINT;\n' +
      '  SELECT seq INTO sequence FROM sequences WHERE `code` = seqCode FOR UPDATE;\n' +
      '  UPDATE sequences SET seq = seq + 1 WHERE `code` = seqCode;\n' +
      '  RETURN sequence;\nEND'
    // whole routine = ONE statement; a trailing SELECT after it = a second one
    const out = splitStatements(`${fn};\nSELECT 1;`)
    expect(out).toHaveLength(2)
    expect(out[0].sql).toContain('BEGIN')
    expect(out[0].sql).toContain('RETURN sequence')
    expect(out[1].sql).toBe('SELECT 1')
  })

  it('nested block keywords: END IF/CASE/LOOP không đóng BEGIN sớm', () => {
    const proc =
      'CREATE PROCEDURE p()\nBEGIN\n  IF 1 = 1 THEN\n    SELECT 1;\n  END IF;\n' +
      '  CASE WHEN 1 THEN SELECT 2; END CASE;\nEND'
    const out = splitStatements(`${proc};\nSELECT 9;`)
    expect(out).toHaveLength(2)
    expect(out[0].sql).toContain('END CASE')
    expect(out[1].sql).toBe('SELECT 9')
  })

  it('BEGIN transaction không nuốt các câu sau (không phải routine body)', () => {
    const out = splitStatements('BEGIN;\nUPDATE t SET a = 1;\nCOMMIT;')
    expect(out.map((s) => s.sql)).toEqual(['BEGIN', 'UPDATE t SET a = 1', 'COMMIT'])
  })

  it('bỏ statement rỗng, trim nhưng giữ offset đúng', () => {
    const doc = '  SELECT 1 ;  ;   SELECT 2  '
    const out = splitStatements(doc)
    expect(out).toHaveLength(2)
    expect(out[0].from).toBe(2) // sau 2 space đầu
    expect(doc.slice(out[1].from, out[1].to)).toBe('SELECT 2')
  })

  it('startLine/startCol 1-based cho từng statement (cộng offset multi-statement)', () => {
    const doc = 'SELECT 1;\n\n  UPDATE t SET a=1;'
    const out = splitStatements(doc)
    expect(out[0].startLine).toBe(1)
    expect(out[0].startCol).toBe(1)
    expect(out[1].startLine).toBe(3)
    expect(out[1].startCol).toBe(3)
  })
})

describe('offset ↔ line/col', () => {
  it('offsetToLineCol', () => {
    expect(offsetToLineCol('SELECT\nx', 7)).toEqual({ line: 2, col: 1 })
    expect(offsetToLineCol('ab\ncd', 4)).toEqual({ line: 2, col: 2 })
  })

  it('lineColToOffset nghịch đảo', () => {
    const doc = 'ab\ncd\nef'
    expect(lineColToOffset(doc, 2, 2)).toBe(4)
    expect(doc[lineColToOffset(doc, 3, 1)]).toBe('e')
  })
})

describe('statementAtOffset (Ctrl+Enter)', () => {
  const doc = 'SELECT 1;\nSELECT 2;\nSELECT 3'

  it('cursor trong statement → statement đó', () => {
    expect(statementAtOffset(doc, 12)?.sql).toBe('SELECT 2')
  })

  it('cursor ở khoảng trắng giữa các câu → câu liền trước', () => {
    expect(statementAtOffset(doc, 9)?.sql).toBe('SELECT 1')
  })

  it('document rỗng → null', () => {
    expect(statementAtOffset('', 0)).toBeNull()
  })
})
