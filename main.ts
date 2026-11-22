// main.ts is mend, the CLI SPEC.md specifies: one tool that applies an edit an AI model wrote, in a unified diff, a
// SEARCH/REPLACE block, a V4A patch or JSON tool calls, to a tree of files, all or nothing. Node 22, the standard
// library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) { this.line = line; }
}

class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) { this.code = code; this.path = path; }
}

const blank = (s: string): boolean => s.trim() === '';

/** Section 3: a patch's lines are its text split at LF, each with one trailing CR removed. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** Section 3: a file's own line break, its lines, and whether it ends with a line break. */
function splitFile(text: string): { br: string; lines: string[]; final: boolean } {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { br, lines, final };
}

function joinFile(br: string, lines: string[], final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  /** The old path of each move made this run, for the `R old -> new` lines of section 2. */
  readonly moved = new Map<string, string>();
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

// ---------------------------------------------------------------------------
// Section 5: matching old lines at three tiers
// ---------------------------------------------------------------------------

const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const indentOf = (s: string): string => s.match(/^[ \t]*/)?.[0] ?? '';

function norm(s: string, tier: number): string {
  return tier === 0 ? s : tier === 1 ? stripTrail(s) : stripBoth(s);
}

interface Occurrence {
  tier: number;
  at: number;
  /** The file's own lines at the match: a context line is written as this one. */
  own: string[];
}

/** Every position at which O matches the file's lines at one tier. Occurrences may overlap. */
function atTier(lines: string[], O: string[], tier: number): Occurrence[] {
  const out: Occurrence[] = [];
  if (O.length === 0 || O.length > lines.length) return out;
  const want = O.map((o) => norm(o, tier));
  for (let i = 0; i + O.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < O.length; j += 1) {
      if (norm(lines[i + j]!, tier) !== want[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push({ tier, at: i, own: lines.slice(i, i + O.length) });
  }
  return out;
}

/** O at the first tier where it occurs at least once (`--strict`: tier 0 only). */
function findOccurrences(lines: string[], O: string[], strict: boolean): Occurrence[] {
  for (let tier = 0; tier <= (strict ? 0 : 2); tier += 1) {
    const got = atTier(lines, O, tier);
    if (got.length > 0) return got;
  }
  return [];
}

/** N as written: a context line is the file's own matched line; at tier 2 every non-empty, non-context line of N
 *  is re-indented. The re-indentation is computed from the file's first matched line (F) and the content of the
 *  chunk's first O line (P). A `+` line that is not empty and not only whitespace and starts with P has that P
 *  replaced by F. */
function writeN(N: string[], own: string[], tier: number): string[] {
  if (tier !== 2) return [...N];
  const F = indentOf(own[0] ?? '');
  const P = indentOf(N[0] ?? '');
  return N.map((line) => {
    if (line === '' || /^[ \t]*$/.test(line)) return line;
    if (line.startsWith(P)) return F + line.slice(P.length);
    return line;
  });
}

/** N spliced over the matched lines of O, or inserted when O is empty. */
function splice(lines: string[], O: string[], N: string[], hit: Occurrence, ins: number): string[] {
  const out = [...lines];
  if (O.length === 0) {
    const at = Math.min(Math.max(ins, 0), lines.length);
    out.splice(at, 0, ...N);
    return out;
  }
  out.splice(hit.at, O.length, ...writeN(N, hit.own, hit.tier));
  return out;
}

// ---------------------------------------------------------------------------
// Section 6: unified diffs
// ---------------------------------------------------------------------------

interface Hunk {
  A: number;
  O: string[];
  N: string[];
  /** Per N line: ' ' (context), '' (empty context), '+' (new). */
  kindsN: string[];
  /** For each N line, the O-index of its matched file line (context lines only). */
  ownAt: number[];
  noNewline: boolean;
}

interface USection {
  oldPath: string;
  newPath: string;
  creation: boolean;
  deletion: boolean;
  /** Each path was named by a `---`/`+++` pair or `rename from`/`rename to`, not only by `diff --git`. */
  oldNamed: boolean;
  newNamed: boolean;
  hunks: Hunk[];
}

function pathFromHeader(rest: string): string {
  const p = rest.split('\t')[0].trim();
  return p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p;
}

const hunkHead = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/;

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let sec: USection | null = null;
  let hunk: Hunk | null = null;

  const closeHunk = (): void => {
    if (hunk !== null && sec !== null) {
      sec.hunks.push(hunk);
    }
    hunk = null;
  };

  const closeSection = (): void => {
    closeHunk();
    if (sec !== null) {
      edits.push(unifiedEdit(sec, strict));
      sec = null;
    }
  };

  const openSection = (oldPath: string, newPath: string): void => {
    closeSection();
    if (oldPath === '' && newPath === '') throw new Exit2(`error: parse 1`);
    sec = { oldPath, newPath, creation: false, deletion: false, oldNamed: false, newNamed: false, hunks: [] };
  };

  let saw = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const parts = line.slice('diff --git '.length).trim().split(' ');
      if (parts.length < 2 || !parts[0]!.startsWith('a/') || !parts[1]!.startsWith('b/')) {
        throw new Exit2(`error: parse ${i + 1}`);
      }
      openSection(parts[0]!.slice(2), parts[1]!.slice(2));
      saw = true;
      continue;
    }
    if (line.startsWith('@@')) {
      if (sec === null) throw new Exit2(`error: parse ${i + 1}`);
      closeHunk();
      if (!hunkHead.test(line)) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(line)!;
      hunk = { A: Number(m[1]), O: [], N: [], kindsN: [], ownAt: [], noNewline: false };
      continue;
    }
    if (hunk !== null) {
      if (line.startsWith(' ')) {
        hunk.O.push(line.slice(1));
        hunk.N.push(line.slice(1));
        hunk.kindsN.push(' ');
        continue;
      }
      if (line.startsWith('-')) {
        hunk.O.push(line.slice(1));
        hunk.kindsN.push('');
        continue;
      }
      if (line.startsWith('+')) {
        hunk.N.push(line.slice(1));
        hunk.kindsN.push('+');
        continue;
      }
      if (line === '\\') {
        hunk.noNewline = true;
        continue;
      }
      if (line === '') {
        // An empty line is a context line whose text is empty; empty lines at the end of the body are not in it.
        let j = i;
        while (j < lines.length && lines[j] === '') j += 1;
        const next = j < lines.length ? lines[j]! : null;
        if (next === null) {
          i = j - 1;
          continue;
        }
        if (next.startsWith('diff --git ') || next.startsWith('@@')) {
          closeHunk();
          i = j - 1;
          continue;
        }
        if (next.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) {
          closeSection();
          i = j - 1;
          continue;
        }
        hunk.O.push('');
        hunk.N.push('');
        hunk.kindsN.push(' ');
        continue;
      }
      closeHunk();
      i -= 1;
      continue;
    }
    if (line.startsWith('--- ')) {
      const next = lines[i + 1] ?? '';
      if (!next.startsWith('+++ ')) throw new Exit2(`error: parse ${i + 2}`);
      const oldPath = pathFromHeader(line.slice(4));
      const newPath = pathFromHeader(next.slice(4));
      if (sec === null) openSection(oldPath, newPath);
      else {
        sec.oldPath = oldPath;
        sec.newPath = newPath;
        sec.oldNamed = true;
        sec.newNamed = true;
      }
      saw = true;
      i += 1;
      continue;
    }
    if (line.startsWith('+++ ')) continue;
    if (line.startsWith('rename from ')) {
      if (sec !== null) {
        sec.oldPath = line.slice('rename from '.length).trim();
        sec.oldNamed = true;
      }
      continue;
    }
    if (line.startsWith('rename to ')) {
      if (sec !== null) {
        sec.newPath = line.slice('rename to '.length).trim();
        sec.newNamed = true;
      }
      continue;
    }
    if (line.startsWith('new file mode')) {
      if (sec !== null) sec.creation = true;
      continue;
    }
    if (line.startsWith('deleted file mode')) {
      if (sec !== null) sec.deletion = true;
      continue;
    }
    // index, modes, similarity and every other line outside a body are ignored.
  }
  closeSection();
  if (!saw) return [];
  return edits;
}

function unifiedEdit(sec: USection, strict: boolean): Edit {
  const oldPath = sec.oldNamed ? sec.oldPath : sec.oldPath;
  const newPath = sec.newNamed ? sec.newPath : sec.newPath;
  const create = sec.creation || oldPath === '/dev/null';
  const remove = sec.deletion || newPath === '/dev/null';
  const move = oldPath !== newPath;
  return (tree: Tree): void => {
    if (create) {
      if (!safe(newPath)) throw new Fail('unsafe', newPath);
      if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
      const lines: string[] = [];
      for (const h of sec.hunks) for (const l of h.N) lines.push(l);
      tree.now.set(newPath, lines.length === 0 ? '' : lines.join('\n') + (sec.noNewline ? '' : '\n'));
      return;
    }
    if (remove) {
      if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
      if (tree.get(oldPath) === null) throw new Fail('missing', oldPath);
      tree.now.set(oldPath, null);
      return;
    }
    if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
    if (!safe(newPath)) throw new Fail('unsafe', newPath);
    const before = tree.get(oldPath);
    if (before === null) throw new Fail('missing', oldPath);
    const { br, lines, final } = splitFile(before);
    let cur = lines;
    let d = 0;
    let lastNo = false;
    for (const h of sec.hunks) {
      const target = h.A - 1 + d;
      if (h.O.length === 0) {
        // Empty O: insert after the first A + d lines (a unified `@@ -A ...` line is 1-based, so the insert
        // position is A + d, not A - 1 + d).
        const at = Math.min(Math.max(h.A + d, 0), cur.length);
        cur = splice(cur, [], h.N, { tier: 0, at: 0, own: [] }, at);
      } else {
        const found = findOccurrences(cur, h.O, strict);
        if (found.length === 0) throw new Fail('no-match', oldPath);
        let best = found[0]!;
        for (const o of found.slice(1)) {
          if (Math.abs(o.at - target) < Math.abs(best.at - target)) best = o;
        }
        cur = splice(cur, h.O, h.N, best, 0);
      }
      lastNo = h.noNewline;
      d += h.N.length - h.O.length;
    }
    const text = joinFile(br, cur, lastNo ? false : final);
    tree.now.set(oldPath, null);
    tree.now.set(newPath, text);
    if (move) tree.moved.set(newPath, oldPath);
  };
}

// ---------------------------------------------------------------------------
// Section 7: SEARCH/REPLACE blocks
// ---------------------------------------------------------------------------

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let i = 0;
  let lastPath: string | null = null;
  const n = lines.length;
  while (i < n) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i + 1;
    let path: string | null = lastPath;
    for (let k = i - 1; k >= 0; k -= 1) {
      const l = lines[k]!;
      if (l.trim() !== '' && !l.trimStart().startsWith('```')) {
        path = l.trim();
        break;
      }
    }
    if (path === null) throw new Exit2(`error: parse ${searchLine}`);
    let sep = i + 1;
    while (sep < n && lines[sep]!.trimEnd() !== '=======') sep += 1;
    if (sep >= n) throw new Exit2(`error: parse ${searchLine}`);
    let end = sep + 1;
    while (end < n && lines[end]!.trimEnd() !== '>>>>>>> REPLACE') end += 1;
    if (end >= n) throw new Exit2(`error: parse ${searchLine}`);
    const O = lines.slice(i + 1, sep);
    const N = lines.slice(sep + 1, end);
    edits.push(srEdit(path, O, N, strict));
    lastPath = path;
    i = end + 1;
  }
  return edits;
}

function srEdit(path: string, O: string[], N: string[], strict: boolean): Edit {
  return (tree: Tree): void => {
    if (!safe(path)) throw new Fail('unsafe', path);
    const before = tree.get(path);
    if (O.length === 0) {
      if (before !== null) throw new Fail('exists', path);
      tree.now.set(path, N.length === 0 ? '' : `${N.join('\n')}\n`);
      return;
    }
    if (before === null) throw new Fail('missing', path);
    const { br, lines, final } = splitFile(before);
    const found = findOccurrences(lines, O, strict);
    if (found.length === 0) throw new Fail('no-match', path);
    if (found.length > 1) throw new Fail('ambiguous', path);
    tree.now.set(path, joinFile(br, splice(lines, O, N, found[0]!, 0), final));
  };
}

// ---------------------------------------------------------------------------
// Section 8: V4A patches
// ---------------------------------------------------------------------------

interface VChunk {
  anchor: string | null;
  eof: boolean;
  O: string[];
  N: string[];
  /** Cursor position: the first line at or after this index that may match (used by the anchor rule). */
  anchorAt: number | null;
}

type VSection =
  | { kind: 'add'; path: string; lines: string[] }
  | { kind: 'delete'; path: string }
  | { kind: 'update'; path: string; move: string | null; chunks: VChunk[] };

const isVStart = (l: string): boolean =>
  l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');

function parseV4A(lines: string[]): Edit[] {
  const n = lines.length;
  let first = -1;
  for (let i = 0; i < n; i += 1) {
    if (!blank(lines[i]!)) {
      first = i;
      break;
    }
  }
  if (first < 0 || lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first < 0 ? 1 : first + 1}`);
  let last = -1;
  for (let i = n - 1; i >= 0; i -= 1) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${n + 1}`);

  const sections: VSection[] = [];
  let i = first + 1;
  while (i < last) {
    if (blank(lines[i]!)) {
      i += 1;
      continue;
    }
    if (lines[i]!.startsWith('*** Add File: ')) {
      const path = lines[i]!.slice('*** Add File: '.length).trim();
      const body: string[] = [];
      i += 1;
      while (i < last && !isVStart(lines[i]!)) {
        const l = lines[i]!;
        if (l.startsWith('+')) body.push(l.slice(1));
        else if (l === '') body.push('');
        else throw new Exit2(`error: parse ${i + 1}`);
        i += 1;
      }
      // Empty lines at the end of a body are not part of it.
      while (body.length > 0 && (body[body.length - 1] === '' || body[body.length - 1] === ' ')) body.pop();
      sections.push({ kind: 'add', path, lines: body });
      continue;
    }
    if (lines[i]!.startsWith('*** Delete File: ')) {
      const path = lines[i]!.slice('*** Delete File: '.length).trim();
      i += 1;
      while (i < last && !isVStart(lines[i]!)) {
        if (!blank(lines[i]!)) throw new Exit2(`error: parse ${i + 1}`);
        i += 1;
      }
      sections.push({ kind: 'delete', path });
      continue;
    }
    if (lines[i]!.startsWith('*** Update File: ')) {
      const lineNo = i + 1;
      const path = lines[i]!.slice('*** Update File: '.length).trim();
      i += 1;
      let move: string | null = null;
      if (i < last && lines[i]!.startsWith('*** Move to: ')) {
        move = lines[i]!.slice('*** Move to: '.length).trim();
        i += 1;
      }
      const chunks: VChunk[] = [];
      while (i < last && !isVStart(lines[i]!)) {
        const chunk: VChunk = { anchor: null, eof: false, O: [], N: [], anchorAt: null };
        if (lines[i]!.startsWith('@@')) {
          const a = lines[i]!.slice(2).trim();
          chunk.anchor = a === '' ? null : a;
          i += 1;
        }
        const body: string[] = [];
        while (i < last && !isVStart(lines[i]!) && !lines[i]!.startsWith('@@')) {
          const l = lines[i]!;
          if (l.trim() === '*** End of File') {
            chunk.eof = true;
            i += 1;
            break;
          }
          if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l === '') body.push(l);
          else throw new Exit2(`error: parse ${i + 1}`);
          i += 1;
        }
        while (body.length > 0 && (body[body.length - 1] === '' || body[body.length - 1] === ' ')) body.pop();
        [chunk.O, chunk.N] = chunkBody(body);
        chunks.push(chunk);
      }
      if (chunks.length === 0 && move === null) throw new Exit2(`error: parse ${lineNo}`);
      sections.push({ kind: 'update', path, move, chunks });
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return sections.map((s) => v4aEdit(s));
}

function chunkBody(body: string[]): [string[], string[]] {
  const O: string[] = [];
  const N: string[] = [];
  for (const l of body) {
    if (l.startsWith('+')) N.push(l.slice(1));
    else if (l.startsWith('-')) O.push(l.slice(1));
    else if (l === '') {
      O.push('');
      N.push('');
    } else {
      O.push(l.slice(1));
      N.push(l.slice(1));
    }
  }
  return [O, N];
}

function v4aEdit(s: VSection): Edit {
  if (s.kind === 'add') {
    const path = s.path;
    const lines = s.lines;
    return (tree: Tree): void => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, lines.length === 0 ? '' : `${lines.join('\n')}\n`);
    };
  }
  if (s.kind === 'delete') {
    const path = s.path;
    return (tree: Tree): void => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) === null) throw new Fail('missing', path);
      tree.now.set(path, null);
    };
  }
  const path = s.path;
  const move = s.move;
  const chunks = s.chunks;
  return (tree: Tree): void => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (move !== null && !safe(move)) throw new Fail('unsafe', move);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (move !== null && tree.get(move) !== null) throw new Fail('exists', move);
    const { br, lines, final } = splitFile(before);
    let cur = lines;
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        let at = -1;
        for (let tier = 0; tier <= 2 && at < 0; tier += 1) {
          for (let k = cursor; k < cur.length; k += 1) {
            if (norm(cur[k]!, tier) === norm(ch.anchor, tier)) {
              at = k;
              break;
            }
          }
        }
        if (at < 0) throw new Fail('no-match', path);
        cursor = at + 1;
      }
      if (ch.O.length === 0) {
        const at = ch.eof ? cur.length : Math.min(Math.max(cursor, 0), cur.length);
        cur = splice(cur, [], ch.N, { tier: 0, at: 0, own: [] }, at);
        cursor = at + ch.N.length;
        continue;
      }
      const from = ch.eof ? Math.max(cur.length - ch.O.length, cursor) : cursor;
      let hit: Occurrence | null = null;
      for (let tier = 0; tier <= 2; tier += 1) {
        const want = ch.O.map((o) => norm(o, tier));
        for (let k = from; k <= cur.length; k += 1) {
          let ok = true;
          for (let j = 0; j < ch.O.length; j += 1) {
            if (j === ch.O.length - 1 && ch.O[j] === '' && k + j === cur.length) {
              // Trailing empty context lines are optional at end of file.
              break;
            }
            if (norm(cur[k + j] ?? '', tier) !== want[j]) {
              ok = false;
              break;
            }
          }
          if (ok) {
            hit = { tier, at: k, own: cur.slice(k, k + ch.O.length) };
            break;
          }
        }
        if (hit !== null) break;
      }
      if (hit === null) throw new Fail('no-match', path);
      if (ch.eof && hit.at + hit.own.length !== cur.length) throw new Fail('no-match', path);
      const written = writeN(ch.N, hit.own, hit.tier);
      cur = splice(cur, ch.O, ch.N, hit, 0);
      cursor = hit.at + written.length;
    }
    const text = joinFile(br, cur, final);
    tree.now.set(path, null);
    tree.now.set(move ?? path, text);
    if (move !== null) tree.moved.set(move, path);
  };
}

// ---------------------------------------------------------------------------
// Section 9: JSON edits
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Section 10: order, output and the all-or-nothing write
// ---------------------------------------------------------------------------

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
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? parseUnified(lines, strict)
          : kind === 'search-replace'
            ? parseSearchReplace(lines, strict)
            : parseV4A(lines);
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

  // Exit 0: one line per changed path in UTF-8 byte order; a move pair replaces its D and A lines.
  const rows: string[] = [];
  const done = new Set<string>();
  const changed = (p: string): boolean => tree.now.get(p) !== undefined && tree.original(p) !== tree.now.get(p);
  const isMove = (p: string, old: string): boolean =>
    tree.original(old) !== null && tree.now.get(old) === null && tree.original(p) === null && tree.now.get(p) !== null;
  for (const [p, old] of [...tree.moved.entries()].sort((a, b) => Buffer.compare(Buffer.from(a[0]), Buffer.from(b[0])))) {
    if (isMove(p, old)) {
      rows.push(`R ${old} -> ${p}`);
      done.add(old);
      done.add(p);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (done.has(p) || !changed(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    rows.push(`${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`);
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.slice(a.indexOf(' ') + 1)), Buffer.from(b.slice(b.indexOf(' ') + 1))));
  const head = [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`];
  if (check) return { code: 0, out: head };
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (!changed(p)) continue;
    const now = tree.now.get(p)!;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  return { code: 0, out: head };
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
