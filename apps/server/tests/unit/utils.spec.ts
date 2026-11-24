import { describe, expect, it } from 'vitest'
import {
  LISTEN_ADDRESS,
  isObject,
  mergeDeep,
  toCommandArgsArray,
  toRecord,
  toStringArray,
  toStringRecord
} from '../../src/utils.js'

/** Plain class whose instances are regular objects. */
class Sample {
  value = 1
}

const NON_COLLECTIONS: unknown[] = [null, undefined, 'text', '', 0, 42, true, false, Symbol('id'), BigInt(1), () => 'x']

describe('LISTEN_ADDRESS', () => {
  it('is the IPv4 loopback address', () => {
    expect(LISTEN_ADDRESS).toBe('127.0.0.1')
  })
})

describe('isObject', () => {
  it.each([
    {},
    { key: 'value' },
    { nested: { key: 1 } },
    Object.create(null) as unknown,
    new Sample()
  ])('accepts the object %o', value => {
    expect(isObject(value)).toBe(true)
  })

  it.each([[[]], [['a', 'b']], [[{ key: 1 }]]])('rejects the array %o', value => {
    expect(isObject(value)).toBe(false)
  })

  it.each(NON_COLLECTIONS)('rejects %o', value => {
    expect(isObject(value)).toBe(false)
  })
})

describe('mergeDeep', () => {
  it('returns the target itself when no source is given', () => {
    const target = { a: 1 }

    expect(mergeDeep(target)).toBe(target)
    expect(target).toEqual({ a: 1 })
  })

  it('mutates and returns the target', () => {
    const target: Record<string, unknown> = { a: 1 }
    const result = mergeDeep(target, { b: 2 })

    expect(result).toBe(target)
    expect(target).toEqual({ a: 1, b: 2 })
  })

  it('overrides top-level values with the source values', () => {
    expect(mergeDeep({ a: 1, b: 'x', c: true }, { a: 2, c: false })).toEqual({ a: 2, b: 'x', c: false })
  })

  it('leaves the target unchanged with an empty source', () => {
    expect(mergeDeep({ a: { b: 1 } }, {})).toEqual({ a: { b: 1 } })
  })

  it('merges nested objects recursively', () => {
    const target = { server: { port: 80, host: 'a', tls: { enabled: false, cert: 'c' } } }
    const source = { server: { port: 443, tls: { enabled: true } } }

    expect(mergeDeep(target, source)).toEqual({
      server: { port: 443, host: 'a', tls: { enabled: true, cert: 'c' } }
    })
  })

  it('keeps the nested target objects by reference', () => {
    const nested = { a: 1 }
    const target = { nested }

    mergeDeep(target, { nested: { b: 2 } })

    expect(target.nested).toBe(nested)
    expect(nested).toEqual({ a: 1, b: 2 })
  })

  it('copies nested source objects instead of sharing them', () => {
    const source = { nested: { deep: { a: 1 } } }
    const target: Record<string, unknown> = {}

    mergeDeep(target, source)

    expect(target).toEqual(source)
    expect(target.nested).not.toBe(source.nested)
    expect((target.nested as Record<string, unknown>).deep).not.toBe(source.nested.deep)
  })

  it('does not mutate the sources', () => {
    const first = { a: { b: 1 }, list: [1] }
    const second = { a: { c: 2 }, list: [2] }

    mergeDeep({}, first, second)

    expect(first).toEqual({ a: { b: 1 }, list: [1] })
    expect(second).toEqual({ a: { c: 2 }, list: [2] })
  })

  it.each([
    ['a primitive', 'text'],
    ['a number', 3],
    ['null', null],
    ['an array', [1, 2]],
    ['undefined', undefined]
  ])('replaces %s target value with a source object', (_label, value) => {
    expect(mergeDeep({ key: value }, { key: { a: 1 } })).toEqual({ key: { a: 1 } })
  })

  it.each([
    ['a string', 'text'],
    ['a number', 0],
    ['a boolean', false],
    ['null', null],
    ['an array', ['x']]
  ])('replaces a target object with %s source value', (_label, value) => {
    expect(mergeDeep({ key: { a: 1 } }, { key: value })).toEqual({ key: value })
  })

  it('replaces arrays instead of merging them', () => {
    expect(mergeDeep({ list: [1, 2, 3] }, { list: [4] })).toEqual({ list: [4] })
  })

  it('applies several sources from left to right', () => {
    expect(mergeDeep({ a: 0 }, { a: 1, b: 1 }, { b: 2, c: 2 }, { c: 3 })).toEqual({ a: 1, b: 2, c: 3 })
  })

  it('merges nested objects across several sources', () => {
    const result = mergeDeep(
      { adt: { notifications: true }, loadBalancers: {} },
      { adt: { hosts: ['a'] }, loadBalancers: { main: { port: 1 } } },
      { adt: { ports: { server: 2 } } }
    )

    expect(result).toEqual({
      adt: { notifications: true, hosts: ['a'], ports: { server: 2 } },
      loadBalancers: { main: { port: 1 } }
    })
  })

  it('merges a source created without a prototype', () => {
    const source = Object.create(null) as Record<string, unknown>
    source.a = { b: 1 }

    expect(mergeDeep({ a: { c: 2 } }, source)).toEqual({ a: { b: 1, c: 2 } })
  })

  it('merges into a target created without a prototype', () => {
    const target = Object.create(null) as Record<string, unknown>
    target.a = 1

    mergeDeep(target, { b: { c: 2 } })

    expect({ ...target }).toEqual({ a: 1, b: { c: 2 } })
  })

  it('stores keys named after inherited members as own data', () => {
    const target: Record<string, unknown> = {}

    mergeDeep(target, { toString: { a: 1 }, constructor: 'value', hasOwnProperty: 3 })

    expect(Object.keys(target).sort()).toEqual(['constructor', 'hasOwnProperty', 'toString'])
    expect(target.toString).toEqual({ a: 1 })
    expect(target.constructor).toBe('value')
    expect(target.hasOwnProperty).toBe(3)
    expect(typeof Object.prototype.toString).toBe('function')
  })

  it('leaves a non-object target untouched', () => {
    const target = ['a'] as unknown as Record<string, unknown>

    expect(mergeDeep(target, { b: 1 })).toBe(target)
    expect(target).toEqual(['a'])
  })

  it('skips a non-object source and applies the following ones', () => {
    const arraySource = ['ignored'] as unknown as Record<string, unknown>

    expect(mergeDeep({ a: 1 }, arraySource, { b: 2 })).toEqual({ a: 1, b: 2 })
  })

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a string', 'text'],
    ['a number', 0]
  ])('skips %s source and applies the following ones', (_label, value) => {
    const source = value as unknown as Record<string, unknown>

    expect(mergeDeep({ a: 1 }, source, { b: 2 })).toEqual({ a: 1, b: 2 })
  })

  it('ignores a top-level __proto__ key', () => {
    const target: Record<string, unknown> = {}

    mergeDeep(target, JSON.parse('{"__proto__":{"polluted":true},"a":1}') as Record<string, unknown>)

    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(Object.getPrototypeOf(target)).toBe(Object.prototype)
    expect(Object.keys(target)).toEqual(['a'])
  })

  it('ignores a nested __proto__ key', () => {
    const target: Record<string, unknown> = { nested: {} }

    mergeDeep(target, JSON.parse('{"nested":{"__proto__":{"polluted":true},"b":2}}') as Record<string, unknown>)

    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(Object.getPrototypeOf(target.nested)).toBe(Object.prototype)
    expect(target.nested).toEqual({ b: 2 })
  })

  it('ignores a __proto__ key holding a primitive', () => {
    const target: Record<string, unknown> = {}

    mergeDeep(target, JSON.parse('{"__proto__":null}') as Record<string, unknown>)

    expect(Object.getPrototypeOf(target)).toBe(Object.prototype)
  })

  it('keeps a constructor key holding a prototype as own data', () => {
    const target: Record<string, unknown> = {}

    mergeDeep(target, JSON.parse('{"constructor":{"prototype":{"polluted":true}}}') as Record<string, unknown>)

    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(target.constructor).toEqual({ prototype: { polluted: true } })
  })
})

describe('toRecord', () => {
  it('returns the object itself', () => {
    const value = { a: 1, nested: { b: 2 } }

    expect(toRecord(value)).toBe(value)
  })

  it('returns an object created without a prototype', () => {
    const value = Object.create(null) as Record<string, unknown>

    expect(toRecord(value)).toBe(value)
  })

  it.each([[[]], [['a']], [[{ a: 1 }]]])('returns an empty object for the array %o', value => {
    expect(toRecord(value)).toEqual({})
  })

  it.each(NON_COLLECTIONS)('returns an empty object for %o', value => {
    expect(toRecord(value)).toEqual({})
  })

  it('returns a new empty object on each fallback', () => {
    const first = toRecord(null)
    first.a = 1

    expect(toRecord(null)).toEqual({})
    expect(toRecord(null)).not.toBe(first)
  })
})

describe('toStringRecord', () => {
  it('copies an object of strings', () => {
    const value = { A: 'a', B: '', C: 'with space' }
    const result = toStringRecord(value)

    expect(result).toEqual(value)
    expect(result).not.toBe(value)
  })

  it('returns an empty record for an empty object', () => {
    expect(toStringRecord({})).toEqual({})
  })

  it.each([
    ['a number', 1],
    ['a boolean', true],
    ['null', null],
    ['undefined', undefined],
    ['an object', { a: 'b' }],
    ['an array', ['a']]
  ])('returns null when an object holds %s', (_label, item) => {
    expect(toStringRecord({ A: 'a', B: item })).toBeNull()
  })

  it('merges an array of string objects', () => {
    expect(toStringRecord([{ A: 'a' }, { B: 'b', C: 'c' }])).toEqual({ A: 'a', B: 'b', C: 'c' })
  })

  it('lets later array entries override earlier ones', () => {
    expect(toStringRecord([{ A: 'first', B: 'b' }, { A: 'second' }])).toEqual({ A: 'second', B: 'b' })
  })

  it('returns an empty record for an empty array', () => {
    expect(toStringRecord([])).toEqual({})
  })

  it('accepts empty objects inside an array', () => {
    expect(toStringRecord([{}, { A: 'a' }, {}])).toEqual({ A: 'a' })
  })

  it.each([
    ['a string', 'A=a'],
    ['null', null],
    ['undefined', undefined],
    ['a number', 1],
    ['a nested array', [{ A: 'a' }]]
  ])('returns null when an array holds %s', (_label, item) => {
    expect(toStringRecord([{ B: 'b' }, item])).toBeNull()
  })

  it('returns null when an array entry holds a non-string value', () => {
    expect(toStringRecord([{ A: 'a' }, { B: 2 }])).toBeNull()
  })

  it('does not mutate the input', () => {
    const value = [{ A: 'a' }, { A: 'b' }]

    toStringRecord(value)

    expect(value).toEqual([{ A: 'a' }, { A: 'b' }])
  })

  it.each(NON_COLLECTIONS)('returns null for %o', value => {
    expect(toStringRecord(value)).toBeNull()
  })
})

describe('toStringArray', () => {
  it('returns the array of strings itself', () => {
    const value = ['a', '', 'b c']

    expect(toStringArray(value)).toBe(value)
  })

  it('returns an empty array for an empty array', () => {
    expect(toStringArray([])).toEqual([])
  })

  it.each([
    ['a number', 1],
    ['a boolean', true],
    ['null', null],
    ['undefined', undefined],
    ['an object', { a: 'b' }],
    ['a nested array', ['a']]
  ])('returns null when the array holds %s', (_label, item) => {
    expect(toStringArray(['a', item])).toBeNull()
  })

  it('returns null for an array-like object', () => {
    expect(toStringArray({ 0: 'a', length: 1 })).toBeNull()
  })

  it('returns null for an object', () => {
    expect(toStringArray({ a: 'b' })).toBeNull()
  })

  it.each(NON_COLLECTIONS)('returns null for %o', value => {
    expect(toStringArray(value)).toBeNull()
  })
})

describe('toCommandArgsArray', () => {
  it('keeps strings in order', () => {
    expect(toCommandArgsArray(['run', '--flag', '', 'a b'])).toEqual(['run', '--flag', '', 'a b'])
  })

  it.each([
    [8080, '8080'],
    [0, '0'],
    [-0, '0'],
    [-1, '-1'],
    [1.5, '1.5']
  ])('converts the finite number %d to a string', (input, expected) => {
    expect(toCommandArgsArray([input])).toEqual([expected])
  })

  it('mixes strings and numbers', () => {
    expect(toCommandArgsArray(['--port', 3000, '--retries', 2])).toEqual(['--port', '3000', '--retries', '2'])
  })

  it('returns a new array', () => {
    const value = ['a', 'b']
    const result = toCommandArgsArray(value)

    expect(result).toEqual(value)
    expect(result).not.toBe(value)
  })

  it('returns an empty array for an empty array', () => {
    expect(toCommandArgsArray([])).toEqual([])
  })

  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY]
  ])('returns null for the non-finite number %s', (_label, item) => {
    expect(toCommandArgsArray(['a', item])).toBeNull()
  })

  it.each([
    ['a boolean', true],
    ['null', null],
    ['undefined', undefined],
    ['an object', { a: 'b' }],
    ['a nested array', ['a']],
    ['a bigint', BigInt(1)]
  ])('returns null when the array holds %s', (_label, item) => {
    expect(toCommandArgsArray(['a', item])).toBeNull()
  })

  it('returns null for an object', () => {
    expect(toCommandArgsArray({ 0: 'a', length: 1 })).toBeNull()
  })

  it.each(NON_COLLECTIONS)('returns null for %o', value => {
    expect(toCommandArgsArray(value)).toBeNull()
  })
})
