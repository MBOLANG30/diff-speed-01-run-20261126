// A fast drop-in for makefun-diff 1.0.0.
//
// run(input) returns exactly the patch makefun-diff 1.0.0 returns for
// { old, new }: the same line splitting, the same greedy Myers edit script
// (common prefix, then common suffix, then the forward search that keeps the
// furthest-reaching path per diagonal and prefers a deletion on a tie), and
// the same patch text (header, hunks with 3 lines of context, deletions
// before insertions, "%" after a line with no final newline).
//
// Speed comes from doing the same search without jsdiff's per-step path
// objects: lines are interned to small integer ids once per case, the search
// runs over Int32Arrays, and the only record kept per (distance, diagonal)
// cell is the furthest old-line count reached there. The winning path is
// recovered afterwards by walking that record backwards, re-applying the
// same deletion-on-tie choice at every step, so the script it yields is the
// one the forward search itself found.

/** The patch's first word. */
const FORMAT = 'makefun-diff/1';

/** The kept lines a hunk shows before and after each change run. */
const CONTEXT = 3;

/** Run kinds, as small integers. */
const KEEP = 0;
const DELETE = 1;
const INSERT = 2;

/** The patch's line marks, by run kind. */
const MARK = ['=', '-', '+'];

/**
 * A text's lines as integer ids, shared between the two texts so equal lines
 * share an id. The text is cut after every "\n"; a line's id folds its
 * trailing newline into the low bit (content * 2 + 1 when the line ends in
 * "\n", content * 2 when it is the bare last line), because a line with a
 * newline and the same words without one are different lines. The split
 * parts are kept for the patch output, where a line is written back with
 * its newline (or with "%" after it when it had none).
 */
function tokenize(text, intern) {
  const parts = text.split('\n');
  const last = parts.length - 1;
  const n = last + (parts[last] !== '' ? 1 : 0);
  const ids = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const s = parts[i];
    let base = intern.get(s);
    if (base === undefined) {
      base = intern.size;
      intern.set(s, base);
    }
    ids[i] = base * 2 + (i < last ? 1 : 0);
  }
  return { parts, ids, n };
}

/**
 * The edit script of a[0..n) into b[0..m), as a flat array of
 * [kind, count, kind, count, ...] in order. Both arrays carry a sentinel at
 * their end (an id that occurs in neither text and differs between them),
 * so a run of equal lines ends by itself and the search needs no bounds
 * checks while it follows one. The forward search stores, for every edit
 * distance d and diagonal k, the furthest old-line count reached (row d is
 * its own Int32Array, -1 for unreachable); the backtrack then replays the
 * same deletion-on-tie choice to recover the exact path the forward search
 * found, including the exact length of every run of kept lines.
 */
function myersRuns(a, n, b, m) {
  if (n === 0) return m === 0 ? [] : [INSERT, m];
  if (m === 0) return [DELETE, n];

  const rows = [];
  // Distance 0: the run of equal lines from the start.
  let x = 0;
  let y = 0;
  while (a[x] === b[y]) {
    x++;
    y++;
  }
  const row0 = new Int32Array(1);
  row0[0] = x;
  rows.push(row0);
  let dFound = 0;
  let kFound = 0;
  if (x < n || y < m) {
    outer: for (let d = 1; d <= n + m; d++) {
      const pv = rows[d - 1];
      const row = new Int32Array(2 * d + 1);
      rows.push(row);
      // A sliding window over the previous row: for diagonal k the insertion
      // predecessor sits at pv[k + d] and the deletion predecessor is the
      // value that insertion predecessor held one step earlier, so each cell
      // reads the previous row once.
      let idx = 0;
      let xDel = -1;
      let xIns = pv[0];
      let w = 0;
      for (let k = -d; k <= d; k += 2) {
        // A deletion needs an old line left to delete; an insertion a new
        // line left to insert. The deletion's reach is xDel, the insertion's
        // xIns - 1 in old-line terms; the deletion wins a tie, as specified.
        const delOk = xDel >= 0 && xDel < n;
        const insOk = xIns >= 0 && xIns - k <= m;
        if (!delOk && !insOk) {
          row[w] = -1;
        } else {
          const delVal = delOk ? xDel : -2;
          const insVal = insOk ? xIns - 1 : -2;
          x = delVal >= insVal ? xDel + 1 : xIns;
          y = x - k;
          while (a[x] === b[y]) {
            x++;
            y++;
          }
          row[w] = x;
          if (x >= n && y >= m) {
            dFound = d;
            kFound = k;
            break outer;
          }
        }
        // Advance to k + 2: the deletion predecessor becomes the old
        // insertion predecessor, and the next insertion predecessor follows.
        xDel = xIns;
        idx += 2;
        xIns = idx < pv.length ? pv[idx] : -1;
        w += 2;
      }
    }
  }

  // Walk the winning path backwards from (n, m).
  const rev = [];
  x = n;
  y = m;
  let d = dFound;
  let k = kFound;
  for (;;) {
    if (d === 0) {
      if (x > 0) rev.push(KEEP, x);
      break;
    }
    const pv = rows[d - 1];
    const xDel = k > -d ? pv[k + d - 2] : -1;
    const xIns = k < d ? pv[k + d] : -1;
    const delOk = xDel >= 0 && xDel < n;
    const insOk = xIns >= 0 && xIns - k <= m;
    const delVal = delOk ? xDel : -2;
    const insVal = insOk ? xIns - 1 : -2;
    if (delVal >= insVal) {
      // A deletion: the kept run after it ends at xDel + 1 on this diagonal.
      const x0 = xDel + 1;
      if (x > x0) rev.push(KEEP, x - x0);
      rev.push(DELETE, 1);
      x = xDel;
      y = xDel - (k - 1);
      k = k - 1;
    } else {
      // An insertion: the kept run after it ends at xIns on this diagonal.
      const x0 = xIns;
      if (x > x0) rev.push(KEEP, x - x0);
      rev.push(INSERT, 1);
      x = xIns;
      y = xIns - (k + 1);
      k = k + 1;
    }
    d--;
  }

  // Reverse, merging runs of the same kind that meet.
  const runs = [];
  for (let i = rev.length - 2; i >= 0; i -= 2) {
    const kind = rev[i];
    const count = rev[i + 1];
    if (runs.length >= 2 && runs[runs.length - 2] === kind) runs[runs.length - 1] += count;
    else runs.push(kind, count);
  }
  return runs;
}

/** A line as the patch writes it: its mark, the line, a newline, and "%" on a line of its own when it had none. */
function written(kind, content, hasNewline) {
  return hasNewline ? MARK[kind] + content + '\n' : MARK[kind] + content + '\n%\n';
}

/** makefun-diff 1.0.0's answer for one case's input. */
export function run(input) {
  if (input === null || typeof input !== 'object' || typeof input.old !== 'string' || typeof input.new !== 'string') {
    throw new TypeError('makefun-diff: the input is { old, new }, two strings');
  }
  const intern = new Map();
  const aTok = tokenize(input.old, intern);
  const bTok = tokenize(input.new, intern);
  const aParts = aTok.parts;
  const bParts = bTok.parts;
  const aIds = aTok.ids;
  const bIds = bTok.ids;
  const n = aTok.n;
  const m = bTok.n;

  // The common prefix, then the common suffix of what is left.
  let prefix = 0;
  while (prefix < n && prefix < m && aIds[prefix] === bIds[prefix]) prefix++;
  let suffix = 0;
  while (suffix < n - prefix && suffix < m - prefix && aIds[n - 1 - suffix] === bIds[m - 1 - suffix]) suffix++;

  const runs = [];
  if (prefix > 0) runs.push(KEEP, prefix);
  // The middle slices, copied with a sentinel id at each end: an id that
  // occurs in neither text, different on the two sides, so the search's runs
  // of equal lines stop by themselves.
  const midN = n - suffix - prefix;
  const midM = m - suffix - prefix;
  const aMid = new Int32Array(midN + 1);
  aMid.set(aIds.subarray(prefix, n - suffix));
  const bMid = new Int32Array(midM + 1);
  bMid.set(bIds.subarray(prefix, m - suffix));
  aMid[midN] = intern.size * 2;
  bMid[midM] = intern.size * 2 + 1;
  const mid = myersRuns(aMid, midN, bMid, midM);
  for (let i = 0; i < mid.length; i++) runs.push(mid[i]);
  if (suffix > 0) runs.push(KEEP, suffix);

  // The change runs: each a stretch of deletions and insertions between two kept lines, at old line o and new line p.
  const changes = [];
  let o = 0;
  let p = 0;
  let deleted = 0;
  let inserted = 0;
  for (let i = 0; i < runs.length; i += 2) {
    const kind = runs[i];
    const count = runs[i + 1];
    if (kind === KEEP) {
      o += count;
      p += count;
      continue;
    }
    let c = changes.length > 0 ? changes[changes.length - 1] : undefined;
    if (c === undefined || c.o + c.dels !== o || c.p + c.ins !== p) {
      c = { o, p, dels: 0, ins: 0 };
      changes.push(c);
    }
    if (kind === DELETE) {
      c.dels += count;
      o += count;
      deleted += count;
    } else {
      c.ins += count;
      p += count;
      inserted += count;
    }
  }

  // The hunks: change runs at most 2 * CONTEXT kept lines apart share one.
  const hunks = [];
  for (const c of changes) {
    const h = hunks.length > 0 ? hunks[hunks.length - 1] : undefined;
    const prev = h !== undefined ? h[h.length - 1] : undefined;
    if (prev !== undefined && c.o - (prev.o + prev.dels) <= 2 * CONTEXT) h.push(c);
    else hunks.push([c]);
  }

  const out = [`${FORMAT} old=${n} new=${m} hunks=${hunks.length} deleted=${deleted} inserted=${inserted}\n`];
  for (const h of hunks) {
    const first = h[0];
    const last = h[h.length - 1];
    const oldStart = Math.max(0, first.o - CONTEXT);
    const newStart = first.p - (first.o - oldStart);
    const after = Math.min(CONTEXT, n - (last.o + last.dels));
    const oldEnd = last.o + last.dels + after;
    const newEnd = last.p + last.ins + after;
    out.push(`@ ${oldStart + 1} ${oldEnd - oldStart} ${newStart + 1} ${newEnd - newStart}\n`);
    let at = oldStart;
    for (const c of h) {
      for (; at < c.o; at++) out.push(written(KEEP, aParts[at], at < aParts.length - 1));
      for (let i = 0; i < c.dels; i++) out.push(written(DELETE, aParts[c.o + i], c.o + i < aParts.length - 1));
      for (let i = 0; i < c.ins; i++) out.push(written(INSERT, bParts[c.p + i], c.p + i < bParts.length - 1));
      at = c.o + c.dels;
    }
    for (; at < oldEnd; at++) out.push(written(KEEP, aParts[at], at < aParts.length - 1));
  }
  return out.join('');
}
