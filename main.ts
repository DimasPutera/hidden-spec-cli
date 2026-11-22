// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
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

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
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

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
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

// ---- §5 + §6: unified diffs ----

const movePairs: Array<[string, string]> = [];

function leadWS(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

function rtrimST(s: string): string {
  return s.replace(/[ \t]+$/, '');
}

function trimST(s: string): string {
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function stripAB(p: string): string {
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

function parseFilePath(l: string): string | null {
  const p = l.slice(4).split('\t')[0]!.trim();
  if (p === '/dev/null') return null;
  return stripAB(p);
}

interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  body: string[];
  noEol: boolean;
}

interface Section {
  pairOld: string | null;
  pairNew: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  gitOld: string | null;
  gitNew: string | null;
  newFile: boolean;
  deletedFile: boolean;
  hasPair: boolean;
  headerDone: boolean;
  hunks: Hunk[];
  oldPath: string | null;
  newPath: string | null;
}

function newSection(): Section {
  return {
    pairOld: null,
    pairNew: null,
    renameFrom: null,
    renameTo: null,
    gitOld: null,
    gitNew: null,
    newFile: false,
    deletedFile: false,
    hasPair: false,
    headerDone: false,
    hunks: [],
    oldPath: null,
    newPath: null,
  };
}

/** Parse unified diff text (SPEC.md §6) into sections; throws Exit2 on parse error. */
function parseUnified(lines: string[]): Section[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  const err = (lineNo: number): never => {
    throw new Exit2(`error: parse ${lineNo}`);
  };
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    const lineNo = i + 1;
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+)\s+b\/(\S+)\s*$/.exec(l);
      if (!m) err(lineNo);
      cur = newSection();
      cur.gitOld = m[1]!;
      cur.gitNew = m[2]!;
      sections.push(cur);
      i++;
      continue;
    }
    if (l.startsWith('--- ')) {
      const next = lines[i + 1];
      if (next !== undefined && next.startsWith('+++ ')) {
        if (cur !== null && !cur.headerDone && !cur.hasPair) {
          cur.pairOld = parseFilePath(l);
          cur.pairNew = parseFilePath(next);
          cur.hasPair = true;
        } else {
          cur = newSection();
          cur.pairOld = parseFilePath(l);
          cur.pairNew = parseFilePath(next);
          cur.hasPair = true;
          sections.push(cur);
        }
        i += 2;
        continue;
      }
      if (cur !== null && !cur.headerDone && !cur.hasPair) err(lineNo + 1);
      i++;
      continue;
    }
    if (l.startsWith('+++ ')) {
      i++;
      continue;
    }
    if (l.startsWith('@@')) {
      if (cur === null) err(lineNo);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(l);
      if (!m) err(lineNo);
      cur.headerDone = true;
      const hunk: Hunk = {
        oldStart: Number(m[1]),
        oldCount: m[2] === undefined ? 1 : Number(m[2]),
        newStart: Number(m[3]),
        newCount: m[4] === undefined ? 1 : Number(m[4]),
        body: [],
        noEol: false,
      };
      i++;
      while (i < lines.length) {
        const b = lines[i]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (b === '' || b.startsWith(' ') || b.startsWith('-') || b.startsWith('+') || b.startsWith('\\')) {
          hunk.body.push(b);
          i++;
          continue;
        }
        break;
      }
      while (hunk.body.length > 0 && hunk.body[hunk.body.length - 1] === '') hunk.body.pop();
      for (let j = hunk.body.length - 1; j >= 0; j--) {
        const bl = hunk.body[j]!;
        if (bl.startsWith(' ') || bl === '' || bl.startsWith('+')) {
          hunk.noEol = j + 1 < hunk.body.length && hunk.body[j + 1]!.startsWith('\\');
          break;
        }
      }
      cur.hunks.push(hunk);
      continue;
    }
    if (cur !== null && !cur.headerDone) {
      if (l.startsWith('rename from ')) cur.renameFrom = l.slice('rename from '.length).trim();
      else if (l.startsWith('rename to ')) cur.renameTo = l.slice('rename to '.length).trim();
      else if (l.startsWith('new file mode')) cur.newFile = true;
      else if (l.startsWith('deleted file mode')) cur.deletedFile = true;
      i++;
      continue;
    }
    i++;
  }
  for (const s of sections) {
    s.oldPath = s.pairOld ?? s.renameFrom ?? s.gitOld;
    s.newPath = s.pairNew ?? s.renameTo ?? s.gitNew;
  }
  return sections;
}

function lineEq(tier: number, a: string, b: string): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return rtrimST(a) === rtrimST(b);
  return trimST(a) === trimST(b);
}

/** Nearest occurrence of O in fileLines at the given tier (ties → earlier). Tiers tried in order; --strict = tier 0 only. */
function findMatch(fileLines: string[], O: string[], hint: number, strict: boolean): { index: number; tier: number } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    let best = -1;
    let bestDist = Infinity;
    for (let p = 0; p + O.length <= fileLines.length; p++) {
      let ok = true;
      for (let k = 0; k < O.length; k++) {
        if (!lineEq(tier, O[k]!, fileLines[p + k]!)) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      const dist = Math.abs(p - hint);
      if (dist < bestDist) {
        bestDist = dist;
        best = p;
      }
    }
    if (best >= 0) return { index: best, tier };
  }
  return null;
}

interface FileState {
  lines: string[];
  br: string;
  finalBreak: boolean;
}

function splitContent(text: string): FileState {
  const br = text.includes('\r\n') ? '\r\n' : '\n';
  const finalBreak = text !== '' && text.endsWith('\n');
  let lines: string[] = [];
  if (text !== '') {
    lines = text.split('\n');
    if (finalBreak) lines.pop();
    lines = lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
  }
  return { lines, br, finalBreak };
}

function joinContent(s: FileState): string {
  if (s.lines.length === 0) return '';
  return s.lines.join(s.br) + (s.finalBreak ? s.br : '');
}

/** Apply one hunk; d is the cumulative N−O length delta of earlier hunks in the section. */
function applyHunk(state: FileState, hunk: Hunk, d: number, strict: boolean, path: string): { state: FileState; d: number } {
  const O: string[] = [];
  const N: Array<{ ctx: number } | { add: string }> = [];
  for (const b of hunk.body) {
    if (b.startsWith(' ')) {
      O.push(b.slice(1));
      N.push({ ctx: O.length - 1 });
    } else if (b.startsWith('-')) {
      O.push(b.slice(1));
    } else if (b.startsWith('+')) {
      N.push({ add: b.slice(1) });
    } else if (b === '') {
      O.push('');
      N.push({ ctx: O.length - 1 });
    }
  }
  const lines = state.lines;
  const delta = N.length - O.length;
  if (O.length === 0) {
    const at = Math.max(0, Math.min(hunk.oldStart + d, lines.length));
    const added = N.map((e) => (e as { add: string }).add);
    const out = [...lines.slice(0, at), ...added, ...lines.slice(at)];
    return { state: { lines: out, br: state.br, finalBreak: at === lines.length ? !hunk.noEol : state.finalBreak }, d: d + delta };
  }
  const m = findMatch(lines, O, hunk.oldStart - 1 + d, strict);
  if (m === null) throw new Fail('no-match', path);
  const P = leadWS(O[0]!);
  const F = leadWS(lines[m.index]!);
  const rep = N.map((e) => {
    if ('ctx' in e) return lines[m.index + e.ctx]!;
    let s = e.add;
    if (m.tier === 2 && s.trim() !== '' && s.startsWith(P)) s = F + s.slice(P.length);
    return s;
  });
  const out = [...lines.slice(0, m.index), ...rep, ...lines.slice(m.index + O.length)];
  return {
    state: { lines: out, br: state.br, finalBreak: m.index + O.length === lines.length ? !hunk.noEol : state.finalBreak },
    d: d + delta,
  };
}

function applySection(tree: Tree, s: Section, strict: boolean): void {
  const oldP = s.oldPath;
  const newP = s.newPath;
  if (s.newFile || oldP === null) {
    const np = newP;
    if (np === null) throw new Fail('missing', oldP ?? '');
    if (!safe(np)) throw new Fail('unsafe', np);
    if (tree.get(np) !== null) throw new Fail('exists', np);
    const out: string[] = [];
    for (const h of s.hunks) {
      for (const b of h.body) if (b.startsWith('+')) out.push(b.slice(1));
    }
    const last = s.hunks[s.hunks.length - 1];
    tree.now.set(np, out.length === 0 ? '' : out.join('\n') + (last !== undefined && last.noEol ? '' : '\n'));
    return;
  }
  if (s.deletedFile || newP === null) {
    const op = oldP;
    if (op === null) throw new Fail('missing', '');
    if (!safe(op)) throw new Fail('unsafe', op);
    if (tree.get(op) === null) throw new Fail('missing', op);
    tree.now.set(op, null);
    return;
  }
  const op = oldP!;
  const np = newP!;
  if (!safe(op)) throw new Fail('unsafe', op);
  if (!safe(np)) throw new Fail('unsafe', np);
  const before = tree.get(op);
  if (before === null) throw new Fail('missing', op);
  if (op !== np && tree.get(np) !== null) throw new Fail('exists', np);
  let state = splitContent(before);
  let d = 0;
  for (const h of s.hunks) {
    const r = applyHunk(state, h, d, strict, op);
    state = r.state;
    d = r.d;
  }
  if (op !== np) {
    tree.now.set(op, null);
    tree.now.set(np, joinContent(state));
    movePairs.push([op, np]);
  } else {
    tree.now.set(op, joinContent(state));
  }
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections = parseUnified(lines);
  return sections.map((s) => (tree: Tree) => applySection(tree, s, strict));
}

// ---- §7: search/replace ----

/** Parse search/replace blocks (SPEC.md §7) into edits; throws Exit2 on parse error. */
function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  interface Block {
    path: string;
    old: string[];
    nw: string[];
  }
  const blocks: Block[] = [];
  const err = (lineNo: number): never => {
    throw new Exit2(`error: parse ${lineNo}`);
  };
  let i = 0;
  let prevReplaceEnd = -1;
  let prevPath: string | null = null;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i + 1;
    let path: string | null = null;
    for (let j = i - 1; j > prevReplaceEnd; j--) {
      const c = lines[j]!;
      if (blank(c)) continue;
      if (c.trimStart().startsWith('```')) continue;
      path = c.trim();
      break;
    }
    if (path === null) {
      if (prevPath !== null) path = prevPath;
      else err(searchLine);
    }
    let eq = -1;
    for (let j = i + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') {
        eq = j;
        break;
      }
      if (t === '>>>>>>> REPLACE') break;
    }
    if (eq < 0) err(searchLine);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) err(searchLine);
    blocks.push({ path, old: lines.slice(i + 1, eq), nw: lines.slice(eq + 1, rep) });
    prevPath = path;
    prevReplaceEnd = rep;
    i = rep + 1;
  }
  return blocks.map((b) => (tree: Tree) => {
    const p = b.path;
    if (b.old.length === 0) {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, b.nw.length === 0 ? '' : b.nw.join('\n') + '\n');
      return;
    }
    if (!safe(p)) throw new Fail('unsafe', p);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    const state = splitContent(before);
    const tiers = strict ? [0] : [0, 1, 2];
    let found: { index: number; tier: number } | null = null;
    for (const tier of tiers) {
      const hits: number[] = [];
      for (let q = 0; q + b.old.length <= state.lines.length; q++) {
        let ok = true;
        for (let k = 0; k < b.old.length; k++) {
          if (!lineEq(tier, b.old[k]!, state.lines[q + k]!)) {
            ok = false;
            break;
          }
        }
        if (ok) hits.push(q);
      }
      if (hits.length === 1) {
        found = { index: hits[0]!, tier };
        break;
      }
      if (hits.length > 1) throw new Fail('ambiguous', p);
    }
    if (found === null) throw new Fail('no-match', p);
    const P = leadWS(b.old[0]!);
    const F = leadWS(state.lines[found.index]!);
    const rep = b.nw.map((s) => {
      if (found!.tier === 2 && s.trim() !== '' && s.startsWith(P)) return F + s.slice(P.length);
      return s;
    });
    const out = [...state.lines.slice(0, found.index), ...rep, ...state.lines.slice(found.index + b.old.length)];
    tree.now.set(p, joinContent({ lines: out, br: state.br, finalBreak: state.finalBreak }));
  });
}

// ---- §8: V4A ----

interface V4aChunk {
  anchor: string | null;
  eof: boolean;
  body: string[];
}

interface V4aSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  lines: string[];
  chunks: V4aChunk[];
  headerLine: number;
}

/** Parse V4A patches (SPEC.md §8) into edits; throws Exit2 on parse error. */
function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const err = (lineNo: number): never => {
    throw new Exit2(`error: parse ${lineNo}`);
  };
  let first = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!blank(lines[i]!)) {
      first = i;
      break;
    }
  }
  if (first < 0) err(1);
  if (lines[first]!.trim() !== '*** Begin Patch') err(first + 1);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') err(lines.length + 1);
  const header = (l: string): { kind: 'add' | 'delete' | 'update'; path: string } | null => {
    if (l.startsWith('*** Add File:')) return { kind: 'add', path: l.slice('*** Add File:'.length).trim() };
    if (l.startsWith('*** Delete File:')) return { kind: 'delete', path: l.slice('*** Delete File:'.length).trim() };
    if (l.startsWith('*** Update File:')) return { kind: 'update', path: l.slice('*** Update File:'.length).trim() };
    return null;
  };
  const sections: V4aSection[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i++;
      continue;
    }
    const h = header(l);
    if (h === null) err(i + 1);
    const sec: V4aSection = { kind: h.kind, path: h.path, moveTo: null, lines: [], chunks: [], headerLine: i + 1 };
    i++;
    const raw: number[] = [];
    while (i < last) {
      const t = lines[i]!;
      if (!blank(t) && header(t) !== null) break;
      if (!blank(t) && t.trim() === '*** End Patch') break;
      raw.push(i);
      i++;
    }
    while (raw.length > 0 && blank(lines[raw[raw.length - 1]!]!)) raw.pop();
    sec.lines = raw.map((idx) => lines[idx]!);
    if (sec.kind === 'add') {
      for (const idx of raw) {
        const t = lines[idx]!;
        if (t === '' || t.startsWith('+')) continue;
        err(idx + 1);
      }
    } else if (sec.kind === 'delete') {
      if (raw.length > 0) err(raw[0]! + 1);
    } else {
      let j = 0;
      if (j < raw.length && lines[raw[j]!]!.startsWith('*** Move to:')) {
        sec.moveTo = lines[raw[j]!]!.slice('*** Move to:'.length).trim();
        j++;
      }
      let cur: V4aChunk | null = null;
      const push = (): void => {
        if (cur !== null) {
          sec.chunks.push(cur);
          cur = null;
        }
      };
      for (; j < raw.length; j++) {
        const idx = raw[j]!;
        const t = lines[idx]!;
        if (t.startsWith('@@')) {
          push();
          cur = { anchor: t.slice(2).trim(), eof: false, body: [] };
          continue;
        }
        if (t.trim() === '*** End of File') {
          if (cur === null) cur = { anchor: null, eof: false, body: [] };
          cur.eof = true;
          push();
          continue;
        }
        if (t === '' || t.startsWith(' ') || t.startsWith('-') || t.startsWith('+')) {
          if (cur === null) cur = { anchor: null, eof: false, body: [] };
          cur.body.push(t);
          continue;
        }
        err(idx + 1);
      }
      push();
      if (sec.chunks.length === 0 && sec.moveTo === null) err(sec.headerLine);
    }
    sections.push(sec);
  }
  return sections.map((sec) => (tree: Tree) => {
    if (sec.kind === 'add') {
      if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
      if (tree.get(sec.path) !== null) throw new Fail('exists', sec.path);
      const out = sec.lines.map((t) => (t === '' ? '' : t.slice(1)));
      tree.now.set(sec.path, out.length === 0 ? '' : out.join('\n') + '\n');
      return;
    }
    if (sec.kind === 'delete') {
      if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
      if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
      tree.now.set(sec.path, null);
      return;
    }
    if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
    if (sec.moveTo !== null && !safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
    const before = tree.get(sec.path);
    if (before === null) throw new Fail('missing', sec.path);
    if (sec.moveTo !== null && tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
    let state = splitContent(before);
    let cursor = 0;
    for (const ch of sec.chunks) {
      if (ch.anchor !== null && ch.anchor !== '') {
        const tiers = strict ? [0] : [0, 1, 2];
        let ai = -1;
        for (const tier of tiers) {
          for (let q = cursor; q < state.lines.length; q++) {
            if (lineEq(tier, ch.anchor, state.lines[q]!)) {
              ai = q;
              break;
            }
          }
          if (ai >= 0) break;
        }
        if (ai < 0) throw new Fail('no-match', sec.path);
        cursor = ai + 1;
      }
      const O: string[] = [];
      const N: Array<{ ctx: number } | { add: string }> = [];
      for (const b of ch.body) {
        if (b === '' || b.startsWith(' ')) {
          const c = b === '' ? '' : b.slice(1);
          O.push(c);
          N.push({ ctx: O.length - 1 });
        } else if (b.startsWith('-')) O.push(b.slice(1));
        else if (b.startsWith('+')) N.push({ add: b.slice(1) });
      }
      if (O.length === 0) {
        const at = ch.eof ? state.lines.length : cursor;
        const added = N.map((e) => (e as { add: string }).add);
        const out = [...state.lines.slice(0, at), ...added, ...state.lines.slice(at)];
        state = { lines: out, br: state.br, finalBreak: state.finalBreak };
        cursor = at + added.length;
        continue;
      }
      const tiers = strict ? [0] : [0, 1, 2];
      let found: { index: number; tier: number } | null = null;
      for (const tier of tiers) {
        for (let q = cursor; q + O.length <= state.lines.length; q++) {
          if (ch.eof && q + O.length !== state.lines.length) continue;
          let ok = true;
          for (let k = 0; k < O.length; k++) {
            if (!lineEq(tier, O[k]!, state.lines[q + k]!)) {
              ok = false;
              break;
            }
          }
          if (ok) {
            found = { index: q, tier };
            break;
          }
        }
        if (found !== null) break;
      }
      if (found === null) throw new Fail('no-match', sec.path);
      const P = leadWS(O[0]!);
      const F = leadWS(state.lines[found.index]!);
      const rep = N.map((e) => {
        if ('ctx' in e) return state.lines[found!.index + e.ctx]!;
        const s = e.add;
        if (found!.tier === 2 && s.trim() !== '' && s.startsWith(P)) return F + s.slice(P.length);
        return s;
      });
      const out = [...state.lines.slice(0, found.index), ...rep, ...state.lines.slice(found.index + O.length)];
      state = { lines: out, br: state.br, finalBreak: state.finalBreak };
      cursor = found.index + rep.length;
    }
    if (sec.moveTo !== null) {
      tree.now.set(sec.path, null);
      tree.now.set(sec.moveTo, joinContent(state));
      movePairs.push([sec.path, sec.moveTo]);
    } else {
      tree.now.set(sec.path, joinContent(state));
    }
  });
}

function collapseMoves(rows: string[]): string[] {
  if (movePairs.length === 0) return rows;
  const oldToNew = new Map<string, string>(movePairs);
  const newSet = new Set(movePairs.map(([, n]) => n));
  const kept: Array<{ key: string; row: string }> = [];
  for (const row of rows) {
    const p = row.slice(2);
    if (row.startsWith('D ') && oldToNew.has(p)) continue;
    if (row.startsWith('A ') && newSet.has(p)) continue;
    kept.push({ key: p, row });
  }
  for (const [o, n] of movePairs) kept.push({ key: n, row: `R ${o} -> ${n}` });
  kept.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  return kept.map((k) => k.row);
}

function run(args: string[]): { code: number; out: string[] } {
  movePairs.length = 0;
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
    edits = kind === 'json' ? jsonEdits(text, lines) : kind === 'unified' ? unifiedEdits(lines, strict) : kind === 'search-replace' ? searchReplaceEdits(lines, strict) : kind === 'v4a' ? v4aEdits(lines, strict) : [];
    if (edits.length === 0) throw new Exit2('error: parse 1');
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
  const rows: string[] = [];
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push(`${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`);
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  const finalRows = collapseMoves(rows);
  return { code: 0, out: [...finalRows, `ok: ${finalRows.length} ${finalRows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
