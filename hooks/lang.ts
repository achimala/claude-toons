// A small JavaScript-like language for scenes the buddy writes as code. The
// module's environment has no eval, and the code comes from a model reading
// the developer's repo, so it runs here, in an interpreter of its own: it sees
// only its own values and the functions handed to it, and every step spends
// fuel, so a runaway loop stops the scene rather than the terminal.
//
// What it knows: let/const/var, functions and arrow functions (closures),
// if/else, for, for-of, for-in, while, break/continue/return, numbers,
// strings and template literals, arrays, plain objects, destructuring, the
// usual operators, Math, and a whitelist of array and string methods.

// A value of the language: a number, string, boolean, null, undefined, array,
// plain object, or function.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type V = any

export class ScriptError extends Error {}

// ---------------------------------------------------------------- tokens

type Tok =
  | { k: 'num'; v: number; at: number }
  | { k: 'str'; v: string; at: number }
  | { k: 'tpl'; strs: string[]; exprs: string[]; at: number }
  | { k: 'id' | 'op' | 'eof'; v: string; at: number }

const OPS = [
  '>>>=', '===', '!==', '**=', '>>>', '<<=', '>>=', '...', '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '++', '--',
  '+=', '-=', '*=', '/=', '%=', '**', '<<', '>>', '&=', '|=', '^=', '&&=', '||=', '??=',
].sort((a, b) => b.length - a.length)
const SINGLE = '{}()[];,.?:+-*/%<>=!&|^~'

function lex(src: string): Tok[] {
  const toks: Tok[] = []
  let i = 0
  const fail = (what: string) => {
    throw new ScriptError(`${what} at line ${src.slice(0, i).split('\n').length}`)
  }
  while (i < src.length) {
    const c = src[i] as string
    if (/\s/.test(c)) {
      i++
    } else if (src.startsWith('//', i)) {
      while (i < src.length && src[i] !== '\n') i++
    } else if (src.startsWith('/*', i)) {
      const end = src.indexOf('*/', i + 2)
      i = end < 0 ? src.length : end + 2
    } else if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      const m = /^(0x[0-9a-f]+|0b[01]+|(\d+\.?\d*|\.\d+)(e[+-]?\d+)?)/i.exec(src.slice(i))
      const text = m?.[0] ?? c
      toks.push({ k: 'num', v: Number(text), at: i })
      i += text.length
    } else if (/[A-Za-z_$]/.test(c)) {
      const m = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(src.slice(i))
      const text = m?.[0] ?? c
      toks.push({ k: 'id', v: text, at: i })
      i += text.length
    } else if (c === '"' || c === "'") {
      const at = i
      let v = ''
      i++
      while (i < src.length && src[i] !== c) {
        if (src[i] === '\\') {
          i++
          v += unescape(src[i] ?? '')
        } else {
          v += src[i]
        }
        i++
      }
      if (i >= src.length) fail('unclosed string')
      i++
      toks.push({ k: 'str', v, at })
    } else if (c === '`') {
      const at = i
      const strs: string[] = []
      const exprs: string[] = []
      let v = ''
      i++
      while (i < src.length && src[i] !== '`') {
        if (src[i] === '\\') {
          i++
          v += unescape(src[i] ?? '')
          i++
        } else if (src.startsWith('${', i)) {
          strs.push(v)
          v = ''
          i += 2
          let depth = 1
          const start = i
          while (i < src.length && depth > 0) {
            if (src[i] === '{') depth++
            else if (src[i] === '}') depth--
            if (depth > 0) i++
          }
          exprs.push(src.slice(start, i))
          i++
        } else {
          v += src[i]
          i++
        }
      }
      if (i >= src.length) fail('unclosed template')
      i++
      strs.push(v)
      toks.push({ k: 'tpl', strs, exprs, at })
    } else {
      const op = OPS.find(o => src.startsWith(o, i)) ?? (SINGLE.includes(c) ? c : undefined)
      if (!op) fail(`unexpected "${c}"`)
      toks.push({ k: 'op', v: op as string, at: i })
      i += (op as string).length
    }
  }
  toks.push({ k: 'eof', v: '', at: src.length })

  return toks
}

const unescape = (c: string) => ({ n: '\n', t: '\t', r: '', '0': '\0' })[c] ?? c

// ---------------------------------------------------------------- syntax

type Node = { t: string; [key: string]: V }

const ASSIGN = new Set(['=', '+=', '-=', '*=', '/=', '%=', '**=', '<<=', '>>=', '>>>=', '&=', '|=', '^=', '&&=', '||=', '??='])
const BINARY: Record<string, number> = {
  '??': 1, '||': 2, '&&': 3, '|': 4, '^': 5, '&': 6,
  '==': 7, '!=': 7, '===': 7, '!==': 7,
  '<': 8, '>': 8, '<=': 8, '>=': 8, in: 8,
  '<<': 9, '>>': 9, '>>>': 9,
  '+': 10, '-': 10, '*': 11, '/': 11, '%': 11, '**': 12,
}

function parse(src: string): Node[] {
  const toks = lex(src)
  let p = 0
  const peek = (o = 0) => toks[Math.min(p + o, toks.length - 1)] as Tok
  const fail = (what: string): never => {
    throw new ScriptError(`${what} at line ${src.slice(0, peek().at).split('\n').length}`)
  }
  const is = (v: string, o = 0) => {
    const tok = peek(o)

    return (tok.k === 'op' || tok.k === 'id') && tok.v === v
  }
  const eat = (v: string) => {
    if (!is(v)) fail(`expected "${v}" but found "${'v' in peek() ? String((peek() as { v: unknown }).v) : peek().k}"`)
    p++
  }
  const maybe = (v: string) => (is(v) ? (p++, true) : false)
  const name = () => {
    const tok = peek()
    if (tok.k !== 'id') fail('expected a name')
    p++

    return (tok as { v: string }).v
  }
  const semi = () => {
    maybe(';')
  }

  function program(): Node[] {
    const body: Node[] = []
    while (peek().k !== 'eof') body.push(statement())

    return body
  }

  function block(): Node[] {
    eat('{')
    const body: Node[] = []
    while (!is('}')) {
      if (peek().k === 'eof') fail('missing "}"')
      body.push(statement())
    }
    eat('}')

    return body
  }

  function pattern(): Node {
    let target: Node
    if (maybe('[')) {
      const items: (Node | null)[] = []
      while (!is(']')) {
        if (is(',')) items.push(null)
        else items.push(pattern())
        if (!is(']')) eat(',')
      }
      eat(']')
      target = { t: 'arrPat', items }
    } else if (maybe('{')) {
      const props: [string, Node][] = []
      while (!is('}')) {
        const key = name()
        props.push([key, maybe(':') ? pattern() : withDefault({ t: 'id', name: key })])
        if (!is('}')) eat(',')
      }
      eat('}')
      target = { t: 'objPat', props }
    } else {
      target = { t: 'id', name: name() }
    }

    return withDefault(target)
  }
  function withDefault(target: Node): Node {
    return maybe('=') ? { t: 'default', target, def: assign() } : target
  }

  function declaration(): Node {
    const kind = name()
    const decls: [Node, Node | undefined][] = []
    do {
      const target = pattern()
      decls.push(target.t === 'default' ? [target.target, target.def] : [target, undefined])
    } while (maybe(','))

    return { t: 'decl', kind, decls }
  }

  function params(): Node[] {
    eat('(')
    const list: Node[] = []
    while (!is(')')) {
      list.push(pattern())
      if (!is(')')) eat(',')
    }
    eat(')')

    return list
  }

  function statement(): Node {
    const tok = peek()
    if (is('{')) return { t: 'block', body: block() }
    if (is(';')) {
      p++

      return { t: 'empty' }
    }
    if (tok.k === 'id') {
      switch (tok.v) {
        case 'let':
        case 'const':
        case 'var': {
          const d = declaration()
          semi()

          return d
        }
        case 'function': {
          p++
          const fnName = name()

          return { t: 'fnDecl', name: fnName, fn: { t: 'fn', name: fnName, params: params(), body: block() } }
        }
        case 'if': {
          p++
          eat('(')
          const test = expression()
          eat(')')
          const then = statement()

          return { t: 'if', test, then, otherwise: maybe('else') ? statement() : undefined }
        }
        case 'while': {
          p++
          eat('(')
          const test = expression()
          eat(')')

          return { t: 'while', test, body: statement() }
        }
        case 'do': {
          p++
          const body = statement()
          eat('while')
          eat('(')
          const test = expression()
          eat(')')
          semi()

          return { t: 'doWhile', test, body }
        }
        case 'for': {
          p++
          eat('(')
          const isDecl = is('let') || is('const') || is('var')
          if (isDecl && (is('of', 2) || is('in', 2) || peek(1).k === 'op')) {
            // for (const x of xs), for (const [a, b] of xs), for (const k in o)
            const save = p
            const kind = name()
            const target = pattern()
            if (is('of') || is('in')) {
              const each = name()
              const iter = expression()
              eat(')')

              return { t: each === 'of' ? 'forOf' : 'forIn', kind, target, iter, body: statement() }
            }
            p = save
          }
          const init = is(';') ? undefined : isDecl ? declaration() : { t: 'expr', e: expression() }
          eat(';')
          const test = is(';') ? undefined : expression()
          eat(';')
          const update = is(')') ? undefined : expression()
          eat(')')

          return { t: 'for', init, test, update, body: statement() }
        }
        case 'switch': {
          p++
          eat('(')
          const disc = expression()
          eat(')')
          eat('{')
          const cases: { test?: Node; body: Node[] }[] = []
          while (!is('}')) {
            let test: Node | undefined
            if (maybe('case')) test = expression()
            else eat('default')
            eat(':')
            const body: Node[] = []
            while (!is('case') && !is('default') && !is('}')) {
              if (peek().k === 'eof') fail('missing "}"')
              body.push(statement())
            }
            cases.push({ test, body })
          }
          eat('}')

          return { t: 'switch', disc, cases }
        }
        case 'return': {
          p++
          const value = is(';') || is('}') ? undefined : expression()
          semi()

          return { t: 'return', value }
        }
        case 'break':
        case 'continue':
          p++
          semi()

          return { t: tok.v }
      }
    }
    const e = expression()
    semi()

    return { t: 'expr', e }
  }

  function expression(): Node {
    let e = assign()
    while (maybe(',')) e = { t: 'seq', a: e, b: assign() }

    return e
  }

  // An arrow function starts here: x =>, () =>, (a, b) =>, ([a, b]) =>.
  function isArrow(): boolean {
    if (peek().k === 'id' && is('=>', 1)) return true
    if (!is('(')) return false
    let depth = 0
    for (let o = 0; ; o++) {
      const tok = peek(o)
      if (tok.k === 'eof') return false
      if (tok.k === 'op' && ['(', '[', '{'].includes(tok.v)) depth++
      if (tok.k === 'op' && [')', ']', '}'].includes(tok.v)) depth--
      if (depth === 0) return is('=>', o + 1)
    }
  }

  function assign(): Node {
    if (isArrow()) {
      const list = peek().k === 'id' ? [{ t: 'id', name: name() }] : params()
      eat('=>')
      if (is('{')) return { t: 'fn', params: list, body: block() }

      return { t: 'fn', params: list, body: [{ t: 'return', value: assign() }] }
    }
    const left = conditional()
    const tok = peek()
    if (tok.k === 'op' && ASSIGN.has(tok.v)) {
      if (!['id', 'member'].includes(left.t)) fail('cannot assign to that')
      p++

      return { t: 'assign', op: tok.v, target: left, value: assign() }
    }

    return left
  }

  function conditional(): Node {
    const test = binary(1)
    if (!maybe('?')) return test
    const a = assign()
    eat(':')

    return { t: 'cond', test, a, b: assign() }
  }

  function binary(min: number): Node {
    let left = unary()
    for (;;) {
      const tok = peek()
      const op = tok.k === 'op' || (tok.k === 'id' && tok.v === 'in') ? tok.v : undefined
      const prec = op === undefined ? undefined : BINARY[op]
      if (op === undefined || prec === undefined || prec < min) return left
      p++
      // ** binds to the right; the rest to the left.
      const right = binary(op === '**' ? prec : prec + 1)
      left = { t: ['&&', '||', '??'].includes(op) ? 'logic' : 'bin', op, l: left, r: right }
    }
  }

  function unary(): Node {
    const tok = peek()
    if (tok.k === 'op' && ['-', '+', '!', '~'].includes(tok.v)) {
      p++

      return { t: 'unary', op: tok.v, arg: unary() }
    }
    if (tok.k === 'op' && (tok.v === '++' || tok.v === '--')) {
      p++

      return { t: 'update', op: tok.v, prefix: true, target: unary() }
    }
    if (tok.k === 'id' && tok.v === 'typeof') {
      p++

      return { t: 'typeof', arg: unary() }
    }
    const e = postfix()
    const after = peek()
    if (after.k === 'op' && (after.v === '++' || after.v === '--')) {
      p++

      return { t: 'update', op: after.v, prefix: false, target: e }
    }

    return e
  }

  function args(): Node[] {
    eat('(')
    const list: Node[] = []
    while (!is(')')) {
      list.push(maybe('...') ? { t: 'spread', e: assign() } : assign())
      if (!is(')')) eat(',')
    }
    eat(')')

    return list
  }

  function postfix(): Node {
    let e: Node
    if (maybe('new')) {
      const callee = primary()
      e = { t: 'call', callee, args: is('(') ? args() : [] }
    } else {
      e = primary()
    }
    for (;;) {
      if (maybe('.')) e = { t: 'member', obj: e, prop: { t: 'lit', v: name() } }
      else if (maybe('?.')) {
        if (is('(')) e = { t: 'call', callee: e, args: args(), optional: true }
        else if (maybe('[')) {
          const prop = expression()
          eat(']')
          e = { t: 'member', obj: e, prop, optional: true }
        } else e = { t: 'member', obj: e, prop: { t: 'lit', v: name() }, optional: true }
      } else if (maybe('[')) {
        const prop = expression()
        eat(']')
        e = { t: 'member', obj: e, prop }
      } else if (is('(')) e = { t: 'call', callee: e, args: args() }
      else return e
    }
  }

  function primary(): Node {
    const tok = peek()
    p++
    if (tok.k === 'num') return { t: 'lit', v: tok.v }
    if (tok.k === 'str') return { t: 'lit', v: tok.v }
    if (tok.k === 'tpl') return { t: 'tpl', strs: tok.strs, exprs: tok.exprs.map(source => parseExpression(source)) }
    if (tok.k === 'id') {
      if (tok.v === 'true') return { t: 'lit', v: true }
      if (tok.v === 'false') return { t: 'lit', v: false }
      if (tok.v === 'null') return { t: 'lit', v: null }
      if (tok.v === 'undefined') return { t: 'lit', v: undefined }
      if (tok.v === 'function') {
        const fnName = peek().k === 'id' ? name() : undefined

        return { t: 'fn', name: fnName, params: params(), body: block() }
      }

      return { t: 'id', name: tok.v }
    }
    if (tok.k === 'op' && tok.v === '(') {
      const e = expression()
      eat(')')

      return e
    }
    if (tok.k === 'op' && tok.v === '[') {
      const items: Node[] = []
      while (!is(']')) {
        items.push(maybe('...') ? { t: 'spread', e: assign() } : assign())
        if (!is(']')) eat(',')
      }
      eat(']')

      return { t: 'arr', items }
    }
    if (tok.k === 'op' && tok.v === '{') {
      const props: [Node | string, Node][] = []
      while (!is('}')) {
        if (maybe('...')) {
          props.push(['...', assign()])
        } else {
          const key = peek()
          let k: Node | string
          if (maybe('[')) {
            k = expression()
            eat(']')
          } else {
            p++
            k = key.k === 'num' || key.k === 'str' || key.k === 'id' ? String((key as { v: unknown }).v) : fail('bad property name')
          }
          if (typeof k === 'string' && (is(',') || is('}'))) props.push([k, { t: 'id', name: k }])
          else if (typeof k === 'string' && is('(')) props.push([k, { t: 'fn', name: k, params: params(), body: block() }])
          else {
            eat(':')
            props.push([k, assign()])
          }
        }
        if (!is('}')) eat(',')
      }
      eat('}')

      return { t: 'obj', props }
    }

    return fail(`unexpected "${(tok as { v?: unknown }).v ?? (tok as { k: string }).k}"`)
  }

  function parseExpression(source: string): Node {
    const [first] = parse(`(${source});`)

    return (first as Node).e as Node
  }

  return program()
}

// ---------------------------------------------------------------- running

// The fuel left for the current run; every statement, loop turn and call
// spends one.
let fuel = 0
const burn = () => {
  if (--fuel < 0) throw new ScriptError('the scene code took too long to run')
}

// The largest array the code may build, and the longest string.
const MAX_LENGTH = 100_000

class Scope {
  vars = new Map<string, V>()
  consts?: Set<string>
  constructor(readonly parent?: Scope) {}
  declare(name: string, value: V, isConst = false) {
    this.vars.set(name, value)
    if (isConst) (this.consts ??= new Set()).add(name)
    else this.consts?.delete(name)
  }
  lookup(name: string): V {
    for (let s: Scope | undefined = this; s; s = s.parent) if (s.vars.has(name)) return s.vars.get(name)
    throw new ScriptError(`${name} is not defined`)
  }
  assign(name: string, value: V) {
    for (let s: Scope | undefined = this; s; s = s.parent) {
      if (s.vars.has(name)) {
        if (s.consts?.has(name)) throw new ScriptError(`${name} is a const`)
        s.vars.set(name, value)

        return
      }
    }
    throw new ScriptError(`${name} is not defined`)
  }
}

// A function the code made.
class Fn {
  constructor(
    readonly params: Node[],
    readonly body: Exec,
    readonly scope: Scope,
    readonly name?: string,
  ) {}
}

type Eval = (s: Scope) => V
type Signal = undefined | 'break' | 'continue' | { value: V }
type Exec = (s: Scope) => Signal

export const obj = (entries: Record<string, V> = {}) => Object.assign(Object.create(null) as Record<string, V>, entries)
const isObj = (v: V): v is Record<string, V> => typeof v === 'object' && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === null
const describe = (v: V) => (v === null ? 'null' : v === undefined ? 'undefined' : typeof v === 'string' ? `"${v.slice(0, 20)}"` : Array.isArray(v) ? 'an array' : typeof v)

export function call(f: V, args: V[]): V {
  burn()
  if (f instanceof Fn) {
    const scope = new Scope(f.scope)
    f.params.forEach((param, i) => bind(param, args[i], scope, 'let'))
    scope.declare('arguments', args)
    const signal = f.body(scope)

    return typeof signal === 'object' ? signal.value : undefined
  }
  if (typeof f === 'function') return (f as (...a: V[]) => V)(...args)
  throw new ScriptError(`${describe(f)} is not a function`)
}

const checkLength = (n: number) => {
  if (n > MAX_LENGTH) throw new ScriptError('an array or string grew too big')

  return n
}

const ARRAY: Record<string, (a: V[], ...args: V[]) => V> = {
  push: (a, ...v) => (checkLength(a.length + v.length), a.push(...v)),
  pop: a => a.pop(),
  shift: a => a.shift(),
  unshift: (a, ...v) => (checkLength(a.length + v.length), a.unshift(...v)),
  slice: (a, s, e) => a.slice(s, e),
  splice: (a, s, n, ...v) => a.splice(s, n ?? a.length, ...v),
  concat: (a, ...v) => {
    const out = a.concat(...v)
    checkLength(out.length)

    return out
  },
  indexOf: (a, v) => a.indexOf(v),
  lastIndexOf: (a, v) => a.lastIndexOf(v),
  includes: (a, v) => a.includes(v),
  join: (a, sep) => a.join(sep ?? ','),
  reverse: a => a.reverse(),
  fill: (a, v, s, e) => a.fill(v, s, e),
  at: (a, i) => a.at(i),
  map: (a, f) => a.map((v, i) => call(f, [v, i, a])),
  filter: (a, f) => a.filter((v, i) => call(f, [v, i, a])),
  forEach: (a, f) => void a.forEach((v, i) => call(f, [v, i, a])),
  some: (a, f) => a.some((v, i) => call(f, [v, i, a])),
  every: (a, f) => a.every((v, i) => call(f, [v, i, a])),
  find: (a, f) => a.find((v, i) => call(f, [v, i, a])),
  findIndex: (a, f) => a.findIndex((v, i) => call(f, [v, i, a])),
  reduce: (a, f, ...init) =>
    init.length > 0 ? a.reduce((acc, v, i) => call(f, [acc, v, i, a]), init[0]) : a.reduce((acc, v, i) => call(f, [acc, v, i, a])),
  sort: (a, f) => a.sort(f === undefined ? undefined : (x, y) => Number(call(f, [x, y])) || 0),
  flat: a => a.flat(),
}

const STRING: Record<string, (s: string, ...args: V[]) => V> = {
  slice: (s, a, b) => s.slice(a, b),
  substring: (s, a, b) => s.substring(a, b),
  charAt: (s, i) => s.charAt(i),
  charCodeAt: (s, i) => s.charCodeAt(i),
  codePointAt: (s, i) => s.codePointAt(i),
  indexOf: (s, v) => s.indexOf(String(v)),
  includes: (s, v) => s.includes(String(v)),
  startsWith: (s, v) => s.startsWith(String(v)),
  endsWith: (s, v) => s.endsWith(String(v)),
  split: (s, sep) => s.split(sep === undefined ? (undefined as unknown as string) : String(sep)),
  repeat: (s, n) => s.repeat(checkLength(s.length * Math.max(0, Math.floor(Number(n) || 0))) > 0 ? Math.floor(n) : 0),
  padStart: (s, n, f) => s.padStart(checkLength(n), f),
  padEnd: (s, n, f) => s.padEnd(checkLength(n), f),
  toUpperCase: s => s.toUpperCase(),
  toLowerCase: s => s.toLowerCase(),
  trim: s => s.trim(),
  replace: (s, a, b) => s.replace(String(a), String(b)),
  replaceAll: (s, a, b) => s.split(String(a)).join(String(b)),
  at: (s, i) => s.at(i),
}

const own = <T>(table: Record<string, T>, key: V): T | undefined =>
  Object.prototype.hasOwnProperty.call(table, String(key)) ? table[String(key)] : undefined

// Names hung on a library function, as Array.from hangs on Array.
const STATICS = new WeakMap<object, Record<string, V>>()

function get(target: V, key: V): V {
  if (target === null || target === undefined) throw new ScriptError(`cannot read "${String(key)}" of ${target}`)
  if (Array.isArray(target)) {
    if (typeof key === 'number') return target[key]
    if (key === 'length') return target.length
    const m = own(ARRAY, key)
    if (m) return (...a: V[]) => m(target, ...a)
    if (/^\d+$/.test(String(key))) return target[Number(key)]

    return undefined
  }
  if (typeof target === 'string') {
    if (typeof key === 'number' || /^\d+$/.test(String(key))) return target[Number(key)]
    if (key === 'length') return target.length
    const m = own(STRING, key)

    return m ? (...a: V[]) => m(target, ...a) : undefined
  }
  if (typeof target === 'number') {
    if (key === 'toFixed') return (d: V) => target.toFixed(Math.max(0, Math.min(20, Number(d) || 0)))

    return undefined
  }
  if (isObj(target)) return own(target, key)
  if (typeof target === 'function') {
    const statics = STATICS.get(target)

    return statics ? own(statics, key) : undefined
  }

  return undefined
}

function set(target: V, key: V, value: V): V {
  if (Array.isArray(target)) {
    if (key === 'length') {
      target.length = checkLength(Math.max(0, Math.floor(Number(value) || 0)))

      return value
    }
    const i = Number(key)
    if (!Number.isInteger(i) || i < 0) throw new ScriptError(`bad array index ${String(key)}`)
    checkLength(i + 1)
    target[i] = value

    return value
  }
  if (isObj(target)) {
    target[String(key)] = value

    return value
  }
  throw new ScriptError(`cannot set "${String(key)}" on ${describe(target)}`)
}

function binop(op: string, a: V, b: V): V {
  switch (op) {
    case '+': {
      const v = a + b
      if (typeof v === 'string') checkLength(v.length)

      return v
    }
    case '-': return a - b
    case '*': return a * b
    case '/': return a / b
    case '%': return a % b
    case '**': return a ** b
    case '==': return a == b // eslint-disable-line eqeqeq
    case '!=': return a != b // eslint-disable-line eqeqeq
    case '===': return a === b
    case '!==': return a !== b
    case '<': return a < b
    case '>': return a > b
    case '<=': return a <= b
    case '>=': return a >= b
    case '&': return a & b
    case '|': return a | b
    case '^': return a ^ b
    case '<<': return a << b
    case '>>': return a >> b
    case '>>>': return a >>> b
    case 'in': return isObj(b) ? Object.prototype.hasOwnProperty.call(b, String(a)) : Array.isArray(b) ? Number(a) in b : false
  }
  throw new ScriptError(`unknown operator ${op}`)
}

// Binds a pattern (a name, [a, b], {x, y}, with defaults) to a value.
function bind(pattern: Node, value: V, scope: Scope, kind: string) {
  switch (pattern.t) {
    case 'id':
      scope.declare(pattern.name, value, kind === 'const')

      return
    case 'default':
      bind(pattern.target, value === undefined ? evalNode(pattern.def)(scope) : value, scope, kind)

      return
    case 'arrPat':
      ;(pattern.items as (Node | null)[]).forEach((item, i) => item && bind(item, get(value, i), scope, kind))

      return
    case 'objPat':
      for (const [key, target] of pattern.props as [string, Node][]) bind(target, get(value, key), scope, kind)

      return
  }
}

// Compiled closures, cached per node so a function body compiles once.
const compiled = new WeakMap<Node, Eval | Exec>()
function evalNode(node: Node): Eval {
  let f = compiled.get(node) as Eval | undefined
  if (!f) {
    f = compileExpr(node)
    compiled.set(node, f)
  }

  return f
}
function execNode(node: Node): Exec {
  let f = compiled.get(node) as Exec | undefined
  if (!f) {
    f = compileStmt(node)
    compiled.set(node, f)
  }

  return f
}

function compileExpr(node: Node): Eval {
  switch (node.t) {
    case 'lit': {
      const v = node.v

      return () => v
    }
    case 'tpl': {
      const strs = node.strs as string[]
      const exprs = (node.exprs as Node[]).map(evalNode)

      return s => {
        let out = strs[0] ?? ''
        exprs.forEach((e, i) => {
          out += String(e(s)) + (strs[i + 1] ?? '')
        })

        return out
      }
    }
    case 'id': {
      const id = node.name as string

      return s => s.lookup(id)
    }
    case 'arr': {
      const items = (node.items as Node[]).map(item => (item.t === 'spread' ? { spread: evalNode(item.e) } : { one: evalNode(item) }))

      return s => {
        const out: V[] = []
        for (const item of items) {
          if (item.spread) out.push(...toList(item.spread(s)))
          else out.push(item.one(s))
        }

        return out
      }
    }
    case 'obj': {
      const props = (node.props as [Node | string, Node][]).map(([k, v]) => ({ key: typeof k === 'string' ? k : evalNode(k), value: evalNode(v) }))

      return s => {
        const out = obj()
        for (const { key, value } of props) {
          if (key === '...') {
            const v = value(s)
            if (isObj(v)) Object.assign(out, v)
          }
          else out[typeof key === 'string' ? key : String(key(s))] = value(s)
        }

        return out
      }
    }
    case 'fn': {
      const params = node.params as Node[]
      const body = compileBody(node.body as Node[])
      const name = node.name as string | undefined

      return s => new Fn(params, body, s, name)
    }
    case 'seq': {
      const a = evalNode(node.a)
      const b = evalNode(node.b)

      return s => (a(s), b(s))
    }
    case 'unary': {
      const arg = evalNode(node.arg)
      switch (node.op) {
        case '-': return s => -arg(s)
        case '+': return s => +arg(s)
        case '!': return s => !arg(s)
        default: return s => ~arg(s)
      }
    }
    case 'typeof': {
      const arg = evalNode(node.arg)

      return s => {
        let v: V
        try {
          v = arg(s)
        } catch {
          return 'undefined'
        }

        return v instanceof Fn || typeof v === 'function' ? 'function' : v === null ? 'object' : typeof v
      }
    }
    case 'bin': {
      const l = evalNode(node.l)
      const r = evalNode(node.r)
      const op = node.op as string

      return s => binop(op, l(s), r(s))
    }
    case 'logic': {
      const l = evalNode(node.l)
      const r = evalNode(node.r)
      if (node.op === '&&') return s => l(s) && r(s)
      if (node.op === '||') return s => l(s) || r(s)

      return s => l(s) ?? r(s)
    }
    case 'cond': {
      const test = evalNode(node.test)
      const a = evalNode(node.a)
      const b = evalNode(node.b)

      return s => (test(s) ? a(s) : b(s))
    }
    case 'member': {
      const target = evalNode(node.obj)
      const key = evalNode(node.prop)
      if (node.optional) {
        return s => {
          const o = target(s)

          return o === null || o === undefined ? undefined : get(o, key(s))
        }
      }

      return s => get(target(s), key(s))
    }
    case 'call': {
      const callee = node.callee as Node
      const list = (node.args as Node[]).map(a => (a.t === 'spread' ? { spread: evalNode(a.e) } : { one: evalNode(a) }))
      const argsOf = (s: Scope) => {
        const out: V[] = []
        for (const a of list) {
          if (a.spread) out.push(...toList(a.spread(s)))
          else out.push(a.one(s))
        }

        return out
      }
      const f = evalNode(callee)
      const label = callee.t === 'id' ? callee.name : callee.t === 'member' && callee.prop.t === 'lit' ? callee.prop.v : 'that'
      const optional = node.optional as boolean | undefined

      return s => {
        const fn = f(s)
        if (optional && (fn === null || fn === undefined)) return undefined
        if (!(fn instanceof Fn) && typeof fn !== 'function') throw new ScriptError(`${label} is not a function`)

        return call(fn, argsOf(s))
      }
    }
    case 'assign': {
      const op = (node.op as string).slice(0, -1)
      const value = evalNode(node.value)
      const target = node.target as Node
      const combine = (old: () => V, s: Scope): V => {
        if (op === '') return value(s)
        if (op === '&&') return old() && value(s)
        if (op === '||') return old() || value(s)
        if (op === '??') return old() ?? value(s)

        return binop(op, old(), value(s))
      }
      if (target.t === 'id') {
        const id = target.name as string

        return s => {
          const v = combine(() => s.lookup(id), s)
          s.assign(id, v)

          return v
        }
      }
      const o = evalNode(target.obj)
      const k = evalNode(target.prop)

      return s => {
        const holder = o(s)
        const key = k(s)

        return set(holder, key, combine(() => get(holder, key), s))
      }
    }
    case 'update': {
      const delta = node.op === '++' ? 1 : -1
      const prefix = node.prefix as boolean
      const target = node.target as Node
      if (target.t === 'id') {
        const id = target.name as string

        return s => {
          const old = Number(s.lookup(id))
          s.assign(id, old + delta)

          return prefix ? old + delta : old
        }
      }
      if (target.t !== 'member') throw new ScriptError('cannot increment that')
      const o = evalNode(target.obj)
      const k = evalNode(target.prop)

      return s => {
        const holder = o(s)
        const key = k(s)
        const old = Number(get(holder, key))
        set(holder, key, old + delta)

        return prefix ? old + delta : old
      }
    }
    case 'spread':
      throw new ScriptError('"..." only goes in arrays and calls')
  }
  throw new ScriptError(`cannot run ${node.t}`)
}

const toList = (v: V): V[] => (Array.isArray(v) ? v : typeof v === 'string' ? [...v] : [])

// A block's statements, its function declarations hoisted.
function compileBody(body: Node[]): Exec {
  const hoisted = body.filter(n => n.t === 'fnDecl').map(n => ({ name: n.name as string, make: evalNode(n.fn) }))
  const steps = body.filter(n => n.t !== 'fnDecl').map(execNode)

  return s => {
    for (const h of hoisted) s.declare(h.name, h.make(s))
    for (const step of steps) {
      const signal = step(s)
      if (signal !== undefined) return signal
    }

    return undefined
  }
}

function loop(s: Scope, test: Eval | undefined, body: Exec, update: Eval | undefined): Signal {
  for (;;) {
    burn()
    if (test && !test(s)) return undefined
    const signal = body(new Scope(s))
    if (signal === 'break') return undefined
    if (typeof signal === 'object') return signal
    update?.(s)
  }
}

function compileStmt(node: Node): Exec {
  switch (node.t) {
    case 'empty':
      return () => undefined
    case 'expr': {
      const e = evalNode(node.e)

      return s => {
        burn()
        e(s)

        return undefined
      }
    }
    case 'decl': {
      const kind = node.kind as string
      const decls = (node.decls as [Node, Node | undefined][]).map(([target, init]) => ({ target, init: init && evalNode(init) }))

      return s => {
        burn()
        for (const { target, init } of decls) bind(target, init?.(s), s, kind)

        return undefined
      }
    }
    case 'block': {
      const body = compileBody(node.body)

      return s => body(new Scope(s))
    }
    case 'if': {
      const test = evalNode(node.test)
      const then = execNode(node.then)
      const otherwise = node.otherwise ? execNode(node.otherwise) : undefined

      return s => {
        burn()

        return test(s) ? then(s) : otherwise?.(s)
      }
    }
    case 'while': {
      const test = evalNode(node.test)
      const body = execNode(node.body)

      return s => loop(s, test, body, undefined)
    }
    case 'doWhile': {
      const test = evalNode(node.test)
      const body = execNode(node.body)

      return s => {
        const first = body(new Scope(s))
        if (first === 'break') return undefined
        if (typeof first === 'object') return first

        return loop(s, test, body, undefined)
      }
    }
    case 'for': {
      const init = node.init ? execNode(node.init) : undefined
      const test = node.test ? evalNode(node.test) : undefined
      const update = node.update ? evalNode(node.update) : undefined
      const body = execNode(node.body)
      // As in JavaScript, each turn of a for (let ...) loop gets its own copy
      // of the loop's variables, so closures made in it keep that turn's.
      const isPerTurn = node.init?.t === 'decl' && node.init.kind !== 'var'

      return s => {
        let scope = new Scope(s)
        init?.(scope)
        for (;;) {
          burn()
          if (test && !test(scope)) return undefined
          const signal = body(new Scope(scope))
          if (signal === 'break') return undefined
          if (typeof signal === 'object') return signal
          if (isPerTurn) {
            const next = new Scope(s)
            for (const [k, v] of scope.vars) next.vars.set(k, v)
            next.consts = scope.consts
            scope = next
          }
          update?.(scope)
        }
      }
    }
    case 'switch': {
      const disc = evalNode(node.disc)
      const cases = (node.cases as { test?: Node; body: Node[] }[]).map(c => ({ test: c.test && evalNode(c.test), body: compileBody(c.body) }))

      return s => {
        burn()
        const v = disc(s)
        let from = cases.findIndex(c => c.test !== undefined && c.test(s) === v)
        if (from < 0) from = cases.findIndex(c => c.test === undefined)
        if (from < 0) return undefined
        const scope = new Scope(s)
        for (const c of cases.slice(from)) {
          const signal = c.body(scope)
          if (signal === 'break') return undefined
          if (signal !== undefined) return signal
        }

        return undefined
      }
    }
    case 'forOf':
    case 'forIn': {
      const iter = evalNode(node.iter)
      const body = execNode(node.body)
      const target = node.target as Node
      const kind = node.kind as string
      const isOf = node.t === 'forOf'

      return s => {
        const v = iter(s)
        const items = isOf ? toList(v) : Array.isArray(v) || typeof v === 'string' ? Object.keys(toList(v)) : isObj(v) ? Object.keys(v) : []
        for (const item of items) {
          burn()
          const scope = new Scope(s)
          bind(target, item, scope, kind)
          const signal = body(scope)
          if (signal === 'break') return undefined
          if (typeof signal === 'object') return signal
        }

        return undefined
      }
    }
    case 'return': {
      const value = node.value ? evalNode(node.value) : undefined

      return s => ({ value: value?.(s) })
    }
    case 'break':
      return () => 'break'
    case 'continue':
      return () => 'continue'
    case 'fnDecl': {
      const make = evalNode(node.fn)
      const name = node.name as string

      return s => {
        s.declare(name, make(s))

        return undefined
      }
    }
  }
  throw new ScriptError(`cannot run ${node.t}`)
}

// ---------------------------------------------------------------- library

const hash = (x: number) => {
  const v = Math.sin(x * 127.1 + 311.7) * 43758.5453

  return v - Math.floor(v)
}
const smooth = (k: number) => k * k * (3 - 2 * k)
const noise = (x: number) => {
  const i = Math.floor(x)

  return hash(i) + (hash(i + 1) - hash(i)) * smooth(x - i)
}
const noise2 = (x: number, y: number) => {
  const i = Math.floor(x)
  const j = Math.floor(y)
  const at = (a: number, b: number) => hash(a * 57.3 + b * 113.9)
  const u = smooth(x - i)
  const v = smooth(y - j)
  const top = at(i, j) + (at(i + 1, j) - at(i, j)) * u
  const bottom = at(i, j + 1) + (at(i + 1, j + 1) - at(i, j + 1)) * u

  return top + (bottom - top) * v
}

const MATH = obj({
  PI: Math.PI,
  E: Math.E,
  ...Object.fromEntries(
    ['sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2', 'abs', 'floor', 'ceil', 'round', 'trunc', 'sqrt', 'cbrt', 'pow', 'exp', 'log', 'log2', 'log10', 'sign', 'hypot', 'sinh', 'cosh', 'tanh'].map(
      name => [name, (Math as unknown as Record<string, (...a: number[]) => number>)[name]],
    ),
  ),
  min: (...v: number[]) => Math.min(...v),
  max: (...v: number[]) => Math.max(...v),
  random: () => Math.random(),
})

const withStatics = (f: (...a: V[]) => V, statics: Record<string, V>) => {
  STATICS.set(f, statics)

  return f
}

const BUILTINS: Record<string, V> = {
  Math: MATH,
  Array: withStatics((...a: V[]) => (a.length === 1 && typeof a[0] === 'number' ? new Array(checkLength(a[0])) : a), {
    from: (src: V, f?: V) => {
      const n = Array.isArray(src) || typeof src === 'string' ? toList(src).length : isObj(src) ? Number(src.length) || 0 : 0
      const items = Array.isArray(src) || typeof src === 'string' ? toList(src) : Array.from({ length: checkLength(n) })

      return f === undefined ? [...items] : items.map((v, i) => call(f, [v, i]))
    },
    isArray: (v: V) => Array.isArray(v),
  }),
  Object: obj({
    keys: (v: V) => (isObj(v) ? Object.keys(v) : Array.isArray(v) ? Object.keys(v) : []),
    values: (v: V) => (isObj(v) ? Object.values(v) : Array.isArray(v) ? [...v] : []),
    entries: (v: V) => (isObj(v) ? Object.entries(v) : []),
    assign: (t: V, ...src: V[]) => (isObj(t) ? Object.assign(t, ...src.filter(isObj)) : t),
  }),
  Number: (v: V) => Number(v),
  String: (v: V) => String(v),
  Boolean: (v: V) => Boolean(v),
  parseInt: (v: V, b?: V) => parseInt(String(v), b),
  parseFloat: (v: V) => parseFloat(String(v)),
  isNaN: (v: V) => Number.isNaN(Number(v)),
  Infinity,
  NaN,
  // Helpers a scene reaches for constantly.
  clamp: (v: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v)),
  lerp: (a: number, b: number, k: number) => a + (b - a) * k,
  smoothstep: (a: number, b: number, v: number) => smooth(Math.min(1, Math.max(0, b === a ? (v >= b ? 1 : 0) : (v - a) / (b - a)))),
  fract: (v: number) => v - Math.floor(v),
  mod: (a: number, b: number) => (b === 0 ? 0 : ((a % b) + b) % b),
  rand: (v: number) => hash(Number(v) || 0),
  noise: (v: number) => noise(Number(v) || 0),
  noise2: (x: number, y: number) => noise2(Number(x) || 0, Number(y) || 0),
}

export type Program = {
  // Runs the top level once, with these names defined first.
  start: (globals: Record<string, V>, budget: number) => void
  // Updates these names, then calls the code's function `name` if it has one.
  call: (name: string, args: V[], globals: Record<string, V>, budget: number) => V
}

// Parses source into a program, or throws a ScriptError saying what is wrong.
export function parseProgram(source: string): Program {
  const body = compileBody(parse(source))
  const root = new Scope()
  for (const [k, v] of Object.entries(BUILTINS)) root.declare(k, v)
  const scope = new Scope(root)
  const run = <T>(budget: number, f: () => T): T => {
    fuel = budget
    try {
      return f()
    } catch (e) {
      if (e instanceof ScriptError) throw e
      // A RangeError from deep recursion, a TypeError from a bad operand.
      throw new ScriptError(e instanceof Error ? e.message : String(e))
    }
  }

  return {
    start: (globals, budget) =>
      run(budget, () => {
        for (const [k, v] of Object.entries(globals)) root.declare(k, v)
        body(scope)
      }),
    call: (name, args, globals, budget) =>
      run(budget, () => {
        for (const [k, v] of Object.entries(globals)) root.declare(k, v)
        if (!scope.vars.has(name)) return undefined

        return call(scope.vars.get(name), args)
      }),
  }
}
