import { test, expect } from 'claude-code/testing'

import { parseProgram, ScriptError } from './lang'

// Runs source and returns what its result() function answers.
const run = (source: string, budget = 1_000_000) => {
  const program = parseProgram(source)
  program.start({}, budget)

  return program.call('result', [], {}, budget)
}

test('built-in objects cannot be changed by one scene for the next', () => {
  expect(() => run('function result() { Math.floor = x => 42; return Math.floor(1.5) }')).toThrow(ScriptError)
  expect(() => run('function result() { Object.keys = () => []; return 1 }')).toThrow(ScriptError)
  expect(() => run('function result() { Object.assign(Math, {PI: 3}); return 1 }')).toThrow(ScriptError)
  expect(() => run('function result() { Math.PI++ }')).toThrow(ScriptError)
  expect(run('function result() { return Math.floor(1.5) }')).toBe(1)
  expect(run('function result() { return Math.PI }')).toBe(Math.PI)
})

test('optional chaining short-circuits the rest of the chain', () => {
  expect(run('const o = null; function result() { return [o?.f(), o?.a.b, o?.a[0], o?.a.b.c(), o?.["x"].y] }')).toEqual([undefined, undefined, undefined, undefined, undefined])
  expect(run('const o = {a: {b: 2, f: () => 7}}; function result() { return [o?.a.b, o?.a.f(), o.a?.["b"], o.g?.()] }')).toEqual([2, 7, 2, undefined])
  expect(() => run('const o = {}; function result() { return o.a.b }')).toThrow(ScriptError)
})

test('rest syntax works in parameters and destructuring', () => {
  expect(run('const f = (a, ...r) => r; function result() { return f(1, 2, 3) }')).toEqual([2, 3])
  expect(run('function f(a, ...r) { return [a, r.length] } function result() { return f(1) }')).toEqual([1, 0])
  expect(run('function result() { const [a, ...r] = [1, 2, 3]; return [a, r] }')).toEqual([1, [2, 3]])
  expect(run('function result() { const {a, ...r} = {a: 1, b: 2, c: 3}; return [a, r] }')).toEqual([1, { b: 2, c: 3 }])
  expect(run('function result() { const [x, ...rest] = "hey"; return [x, rest] }')).toEqual(['h', ['e', 'y']])
})

test('destructuring assignment swaps and fills existing names', () => {
  expect(run('function result() { let a = 1, b = 2; [a, b] = [b, a]; return [a, b] }')).toEqual([2, 1])
  expect(run('function result() { let x, y, rest; ({x, y, ...rest} = {x: 1, y: 2, z: 3}); return [x, y, rest] }')).toEqual([1, 2, { z: 3 }])
  expect(run('function result() { const o = {}; let b; [o.a, b = 5] = [1]; return [o.a, b] }')).toEqual([1, 5])
  expect(() => parseProgram('1 = 2')).toThrow(ScriptError)
})

test('var is function-scoped and hoisted', () => {
  expect(run('function result() { for (var i = 0; i < 3; i++) {} return i }')).toBe(3)
  expect(run('function result() { if (true) { var x = 5 } return x }')).toBe(5)
  expect(run('function result() { const before = x; var x = 1; return before }')).toBeUndefined()
  expect(run('function result() { var out = []; for (var k in {a: 1}) {} out.push(k); return out }')).toEqual(['a'])
  expect(() => run('function result() { { let y = 1 } return y }')).toThrow('y is not defined')
  expect(run('var top = 1; function result() { return top }')).toBe(1)
  expect(run('function f() { var hidden = 1; return hidden } function result() { f(); return typeof hidden }')).toBe('undefined')
})

test('indexOf, lastIndexOf and includes honor fromIndex', () => {
  expect(run('function result() { const a = [1, 2, 1, 2]; return [a.indexOf(1, 1), a.lastIndexOf(2, 2), a.includes(1, 3), a.lastIndexOf(2)] }')).toEqual([2, 1, false, 3])
  expect(run('function result() { const s = "abab"; return [s.indexOf("a", 1), s.lastIndexOf("b", 2), s.includes("a", 3)] }')).toEqual([2, 1, false])
})

test('a named function expression can call itself by name', () => {
  expect(run('const f = function go(n) { return n ? n * go(n - 1) : 1 }; function result() { return [f(5), typeof go] }')).toEqual([120, 'undefined'])
  expect(run('function result() { const o = {k() { return typeof k }}; return o.k() }')).toBe('undefined')
})

test('string escapes cover \\r, \\xXX, \\uXXXX and \\u{...}', () => {
  expect(run('function result() { return "\\u2588" }')).toBe('█')
  expect(run('function result() { return `\\u{1F600}` }')).toBe('\u{1F600}')
  expect(run('function result() { return "\\x41\\r\\n\\t\\\\\\"" }')).toBe('A\r\n\t\\"')
  expect(run('function result() { return "\\q\\u12" }')).toBe('qu12')
})

test('template literals may hold strings with braces', () => {
  expect(run('function result() { return `${"}"}-${"{"}` }')).toBe('}-{')
  expect(run("function result() { return `${'a}b'}` }")).toBe('a}b')
  expect(run('function result() { return `a${`b${"}"}c`}d` }')).toBe('ab}cd')
  expect(run('function result() { return `${{x: 1}.x}` }')).toBe('1')
})

test('objects, arrays and functions have a string form', () => {
  expect(run('function result() { const o = {a: 1}; return [`${o}`, "" + o, String(o), String([1, [2, 3], null]), [1, 2] + "", `${[]}`] }')).toEqual(['[object Object]', '[object Object]', '[object Object]', '1,2,3,', '1,2', ''])
  expect(run('function result() { return [1, {a: 1}].join("|") }')).toBe('1|[object Object]')
  expect(run('function result() { return typeof String(() => 1) }')).toBe('string')
})

test('parse failures are always script errors', () => {
  expect(() => parseProgram('('.repeat(6000))).toThrow(ScriptError)
  expect(() => parseProgram('`${')).toThrow(ScriptError)
  expect(() => parseProgram('"abc')).toThrow(ScriptError)
})

test('host methods over big values spend fuel in proportion', () => {
  const big = 'const a = Array(100000).fill(0);'
  expect(() => run(`${big} function result() { for (let i = 0; i < 20000; i++) a.slice() }`, 150_000)).toThrow('took too long')
  expect(() => run(`${big} function result() { for (let i = 0; i < 20000; i++) a.indexOf(-1) }`, 150_000)).toThrow('took too long')
  expect(() => run(`${big} function result() { for (let i = 0; i < 20000; i++) [...a] }`, 150_000)).toThrow('took too long')
  expect(() => run('const s = "x".repeat(100000); function result() { for (let i = 0; i < 20000; i++) s.split("") }', 150_000)).toThrow('took too long')
  expect(() => run('function result() { for (let i = 0; i < 20000; i++) Array(100000) }', 150_000)).toThrow('took too long')
  expect(() => run('const a = Array(100000).fill(1); function result() { for (let i = 0; i < 2000; i++) a.sort() }', 150_000)).toThrow('took too long')
  // Ordinary scene work still fits comfortably.
  expect(run('function result() { let n = 0; for (let i = 0; i < 2000; i++) n += [1, 2, 3].slice(1).concat([4]).indexOf(4); return n }', 150_000)).toBe(4000)
})

test('strings and arrays cannot outgrow the limit through any method', () => {
  expect(() => run('function result() { let s = "x"; for (let i = 0; i < 40; i++) s = `${s}${s}`; return s.length }')).toThrow('too big')
  expect(() => run('function result() { return Array(1000).fill(Array(1000).fill(0)).flat().length }')).toThrow('too big')
  expect(() => run('function result() { const a = Array(60000).fill(0); return a.concat(a).length }')).toThrow('too big')
  expect(() => run('function result() { return Array(100000).fill("xx").join("") }')).toThrow('too big')
  expect(() => run('function result() { return "a".repeat(50000).replaceAll("a", "bbb") }')).toThrow('too big')
  expect(run('function result() { return "a".repeat(3).replaceAll("a", "bb") }')).toBe('bbbbbb')
})

test('small corners: splice with no arguments, numeric separators', () => {
  expect(run('function result() { const a = [1, 2, 3]; const r = a.splice(); return [a, r] }')).toEqual([[1, 2, 3], []])
  expect(run('function result() { const a = [1, 2, 3]; return [a.splice(1), a] }')).toEqual([[2, 3], [1]])
  expect(run('function result() { return [1_000, 0x_ff, 1_0.5_0] }')).toEqual([1000, 255, 10.5])
})

test('for loops keep per-turn bindings only when closures need them', () => {
  expect(run('function result() { const fs = []; for (let i = 0; i < 3; i++) fs.push(() => i); return fs.map(f => f()) }')).toEqual([0, 1, 2])
  expect(run('function result() { let s = 0; for (let i = 0; i < 100; i++) s += i; return s }')).toBe(4950)
  expect(run('function result() { const a = []; a.push(1); a.push(2, 3); "abc".toUpperCase(); return [a, "abc".toUpperCase(), a.map(x => x * 2), a?.slice(1)] }')).toEqual([[1, 2, 3], 'ABC', [2, 4, 6], [2, 3]])
  expect(() => run('function result() { return [].nope() }')).toThrow('nope is not a function')
})
