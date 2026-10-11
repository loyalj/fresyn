/**
 * The Expression module's language: a formula typed on its panel, compiled
 * once into a short program for a small stack machine, and run at audio rate
 * with nothing allocated.
 *
 * The syntax is JavaScript's arithmetic, on purpose: bytebeat formulas are
 * shared as JavaScript (or C, which reads the same), and `t*(t>>5|t>>8)`
 * pasted from anywhere should just work. So `^` is exclusive or, not a
 * power -- `**` and `pow()` are the powers -- and the bitwise operators work
 * on 32-bit integers, as JavaScript's do.
 *
 * Shared by the audio thread, which runs it, and the panel, which runs the
 * same program to draw it: a graph worked out any other way could disagree
 * with what is heard.
 */

/** The variables a formula can read, in the order the machine keeps them. */
export const EXPR_VARS = ['x', 'y', 't', 'a', 'b'] as const
export type ExprVar = (typeof EXPR_VARS)[number]
export const VAR_X = 0
export const VAR_Y = 1
export const VAR_T = 2
export const VAR_A = 3
export const VAR_B = 4

const CONSTANTS: Record<string, number> = { pi: Math.PI, tau: 2 * Math.PI, e: Math.E }

/** Periodic shapes with a period of one, so `saw(t)` is one cycle a second. */
const frac = (v: number) => v - Math.floor(v)
const tri = (v: number) => 1 - 4 * Math.abs(frac(v + 0.25) - 0.5)

/** Every function, by name: how many arguments it takes, and what it is. */
const FUNCTIONS: Record<string, { args: number; fn: (...a: number[]) => number }> = {
  sin: { args: 1, fn: Math.sin },
  cos: { args: 1, fn: Math.cos },
  tan: { args: 1, fn: Math.tan },
  asin: { args: 1, fn: Math.asin },
  acos: { args: 1, fn: Math.acos },
  atan: { args: 1, fn: Math.atan },
  atan2: { args: 2, fn: Math.atan2 },
  sinh: { args: 1, fn: Math.sinh },
  cosh: { args: 1, fn: Math.cosh },
  tanh: { args: 1, fn: Math.tanh },
  sqrt: { args: 1, fn: Math.sqrt },
  cbrt: { args: 1, fn: Math.cbrt },
  abs: { args: 1, fn: Math.abs },
  floor: { args: 1, fn: Math.floor },
  ceil: { args: 1, fn: Math.ceil },
  round: { args: 1, fn: Math.round },
  trunc: { args: 1, fn: Math.trunc },
  fract: { args: 1, fn: frac },
  sign: { args: 1, fn: Math.sign },
  exp: { args: 1, fn: Math.exp },
  log: { args: 1, fn: Math.log },
  log2: { args: 1, fn: Math.log2 },
  log10: { args: 1, fn: Math.log10 },
  min: { args: 2, fn: Math.min },
  max: { args: 2, fn: Math.max },
  pow: { args: 2, fn: Math.pow },
  hypot: { args: 2, fn: Math.hypot },
  mod: { args: 2, fn: (a, b) => a - b * Math.floor(a / b) },
  clamp: { args: 3, fn: (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v) },
  mix: { args: 3, fn: (a, b, k) => a + (b - a) * k },
  step: { args: 2, fn: (edge, v) => (v < edge ? 0 : 1) },
  saw: { args: 1, fn: (v) => 2 * frac(v) - 1 },
  tri: { args: 1, fn: tri },
  sq: { args: 1, fn: (v) => (frac(v) < 0.5 ? 1 : -1) },
}

/** The machine's instructions. Each pops what it needs and pushes one answer. */
const enum Op {
  Const,
  Var,
  Neg,
  Not,
  BitNot,
  Add,
  Sub,
  Mul,
  Div,
  Rem,
  Pow,
  And,
  Or,
  Xor,
  Shl,
  Shr,
  Ushr,
  Lt,
  Gt,
  Le,
  Ge,
  Eq,
  Ne,
  LogAnd,
  LogOr,
  Select,
  Call1,
  Call2,
  Call3,
  Noise,
}

const BINARY: Record<string, Op> = {
  '+': Op.Add, '-': Op.Sub, '*': Op.Mul, '/': Op.Div, '%': Op.Rem, '**': Op.Pow,
  '&': Op.And, '|': Op.Or, '^': Op.Xor, '<<': Op.Shl, '>>': Op.Shr, '>>>': Op.Ushr,
  '<': Op.Lt, '>': Op.Gt, '<=': Op.Le, '>=': Op.Ge, '==': Op.Eq, '!=': Op.Ne,
  '&&': Op.LogAnd, '||': Op.LogOr,
}

/** Binding strength, loosest first, as JavaScript has them. `**` is handled on its own. */
const LEVELS: string[][] = [
  ['||'],
  ['&&'],
  ['|'],
  ['^'],
  ['&'],
  ['==', '!='],
  ['<', '>', '<=', '>='],
  ['<<', '>>', '>>>'],
  ['+', '-'],
  ['*', '/', '%'],
]

/** Longest first, so `>>>` is never read as `>>` and `>`. */
const PUNCT = ['>>>', '**', '<<', '>>', '<=', '>=', '==', '!=', '&&', '||', '+', '-', '*', '/', '%', '&', '|', '^', '~', '!', '<', '>', '?', ':', '(', ')', ',']

/** The deepest a program's stack can get; far past anything typed by hand. */
const MAX_STACK = 64
/** Past this a formula is refused rather than run. */
export const MAX_FORMULA = 2000

interface Token {
  kind: 'num' | 'name' | 'punct' | 'end'
  text: string
  value: number
  at: number
}

export class ExprError extends Error {
  constructor(message: string, readonly at: number) {
    super(message)
  }
}

function tokenize(src: string): Token[] {
  const out: Token[] = []
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++
      continue
    }
    const at = i
    if ((c >= '0' && c <= '9') || (c === '.' && src[i + 1] >= '0' && src[i + 1] <= '9')) {
      const hex = /^0[xX][0-9a-fA-F]+/.exec(src.slice(i))
      const m = hex ?? /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(src.slice(i))!
      out.push({ kind: 'num', text: m[0], value: Number(m[0]), at })
      i += m[0].length
      continue
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))!
      out.push({ kind: 'name', text: m[0], value: 0, at })
      i += m[0].length
      continue
    }
    const p = PUNCT.find((q) => src.startsWith(q, i))
    if (!p) throw new ExprError(`"${c}" is not part of a formula`, at)
    out.push({ kind: 'punct', text: p, value: 0, at })
    i += p.length
  }
  out.push({ kind: 'end', text: '', value: 0, at: src.length })
  return out
}

/** A compiled formula: run it with `run`, as often as you like. */
export interface ExprProgram {
  readonly source: string
  /** The instructions, and an operand for each: a constant's or a variable's index, or a function's. */
  readonly ops: Int32Array
  readonly args: Int32Array
  readonly consts: Float64Array
  readonly fns: ((...a: number[]) => number)[]
  /** Which variables it reads, by `EXPR_VARS` index. */
  readonly uses: readonly boolean[]
  /** A number that never changes: nothing to read and nothing random. */
  readonly constant: boolean
}

export type CompileResult = { ok: true; program: ExprProgram } | { ok: false; error: string; at: number }

/** Parse and compile a formula. Never throws: a mistake comes back as a message and where it is. */
export function compileExpr(source: string): CompileResult {
  if (source.length > MAX_FORMULA) return { ok: false, error: `Too long: ${MAX_FORMULA} characters at most`, at: MAX_FORMULA }
  try {
    return { ok: true, program: new Compiler(source).compile() }
  } catch (e) {
    if (e instanceof ExprError) return { ok: false, error: e.message, at: e.at }
    throw e
  }
}

class Compiler {
  private tokens: Token[]
  private pos = 0
  private ops: number[] = []
  private args: number[] = []
  private consts: number[] = []
  private fns: ((...a: number[]) => number)[] = []
  private uses = EXPR_VARS.map(() => false)
  private random = false
  private depth = 0
  private deepest = 0

  constructor(private readonly source: string) {
    this.tokens = tokenize(source)
  }

  compile(): ExprProgram {
    if (this.peek().kind === 'end') throw new ExprError('Type a formula', 0)
    this.ternary()
    const t = this.peek()
    if (t.kind !== 'end') throw new ExprError(`Did not expect "${t.text}" here`, t.at)
    if (this.deepest > MAX_STACK) throw new ExprError('Nested too deeply', 0)
    return {
      source: this.source,
      ops: Int32Array.from(this.ops),
      args: Int32Array.from(this.args),
      consts: Float64Array.from(this.consts),
      fns: this.fns,
      uses: this.uses,
      constant: !this.random && !this.uses.some(Boolean),
    }
  }

  private peek() {
    return this.tokens[this.pos]
  }

  private take() {
    return this.tokens[this.pos++]
  }

  private isPunct(text: string) {
    const t = this.peek()
    return t.kind === 'punct' && t.text === text
  }

  private expect(text: string) {
    const t = this.take()
    if (t.kind !== 'punct' || t.text !== text) {
      throw new ExprError(t.kind === 'end' ? `Missing "${text}" at the end` : `Expected "${text}" but found "${t.text}"`, t.at)
    }
  }

  /** Emit an instruction, keeping count of how deep the stack gets. */
  private emit(op: Op, arg = 0, pops = 0) {
    this.ops.push(op)
    this.args.push(arg)
    this.depth += 1 - pops
    if (this.depth > this.deepest) this.deepest = this.depth
  }

  private ternary() {
    this.binary(0)
    if (!this.isPunct('?')) return
    this.take()
    this.ternary()
    this.expect(':')
    this.ternary()
    // Both branches are worked out and one kept: nothing in the language has
    // a side effect, so it is the same answer without a jump.
    this.emit(Op.Select, 0, 3)
  }

  private binary(level: number) {
    if (level >= LEVELS.length) {
      this.unary()
      return
    }
    this.binary(level + 1)
    for (;;) {
      const t = this.peek()
      if (t.kind !== 'punct' || !LEVELS[level].includes(t.text)) return
      this.take()
      this.binary(level + 1)
      this.emit(BINARY[t.text], 0, 2)
    }
  }

  private unary() {
    const t = this.peek()
    if (t.kind === 'punct' && (t.text === '-' || t.text === '+' || t.text === '!' || t.text === '~')) {
      this.take()
      this.unary()
      if (t.text === '-') this.emit(Op.Neg, 0, 1)
      else if (t.text === '!') this.emit(Op.Not, 0, 1)
      else if (t.text === '~') this.emit(Op.BitNot, 0, 1)
      return
    }
    this.power()
  }

  /** `**` binds tighter than a sign on its left and groups to the right: -2**2 is -4. */
  private power() {
    this.atom()
    if (!this.isPunct('**')) return
    this.take()
    this.unary()
    this.emit(Op.Pow, 0, 2)
  }

  private atom() {
    const t = this.take()
    if (t.kind === 'num') {
      if (!Number.isFinite(t.value)) throw new ExprError(`"${t.text}" is not a number`, t.at)
      this.consts.push(t.value)
      this.emit(Op.Const, this.consts.length - 1)
      return
    }
    if (t.kind === 'punct' && t.text === '(') {
      this.ternary()
      this.expect(')')
      return
    }
    if (t.kind === 'name') {
      const name = t.text
      if (this.isPunct('(')) {
        this.take()
        if (name === 'noise') {
          this.expect(')')
          this.random = true
          this.emit(Op.Noise)
          return
        }
        const f = FUNCTIONS[name]
        if (!f) throw new ExprError(`There is no function called "${name}"`, t.at)
        let count = 0
        if (!this.isPunct(')')) {
          for (;;) {
            this.ternary()
            count++
            if (!this.isPunct(',')) break
            this.take()
          }
        }
        this.expect(')')
        if (count !== f.args) {
          throw new ExprError(`${name}() takes ${f.args} ${f.args === 1 ? 'value' : 'values'}, not ${count}`, t.at)
        }
        this.fns.push(f.fn)
        this.emit(count === 1 ? Op.Call1 : count === 2 ? Op.Call2 : Op.Call3, this.fns.length - 1, count)
        return
      }
      const v = (EXPR_VARS as readonly string[]).indexOf(name)
      if (v >= 0) {
        this.uses[v] = true
        this.emit(Op.Var, v)
        return
      }
      if (name in CONSTANTS) {
        this.consts.push(CONSTANTS[name])
        this.emit(Op.Const, this.consts.length - 1)
        return
      }
      if (name in FUNCTIONS || name === 'noise') throw new ExprError(`${name} needs brackets: ${name}(…)`, t.at)
      throw new ExprError(`"${name}" is not something a formula knows: use x, y, t, a or b`, t.at)
    }
    if (t.kind === 'end') throw new ExprError('The formula stops short', t.at)
    throw new ExprError(`Did not expect "${t.text}" here`, t.at)
  }
}

/**
 * Runs a program. One per user of it, since each keeps its own stack and
 * its own random stream: the audio thread and the panel never share one.
 */
export class ExprMachine {
  private stack = new Float64Array(MAX_STACK + 2)
  /** The variables, by `EXPR_VARS` index: set them, then `run`. */
  readonly vars = new Float64Array(EXPR_VARS.length)
  private seed = 0x9e3779b9

  constructor(public program: ExprProgram | null = null) {}

  /** A random stream of its own for `noise()`, so a render is the same every time. */
  reseed(seed: number) {
    this.seed = seed >>> 0 || 0x9e3779b9
  }

  /** The formula's value with the variables as they are. NaN or an infinity comes back as 0. */
  run(): number {
    const p = this.program
    if (!p) return 0
    const ops = p.ops
    const args = p.args
    const consts = p.consts
    const vars = this.vars
    const s = this.stack
    let sp = 0
    for (let k = 0; k < ops.length; k++) {
      switch (ops[k]) {
        case Op.Const: s[sp++] = consts[args[k]]; break
        case Op.Var: s[sp++] = vars[args[k]]; break
        case Op.Neg: s[sp - 1] = -s[sp - 1]; break
        case Op.Not: s[sp - 1] = s[sp - 1] ? 0 : 1; break
        case Op.BitNot: s[sp - 1] = ~s[sp - 1]; break
        case Op.Add: sp--; s[sp - 1] += s[sp]; break
        case Op.Sub: sp--; s[sp - 1] -= s[sp]; break
        case Op.Mul: sp--; s[sp - 1] *= s[sp]; break
        case Op.Div: sp--; s[sp - 1] /= s[sp]; break
        case Op.Rem: sp--; s[sp - 1] %= s[sp]; break
        case Op.Pow: sp--; s[sp - 1] = Math.pow(s[sp - 1], s[sp]); break
        case Op.And: sp--; s[sp - 1] = s[sp - 1] & s[sp]; break
        case Op.Or: sp--; s[sp - 1] = s[sp - 1] | s[sp]; break
        case Op.Xor: sp--; s[sp - 1] = s[sp - 1] ^ s[sp]; break
        case Op.Shl: sp--; s[sp - 1] = s[sp - 1] << s[sp]; break
        case Op.Shr: sp--; s[sp - 1] = s[sp - 1] >> s[sp]; break
        case Op.Ushr: sp--; s[sp - 1] = s[sp - 1] >>> s[sp]; break
        case Op.Lt: sp--; s[sp - 1] = s[sp - 1] < s[sp] ? 1 : 0; break
        case Op.Gt: sp--; s[sp - 1] = s[sp - 1] > s[sp] ? 1 : 0; break
        case Op.Le: sp--; s[sp - 1] = s[sp - 1] <= s[sp] ? 1 : 0; break
        case Op.Ge: sp--; s[sp - 1] = s[sp - 1] >= s[sp] ? 1 : 0; break
        case Op.Eq: sp--; s[sp - 1] = s[sp - 1] === s[sp] ? 1 : 0; break
        case Op.Ne: sp--; s[sp - 1] = s[sp - 1] !== s[sp] ? 1 : 0; break
        case Op.LogAnd: sp--; s[sp - 1] = s[sp - 1] ? s[sp] : s[sp - 1]; break
        case Op.LogOr: sp--; s[sp - 1] = s[sp - 1] ? s[sp - 1] : s[sp]; break
        case Op.Select: sp -= 2; s[sp - 1] = s[sp - 1] ? s[sp] : s[sp + 1]; break
        case Op.Call1: s[sp - 1] = p.fns[args[k]](s[sp - 1]); break
        case Op.Call2: sp--; s[sp - 1] = p.fns[args[k]](s[sp - 1], s[sp]); break
        case Op.Call3: sp -= 2; s[sp - 1] = p.fns[args[k]](s[sp - 1], s[sp], s[sp + 1]); break
        case Op.Noise: {
          // xorshift32: cheap, and the same sequence every render.
          let r = this.seed
          r ^= r << 13
          r ^= r >>> 17
          r ^= r << 5
          this.seed = r >>> 0
          s[sp++] = (this.seed / 4294967296) * 2 - 1
          break
        }
      }
    }
    const v = s[0]
    return v - v === 0 ? v : 0
  }
}
