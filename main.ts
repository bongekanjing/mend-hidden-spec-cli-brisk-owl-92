// mend: the CLI SPEC.md specifies. Node 22, standard library alone.
//
// Sections 1 to 4, 9 and 10 are the kit's starting point; the tier matcher
// (section 5) and the three text formats (sections 6, 7 and 8) are written
// here. The hand-over to runner.ts at the bottom is the kit's and is kept
// as it is: the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A text's lines, its break and whether it ends with one (SPEC.md section 3). */
interface Text {
  lines: string[];
  br: string;
  final: boolean;
}

function splitText(t: string): Text {
  if (t === '') return { lines: [], br: '\n', final: false };
  const nl = t.indexOf('\n');
  const br = nl > 0 && t[nl - 1] === '\r' ? '\r\n' : '\n';
  const final = t.endsWith(br);
  const lines = t.split(br);
  if (final) lines.pop();
  return { lines, br, final };
}

function joinText(x: Text): string {
  if (x.lines.length === 0) return '';
  return x.lines.join(x.br) + (x.final ? x.br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Moves that succeeded, as [old, new]: they print as one `R` line, not a D and an A. */
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/* ---------------------------------------------------------------- section 5 */

const tier = (line: string, level: number): string =>
  level === 0 ? line : level === 1 ? line.replace(/[ \t]+$/, '') : line.trim();

/** Positions where O occurs in `lines` at `level`, overlaps included. */
function occurrences(lines: string[], o: string[], level: number): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  const want = o.map((l) => tier(l, level));
  for (let i = 0; i + o.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < o.length; j += 1) {
      if (tier(lines[i + j]!, level) !== want[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs, and its occurrences there; null when it occurs at none. A run's
 * lines are compared at the tier under test, so a match at tier 1 ignores trailing blanks and one at
 * tier 2 ignores leading and trailing ones, exactly as section 5 defines them. */
function findTier(lines: string[], o: string[], strict: boolean): { level: number; at: number[] } | null {
  const last = strict ? 1 : 3;
  for (let level = 0; level < last; level += 1) {
    const at = occurrences(lines, o, level);
    if (at.length > 0) return { level, at };
  }
  return null;
}

/** A line of N: a context line (index into O) or a line the patch writes. */
interface NLine {
  text: string;
  ctx: number | null;
}

/**
 * The lines N written over O's match: a context line is written as the file's
 * own matched line, never the patch's; any other line of N is written as the
 * patch has it, re-indented from P's prefix to F's at tier 2.
 */
function written(o: string[], n: NLine[], fileAt: string[], level: number): string[] {
  let f = '';
  let p = '';
  if (level === 2 && o.length > 0) {
    f = (fileAt[0]!.match(/^[ \t]*/) ?? [''])[0];
    p = (o[0]!.match(/^[ \t]*/) ?? [''])[0];
  }
  return n.map((line) => {
    if (line.ctx !== null) return fileAt[line.ctx] ?? line.text;
    const text = line.text;
    if (level !== 2 || text.trim() === '' || !text.startsWith(p)) return text;
    return f + text.slice(p.length);
  });
}

/** O and N from a hunk's or chunk's body, each N line knowing whether it is context. */
function bodyOn(body: Line[]): { o: string[]; n: NLine[]; tailMark: boolean } {
  const o: string[] = [];
  const n: NLine[] = [];
  for (const l of body) {
    if (l.kind === 'ctx') {
      n.push({ text: l.text, ctx: o.length });
      o.push(l.text);
    } else if (l.kind === 'old') o.push(l.text);
    else if (l.kind === 'new') n.push({ text: l.text, ctx: null });
  }
  let tailMark = false;
  const last = body[body.length - 1];
  if (last !== undefined && last.kind === 'mark') {
    const before = body[body.length - 2];
    tailMark = before !== undefined && (before.kind === 'ctx' || before.kind === 'new');
  }
  return { o, n, tailMark };
}

/* ---------------------------------------------------------------- section 6 */

interface Line {
  kind: 'ctx' | 'old' | 'new' | 'mark';
  text: string;
}

interface Hunk {
  a: number;
  body: Line[];
}

interface Section {
  oldPath: string | null;
  newPath: string | null;
  create: boolean;
  remove: boolean;
  hunks: Hunk[];
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

const headerPath = (line: string): string => {
  const rest = line.slice(4).split('\t')[0]!;
  return rest.trim();
};

function stripAB(p: string): string {
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

/** A unified patch as its sections (SPEC.md section 6), or a parse error. */
function readUnified(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let hunk: Hunk | null = null;

  const finishHunk = (): void => {
    if (hunk !== null && cur !== null) {
      while (hunk.body.length > 0) {
        const t = hunk.body[hunk.body.length - 1]!;
        if (t.kind === 'ctx' && t.text === '') hunk.body.pop();
        else break;
      }
      cur.hunks.push(hunk);
    }
    hunk = null;
  };
  const finishSection = (): void => {
    finishHunk();
    if (cur !== null) sections.push(cur);
    cur = null;
  };
  const startsHeader = (i: number): boolean =>
    lines[i]!.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ');

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      finishSection();
      cur = { oldPath: m[1]!, newPath: m[2]!, create: false, remove: false, hunks: [] };
      continue;
    }
    // A section header inside a hunk's body ends the body: a `--- ` line followed by `+++ `.
    if (startsHeader(i)) {
      // A section's own header (nothing hunked yet) continues that section; any
      // other header — a second section, even with a hunk still open — starts a new one.
      if (cur === null || hunk !== null || cur.hunks.length > 0) {
        finishSection();
        cur = { oldPath: null, newPath: null, create: false, remove: false, hunks: [] };
      }
      const op = headerPath(line);
      const np = headerPath(lines[i + 1]!);
      cur!.oldPath = op === '/dev/null' ? null : stripAB(op);
      cur!.newPath = np === '/dev/null' ? null : stripAB(np);
      if (op === '/dev/null') cur!.create = true;
      if (np === '/dev/null') cur!.remove = true;
      i += 1;
      continue;
    }
    if (line.startsWith('--- ')) {
      // A `--- ` line in a section's header with no `+++ ` after it is a parse error.
      if (cur !== null && cur.hunks.length === 0) throw new Exit2(`error: parse ${i + 2}`);
      if (hunk !== null) {
        finishHunk();
        i -= 1;
      }
      continue;
    }
    if (line.startsWith('@@')) {
      const m = HUNK.exec(line);
      if (m === null || cur === null) throw new Exit2(`error: parse ${i + 1}`);
      finishHunk();
      hunk = { a: Number(m[1]), body: [] };
      continue;
    }
    if (hunk !== null) {
      const c = line[0];
      if (c === ' ' || line === '') hunk.body.push({ kind: 'ctx', text: line === '' ? '' : line.slice(1) });
      else if (c === '-') hunk.body.push({ kind: 'old', text: line.slice(1) });
      else if (c === '+') hunk.body.push({ kind: 'new', text: line.slice(1) });
      else if (c === '\\') hunk.body.push({ kind: 'mark', text: line });
      else {
        finishHunk();
        i -= 1;
      }
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (line.startsWith('rename from ')) cur.oldPath = stripAB(line.slice(12).trim());
      else if (line.startsWith('rename to ')) cur.newPath = stripAB(line.slice(10).trim());
      else if (line.startsWith('new file mode')) cur.create = true;
      else if (line.startsWith('deleted file mode')) cur.remove = true;
    }
  }
  finishSection();

  const edits: Edit[] = [];
  for (const s of sections) {
    const oldPath = s.oldPath;
    const newPath = s.newPath;
    const create = s.create || oldPath === null;
    const remove = s.remove || newPath === null;
    const hunks = s.hunks;
    edits.push((tree) => {
      for (const p of [oldPath, newPath]) if (p !== null && !safe(p)) throw new Fail('unsafe', p);

      if (create) {
        if (newPath === null) throw new Fail('unsafe', '');
        if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
        const out: string[] = [];
        let noFinal = false;
        for (const h of hunks) {
          for (const l of h.body) {
            if (l.kind === 'new') {
              out.push(l.text);
              noFinal = false;
            } else if (l.kind === 'mark') noFinal = true;
          }
        }
        tree.now.set(newPath, out.length === 0 ? '' : out.join('\n') + (noFinal ? '' : '\n'));
        return;
      }
      if (remove) {
        if (oldPath === null) throw new Fail('unsafe', '');
        if (tree.get(oldPath) === null) throw new Fail('missing', oldPath);
        tree.now.set(oldPath, null);
        return;
      }
      if (oldPath === null || newPath === null) throw new Fail('missing', oldPath ?? newPath ?? '');
      const moved = oldPath !== newPath;
      const before = tree.get(oldPath);
      if (before === null) throw new Fail('missing', oldPath);
      if (moved && tree.get(newPath) !== null) throw new Fail('exists', newPath);

      const txt = splitText(before);
      let lines = txt.lines;
      let final = txt.final;
      let d = 0;
      for (const h of hunks) {
        const { o, n, tailMark } = bodyOn(h.body);
        const found = o.length === 0 ? null : findTier(lines, o, strict);
        if (o.length > 0 && found === null) throw new Fail('no-match', oldPath);
        let at: number;
        if (o.length === 0) {
          at = Math.min(Math.max(h.a + d, 0), lines.length);
        } else {
          const target = h.a - 1 + d;
          const cands = found!.at;
          at = cands[0]!;
          let best = Math.abs(cands[0]! - target);
          for (const c of cands) {
            const dist = Math.abs(c - target);
            if (dist < best) {
              best = dist;
              at = c;
            }
          }
        }
        const fileAt = lines.slice(at, at + o.length);
        const nn = written(o, n, fileAt, found === null ? 0 : found.level);
        const runsToEnd = o.length > 0 ? at + o.length === lines.length : at === lines.length;
        if (runsToEnd) final = !tailMark;
        lines = [...lines.slice(0, at), ...nn, ...lines.slice(at + o.length)];
        d += n.length - o.length;
      }
      const out = joinText({ lines, br: txt.br, final });
      if (moved) {
        tree.now.set(oldPath, null);
        tree.now.set(newPath, out);
        tree.moves.push([oldPath, newPath]);
      } else tree.now.set(oldPath, out);
    });
  }
  return edits;
}

/* ---------------------------------------------------------------- section 7 */

function readSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let i = 0;
  let prevPath: string | null = null;
  let sawBlock = false;
  const marker = (l: string): string => l.replace(/[ \t]+$/, '');
  while (i < lines.length) {
    if (marker(lines[i]!) !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    sawBlock = true;
    let path: string | null = null;
    for (let j = i - 1; j >= 0; j -= 1) {
      const cand = lines[j]!;
      const t = cand.trim();
      if (t === '') continue;
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${i + 1}`);
    prevPath = path;
    const oldLines: string[] = [];
    let j = i + 1;
    let sep = -1;
    while (j < lines.length) {
      const t = marker(lines[j]!);
      if (t === '=======') {
        sep = j;
        break;
      }
      if (t === '>>>>>>> REPLACE') break;
      oldLines.push(lines[j]!);
      j += 1;
    }
    if (sep < 0) throw new Exit2(`error: parse ${i + 1}`);
    const newLines: string[] = [];
    let end = sep + 1;
    while (end < lines.length) {
      if (marker(lines[end]!) === '>>>>>>> REPLACE') break;
      newLines.push(lines[end]!);
      end += 1;
    }
    if (end >= lines.length) throw new Exit2(`error: parse ${i + 1}`);
    const p = path;
    const o = oldLines;
    const n = newLines;
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (o.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, n.length === 0 ? '' : n.join('\n') + '\n');
        return;
      }
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const txt = splitText(before);
      const found = findTier(txt.lines, o, strict);
      if (found === null) throw new Fail('no-match', p);
      if (found.at.length > 1) throw new Fail('ambiguous', p);
      const at = found.at[0]!;
      const fileAt = txt.lines.slice(at, at + o.length);
      const nn = written(o, n.map((t) => ({ text: t, ctx: null })), fileAt, found.level);
      const linesOut = [...txt.lines.slice(0, at), ...nn, ...txt.lines.slice(at + o.length)];
      tree.now.set(p, joinText({ lines: linesOut, br: txt.br, final: txt.final }));
    });
    i = end + 1;
  }
  if (!sawBlock) throw new Exit2('error: parse 1');
  return edits;
}

/* ---------------------------------------------------------------- section 8 */

interface Chunk {
  anchor: string | null;
  body: Line[];
  eof: boolean;
}

type V4ASection =
  | { kind: 'add'; path: string; lines: string[] }
  | { kind: 'delete'; path: string }
  | { kind: 'update'; path: string; move: string | null; chunks: Chunk[]; at: number };

function readV4A(lines: string[], strict: boolean): Edit[] {
  const firstNonBlank = lines.findIndex((l) => !blank(l));
  if (firstNonBlank < 0) throw new Exit2('error: parse 1');
  if (lines[firstNonBlank]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${firstNonBlank + 1}`);
  let lastNonBlank = lines.length - 1;
  while (lastNonBlank >= 0 && blank(lines[lastNonBlank]!)) lastNonBlank -= 1;
  if (lastNonBlank < 0 || lines[lastNonBlank]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);

  const sections: V4ASection[] = [];
  type Phase = 'none' | 'add' | 'delete' | 'update';
  let phase: Phase = 'none';
  let cur: { path: string; move: string | null; chunks: Chunk[]; lines: string[]; at: number } | null = null;
  let chunk: Chunk | null = null;

  const closeChunk = (): void => {
    if (chunk !== null && cur !== null) {
      // Blank lines at the end of a section are not part of it (section 8).
      while (chunk.body.length > 0) {
        const t = chunk.body[chunk.body.length - 1]!;
        if (t.kind === 'ctx' && t.text.trim() === '') chunk.body.pop();
        else break;
      }
      cur.chunks.push(chunk);
    }
    chunk = null;
  };
  const closeSection = (): void => {
    closeChunk();
    if (cur === null) {
      phase = 'none';
      return;
    }
    if (phase === 'add') sections.push({ kind: 'add', path: cur.path, lines: cur.lines });
    else if (phase === 'delete') sections.push({ kind: 'delete', path: cur.path });
    else {
      if (cur.chunks.length === 0 && cur.move === null) throw new Exit2(`error: parse ${cur.at}`);
      sections.push({ kind: 'update', path: cur.path, move: cur.move, chunks: cur.chunks, at: cur.at });
    }
    cur = null;
    phase = 'none';
  };

  for (let i = firstNonBlank + 1; i < lastNonBlank; i += 1) {
    const line = lines[i]!;
    if (line.startsWith('*** Add File: ')) {
      closeSection();
      phase = 'add';
      cur = { path: line.slice(14).trim(), move: null, chunks: [], lines: [], at: i + 1 };
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      closeSection();
      phase = 'delete';
      cur = { path: line.slice(17).trim(), move: null, chunks: [], lines: [], at: i + 1 };
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      closeSection();
      phase = 'update';
      cur = { path: line.slice(17).trim(), move: null, chunks: [], lines: [], at: i + 1 };
      continue;
    }
    if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
    if (phase === 'add') {
      if (line === '') cur.lines.push('');
      else if (line.startsWith('+')) cur.lines.push(line.slice(1));
      else throw new Exit2(`error: parse ${i + 1}`);
      continue;
    }
    if (phase === 'delete') {
      if (!blank(line)) throw new Exit2(`error: parse ${i + 1}`);
      continue;
    }
    if (line.startsWith('*** Move to: ')) {
      if (chunk !== null || cur.chunks.length > 0 || cur.move !== null) throw new Exit2(`error: parse ${i + 1}`);
      cur.move = line.slice(13).trim();
      continue;
    }
    if (line.startsWith('@@')) {
      closeChunk();
      const anchor = line.slice(2).trim();
      chunk = { anchor: anchor === '' ? null : anchor, body: [], eof: false };
      continue;
    }
    if (line.trim() === '*** End of File') {
      if (chunk === null) throw new Exit2(`error: parse ${i + 1}`);
      chunk.eof = true;
      continue;
    }
    const c = line[0];
    if (c === ' ' || c === '-' || c === '+' || line === '') {
      if (chunk === null) chunk = { anchor: null, body: [], eof: false };
      if (line === '') chunk.body.push({ kind: 'ctx', text: '' });
      else chunk.body.push({ kind: c === ' ' ? 'ctx' : c === '-' ? 'old' : 'new', text: line.slice(1) });
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  closeSection();

  const edits: Edit[] = [];
  for (const s of sections) {
    if (s.kind === 'add') {
      const p = s.path;
      const body = s.lines;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, body.length === 0 ? '' : body.join('\n') + '\n');
      });
      continue;
    }
    if (s.kind === 'delete') {
      const p = s.path;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      });
      continue;
    }
    const p = s.path;
    const move = s.move;
    const chunks = s.chunks;
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (move !== null && !safe(move)) throw new Fail('unsafe', move);
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      if (move !== null && tree.get(move) !== null) throw new Fail('exists', move);
      const txt = splitText(before);
      let lines = txt.lines;
      const final = txt.final;
      let cursor = 0;
      for (const ch of chunks) {
        if (ch.anchor !== null) {
          let hit = -1;
          outer: for (let lvl = 0; lvl < 3; lvl += 1) {
            for (let k = cursor; k < lines.length; k += 1) {
              if (tier(lines[k]!, lvl) === tier(ch.anchor, lvl)) {
                hit = k;
                break outer;
              }
            }
          }
          if (hit < 0) throw new Fail('no-match', p);
          cursor = hit + 1;
        }
        const { o, n } = bodyOn(ch.body);
        const from = cursor;
        const found = o.length === 0 ? null : findTier(lines.slice(from), o, strict);
        let at: number;
        if (o.length === 0) {
          at = ch.eof ? lines.length : cursor;
        } else {
          if (found === null) throw new Fail('no-match', p);
          const all = found.at.map((x) => from + x);
          if (ch.eof) {
            const good = all.filter((x) => x + o.length === lines.length);
            if (good.length === 0) throw new Fail('no-match', p);
            at = good[0]!;
          } else at = all[0]!;
        }
        const fileAt = lines.slice(at, at + o.length);
        const nn = written(o, n, fileAt, found === null ? 0 : found.level);
        lines = [...lines.slice(0, at), ...nn, ...lines.slice(at + o.length)];
        cursor = at + nn.length;
      }
      const out = joinText({ lines, br: txt.br, final });
      if (move !== null) {
        tree.now.set(p, null);
        tree.now.set(move, out);
        tree.moves.push([p, move]);
      } else tree.now.set(p, out);
    });
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

/* --------------------------------------------------------------- section 4 */

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/* --------------------------------------------------------------- section 9 */

function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* -------------------------------------------------------------- sections 1-2 */

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits = kind === 'json'
      ? jsonEdits(text, lines)
      : kind === 'unified'
        ? readUnified(lines, strict)
        : kind === 'search-replace'
          ? readSearchReplace(lines, strict)
          : readV4A(lines, strict);
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };

  const movedFrom = new Set(tree.moves.map(([o]) => o));
  const movedTo = new Set(tree.moves.map(([, n]) => n));
  const rows: Array<{ key: string; line: string }> = [];
  for (const [o, n] of tree.moves) rows.push({ key: n, line: `R ${o} -> ${n}` });
  for (const p of tree.now.keys()) {
    if (movedFrom.has(p) || movedTo.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));

  if (!check) {
    for (const p of tree.now.keys()) {
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else if (tree.original(p) !== now) {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const out = rows.map((r) => r.line);
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
