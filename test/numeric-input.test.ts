import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { NUMERIC, numericInput } from '../src/numeric.ts'
import { Terms } from '../src/view/terms.ts'
import { DataFactory } from 'n3'

const XSD = 'http://www.w3.org/2001/XMLSchema#'
const vectors = JSON.parse(readFileSync(new URL('./fixtures/numeric-rounding.json', import.meta.url), 'utf8')).vectors as { name: string; format: string; lexical: string; expected_bits: string }[]

export function ieeeBits(value: number, single: boolean): string {
  const view = new DataView(new ArrayBuffer(8))
  if (single) {
    view.setFloat32(0, value, false)
    return view.getUint32(0, false).toString(16).padStart(8, '0')
  }
  view.setFloat64(0, value, false)
  return view.getBigUint64(0, false).toString(16).padStart(16, '0')
}

describe('shared numeric input', () => {
  it.each(vectors)('$format $name', ({ lexical, format, expected_bits }) => {
    const single = format === 'binary32'
    const input = numericInput(lexical, XSD + (single ? 'float' : 'double'))
    expect(input.valid).toBe(true)
    if (input.valid) expect(ieeeBits(input.value, single)).toBe(expected_bits)
  })

  it('validates all sixteen families independently of native integer/decimal storage', () => {
    expect(NUMERIC.size).toBe(16)
    const bounds = [
      ['long', '-9223372036854775808', '9223372036854775807'],
      ['int', '-2147483648', '2147483647'], ['short', '-32768', '32767'], ['byte', '-128', '127'],
      ['unsignedLong', '0', '18446744073709551615'], ['unsignedInt', '0', '4294967295'],
      ['unsignedShort', '0', '65535'], ['unsignedByte', '0', '255'],
    ]
    for (const [family, lo, hi] of bounds) {
      for (const value of [lo!, hi!, '+000' + hi!]) expect(numericInput(value, XSD + family).valid).toBe(true)
      for (const value of [(BigInt(lo!) - 1n).toString(), (BigInt(hi!) + 1n).toString()]) expect(numericInput(value, XSD + family).valid).toBe(false)
    }
    for (const [family, valid, invalid] of [
      ['nonNegativeInteger', '-0', '-1'], ['positiveInteger', '1', '-0'],
      ['nonPositiveInteger', '+0', '1'], ['negativeInteger', '-1', '-0'],
    ]) {
      expect(numericInput(valid!, XSD + family).valid).toBe(true)
      expect(numericInput(invalid!, XSD + family).valid).toBe(false)
    }
    for (const family of ['integer', 'decimal']) expect(numericInput('9'.repeat(1000), XSD + family).valid).toBe(true)
    expect(numericInput('0.' + '0'.repeat(500) + '1', XSD + 'decimal').valid).toBe(true)
  })

  it('applies XML whitespace and the complete lexical grammar, including special values', () => {
    for (const family of NUMERIC) {
      const accepted = family.endsWith('#negativeInteger') || family.endsWith('#nonPositiveInteger') ? '-1' : '1'
      for (const value of [' \t\n\r' + accepted + '\r\n\t ', accepted]) expect(numericInput(value, family).valid).toBe(true)
      for (const value of ['', ' ', '0x10', '1 0', '\u00a01', '1\u00a0', '1_0', '1junk']) expect(numericInput(value, family).valid).toBe(false)
    }
    for (const value of ['INF', '+INF', '-INF', 'NaN', '1e2', '.5', '5.']) expect(numericInput(value, XSD + 'double').valid).toBe(true)
    for (const value of ['+NaN', '-NaN', 'Infinity', 'nan', '.', '1e', '1e+', '0e999999x']) expect(numericInput(value, XSD + 'double').valid).toBe(false)
    const nan = numericInput('NaN', XSD + 'float')
    expect(nan.valid && Number.isNaN(nan.value)).toBe(true)
    for (const family of ['float', 'double']) {
      const zero = numericInput('-0e999999999999999999999', XSD + family)
      expect(zero.valid && Object.is(zero.value, -0)).toBe(true)
    }
  })

  it('keeps term cache behavior while clearing a reused id', () => {
    const terms = new Terms()
    const id = terms.id(DataFactory.literal('1.000000059604644775390625000001', DataFactory.namedNode(XSD + 'float')))
    terms.retain(id)
    expect(ieeeBits(terms.number(id)!, true)).toBe('3f800001')
    terms.release(id)
    const reused = terms.id(DataFactory.literal('128', DataFactory.namedNode(XSD + 'byte')))
    expect(reused).toBe(id)
    expect(terms.number(reused)).toBeUndefined()
    terms.sweep()
    const nan = terms.id(DataFactory.literal('NaN', DataFactory.namedNode(XSD + 'double')))
    expect(terms.number(nan)).toBeUndefined()
  })

  it('compensates a long mantissa exponent and still validates overflowing tails', () => {
    const input = numericInput('0.' + '0'.repeat(100_000) + '1e100001', XSD + 'double')
    expect(input.valid && input.value).toBe(1)
    expect(numericInput('9'.repeat(100_000) + 'z', XSD + 'double').valid).toBe(false)
  })
})
