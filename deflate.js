// deflate.js: a bounded optimal-parse DEFLATE compressor in pure JS (Node 22,
// no dependencies). Hash-chain match finding with a Pareto frontier of
// length/distance pairs per position, DP optimal parse over that frontier, and
// iterative dynamic Huffman with zlib-style length-limited code lengths.
// Written for this entry (not copied from any compressor): the algorithms are
// the standard ones (hash chains, shortest-path parse, Huffman with the
// overflow adjustment as in zlib's gen_bitlen), implemented from scratch.
// Every search is bounded by fixed work, never by time: no clock reads, no
// environment input, so two runs produce identical bytes.
// zopfli-lite prototype: optimal-parse DEFLATE in pure JS (measurement only).
// Fixed work, no clock: hash-chain match finding (bounded chain), DP optimal
// parse over a few candidate matches per position, iterative dynamic Huffman
// (zlib-style length-limited code lengths), fixed-size blocks.
import { inflateSync } from 'node:zlib';

// --- DEFLATE tables -------------------------------------------------------
const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];

function lenCodeOf(len) {
  let lo = 0, hi = 28;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (LEN_BASE[mid] <= len) lo = mid; else hi = mid - 1; }
  return lo;
}
function distCodeOf(d) {
  let lo = 0, hi = 29;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (DIST_BASE[mid] <= d) lo = mid; else hi = mid - 1; }
  return lo;
}

// --- Huffman lengths (zlib-style: heap tree + overflow adjustment) --------
function buildLengths(freq, maxBits) {
  const n = freq.length;
  const lengths = new Uint8Array(n);
  const syms = [];
  for (let i = 0; i < n; i++) if (freq[i] > 0) syms.push(i);
  if (syms.length === 0) return lengths;
  if (syms.length === 1) { lengths[syms[0]] = 1; return lengths; }
  // Min-heap of node indices; nodes 0..n-1 are leaves, n.. are internal.
  // `removed` records nodes in pop order (children before parents).
  const nodeFreq = new Float64Array(2 * n);
  const nodeLeft = new Int32Array(2 * n);
  const nodeRight = new Int32Array(2 * n);
  const parent = new Int32Array(2 * n).fill(-1);
  for (let i = 0; i < n; i++) nodeFreq[i] = freq[i];
  const heap = [];
  const less = (a, b) => nodeFreq[a] < nodeFreq[b] || (nodeFreq[a] === nodeFreq[b] && a < b);
  const push = (v) => { heap.push(v); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (!less(heap[i], heap[p])) break; [heap[i], heap[p]] = [heap[p], heap[i]]; i = p; } };
  const pop = () => {
    const top = heap[0]; const last = heap.pop();
    if (heap.length > 0) {
      heap[0] = last; let i = 0;
      for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && less(heap[l], heap[m])) m = l; if (r < heap.length && less(heap[r], heap[m])) m = r; if (m === i) break; [heap[i], heap[m]] = [heap[m], heap[i]]; i = m; }
    }
    return top;
  };
  for (const s of syms) push(s);
  const removed = [];
  let next = n;
  while (heap.length > 1) {
    const a = pop(), b = pop();
    removed.push(a, b);
    nodeFreq[next] = nodeFreq[a] + nodeFreq[b];
    nodeLeft[next] = a; nodeRight[next] = b;
    parent[a] = next; parent[b] = next;
    push(next); next++;
  }
  const root = heap[0];
  // zlib's gen_bitlen first pass: traverse parents before children (reverse
  // removal order), lengths from the parent's (possibly clamped) length + 1;
  // overflow counts every node, leaf or internal, that exceeds maxBits.
  const nodeLen = new Int32Array(2 * n);
  nodeLen[root] = 0;
  const blCount = new Int32Array(maxBits + 1);
  let overflow = 0;
  for (let i = removed.length - 1; i >= 0; i--) {
    const v = removed[i];
    let bits = nodeLen[parent[v]] + 1;
    if (bits > maxBits) { bits = maxBits; overflow++; }
    nodeLen[v] = bits;
    if (v < n) blCount[bits]++;
  }
  if (overflow > 0) {
    do {
      let bits = maxBits - 1;
      while (blCount[bits] === 0) bits--;
      blCount[bits]--;        /* move one leaf down the tree */
      blCount[bits + 1] += 2; /* move one overflow item as its brother */
      blCount[maxBits]--;
      overflow -= 2;
    } while (overflow > 0);
    // Reassign: walk removal order (least frequent first), longest first.
    let oi = 0;
    for (let b = maxBits; b >= 1; b--) {
      let cnt = blCount[b];
      while (cnt > 0) {
        const v = removed[oi++];
        if (v >= n) continue; /* not a leaf */
        lengths[v] = b;
        cnt--;
      }
    }
  } else {
    for (const s of syms) lengths[s] = nodeLen[s];
  }
  return lengths;
}

function canonicalCodes(lengths) {
  const maxBits = Math.max(0, ...lengths);
  const blCount = new Int32Array(maxBits + 1);
  for (const l of lengths) if (l > 0) blCount[l]++;
  const nextCode = new Int32Array(maxBits + 1);
  let code = 0;
  for (let b = 1; b <= maxBits; b++) { code = (code + blCount[b - 1]) << 1; nextCode[b] = code; }
  const codes = new Int32Array(lengths.length);
  for (let s = 0; s < lengths.length; s++) {
    const l = lengths[s];
    if (l > 0) codes[s] = nextCode[l]++;
  }
  return codes;
}

// --- bit writer ------------------------------------------------------------
class BitWriter {
  constructor(capacity) {
    this.buf = new Uint8Array(Math.max(1024, capacity));
    this.pos = 0; this.bitbuf = 0; this.bitcnt = 0;
  }
  grow(need) {
    if (this.pos + need > this.buf.length) {
      const nb = new Uint8Array(Math.max(this.buf.length * 2, this.pos + need));
      nb.set(this.buf.subarray(0, this.pos)); this.buf = nb;
    }
  }
  writeBits(value, len) { // LSB-first
    this.bitbuf |= (value & ((1 << len) - 1)) << this.bitcnt;
    this.bitcnt += len;
    while (this.bitcnt >= 8) { this.grow(1); this.buf[this.pos++] = this.bitbuf & 0xff; this.bitbuf >>>= 8; this.bitcnt -= 8; }
  }
  writeCode(code, len) { // Huffman code, MSB-first
    for (let i = len - 1; i >= 0; i--) this.writeBits((code >> i) & 1, 1);
  }
  finish() {
    if (this.bitcnt > 0) { this.grow(1); this.buf[this.pos++] = this.bitbuf & 0xff; this.bitbuf = 0; this.bitcnt = 0; }
    return this.buf.subarray(0, this.pos);
  }
}

// --- match finding ----------------------------------------------------------
const WINDOW = 32768;
const MAX_MATCH = 258;
const MIN_MATCH = 3;

function matchLenAt(data, a, b, maxLen) {
  let l = 0;
  const lim = Math.min(maxLen, data.length - b);
  // Compare 4 bytes at a time when aligned enough (simple loop is fine for prototype).
  while (l < lim && data[a + l] === data[b + l]) l++;
  return l;
}

/**
 * For every position, the Pareto frontier of matches: record-breaking
 * (length, distance) pairs in chain order (increasing distance), up to K
 * pairs: the first is the closest match, the last the longest, and the
 * intermediates are the lengths where a strictly smaller distance becomes
 * available. Stored flat: pairLen[i*K+k], pairDist[i*K+k], length 0 ends.
 * The chain is walked in increasing-distance order and the quick reject only
 * skips candidates dominated by an earlier (closer, longer) one, so the
 * frontier is exact for the candidates visited.
 */
function findMatches(data, chainLimit, goodLen, K = 8) {
  const n = data.length;
  const HASH_BITS = 15;
  const HASH_SIZE = 1 << HASH_BITS;
  const head = new Int32Array(HASH_SIZE).fill(-1);
  const prev = new Int32Array(n).fill(-1);
  const pairLen = new Uint16Array(n * K);
  const pairDist = new Uint16Array(n * K);
  for (let i = 0; i + MIN_MATCH <= n; i++) {
    const h = (((data[i] << 8) ^ (data[i + 1] << 4) ^ data[i + 2]) * 2654435761) >>> (32 - HASH_BITS);
    let cand = head[h];
    let count = 0;
    let bestLen = 0;
    let k = 0;
    const base = i * K;
    while (cand >= 0 && count < chainLimit) {
      const dist = i - cand;
      if (dist > WINDOW) break;
      let len = 0;
      if (bestLen === 0 || data[cand + bestLen] === data[i + bestLen]) {
        len = matchLenAt(data, cand, i, MAX_MATCH);
      }
      if (len >= MIN_MATCH && len > bestLen) {
        bestLen = len;
        // Keep the first K-1 record-breakers and reserve the last slot for
        // the longest match so far, so a long frontier never drops it.
        if (k < K - 1) { pairLen[base + k] = len; pairDist[base + k] = dist; k++; }
        else { pairLen[base + K - 1] = len; pairDist[base + K - 1] = dist; }
        if (len >= goodLen) break;
      }
      cand = prev[cand];
      count++;
    }
    prev[i] = head[h];
    head[h] = i;
  }
  return { pairLen, pairDist, K };
}

// --- optimal parse ----------------------------------------------------------
const FIXED_LITLEN = (() => {
  const l = new Float64Array(288);
  for (let i = 0; i < 144; i++) l[i] = 8;
  for (let i = 144; i < 256; i++) l[i] = 9;
  for (let i = 256; i < 280; i++) l[i] = 7;
  for (let i = 280; i < 288; i++) l[i] = 8;
  return l;
})();

function parseBlock(data, start, end, matches, litCost, lenCostBits, distCostBits) {
  const len = end - start;
  const costs = new Float64Array(len + 1).fill(Infinity);
  const backLen = new Uint16Array(len + 1);
  const backDist = new Uint16Array(len + 1);
  costs[0] = 0;
  const { pairLen, pairDist, K } = matches;
  for (let i = 0; i < len; i++) {
    const base = costs[i];
    if (base === Infinity) continue;
    // Literal.
    const lc = base + litCost[data[start + i]];
    if (lc < costs[i + 1]) { costs[i + 1] = lc; backLen[i + 1] = 0; }
    // Matches: every frontier pair at this position.
    const p = (start + i) * K;
    const remain = len - i;
    for (let k = 0; k < K; k++) {
      const L = pairLen[p + k];
      if (L === 0) break;
      const maxL = L < remain ? L : remain;
      if (maxL < MIN_MATCH) continue;
      const D = pairDist[p + k];
      const mc = base + lenCostBits[maxL] + distCostBits[D];
      if (mc < costs[i + maxL]) { costs[i + maxL] = mc; backLen[i + maxL] = maxL; backDist[i + maxL] = D; }
    }
  }
  // Backtrack into a sequence: 0..255 literal, >=257 length with dist.
  const seq = [];
  const freqLit = new Float64Array(288);
  const freqDist = new Float64Array(30);
  let j = len;
  while (j > 0) {
    const L = backLen[j];
    if (L === 0) { const s = data[start + j - 1]; seq.push(s); freqLit[s]++; j--; }
    else {
      const D = backDist[j];
      seq.push({ len: L, dist: D });
      freqLit[257 + lenCodeOf(L)]++;
      freqDist[distCodeOf(D)]++;
      j -= L;
    }
  }
  seq.reverse();
  return { seq, freqLit, freqDist, cost: costs[len] };
}

// --- block emission ---------------------------------------------------------
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

/** RLE-encode the lit/dist code lengths and build the code-length code.
 * Returns { hlit, hdist, hclen, clLen, clCode, rle } shared by emission and
 * by the header-bit measurement (the table cost of a candidate parse). */
function encodeLengths(litLen, distLen) {
  let hlit = 288; while (hlit > 257 && litLen[hlit - 1] === 0) hlit--;
  let hdist = 30; while (hdist > 1 && distLen[hdist - 1] === 0) hdist--;
  const lens = new Uint8Array(hlit + hdist);
  lens.set(litLen.subarray(0, hlit), 0);
  lens.set(distLen.subarray(0, hdist), hlit);
  const rle = [];
  let i = 0;
  while (i < lens.length) {
    const v = lens[i];
    let run = 1;
    while (i + run < lens.length && lens[i + run] === v) run++;
    if (v === 0) {
      let r = run;
      while (r >= 11) { const take = Math.min(r, 138); rle.push({ sym: 18, extra: take - 11, extraBits: 7 }); r -= take; }
      if (r >= 3) { rle.push({ sym: 17, extra: r - 3, extraBits: 3 }); r = 0; }
      while (r > 0) { rle.push({ sym: 0, extra: 0, extraBits: 0 }); r--; }
    } else {
      rle.push({ sym: v, extra: 0, extraBits: 0 });
      let r = run - 1;
      while (r >= 3) { const take = Math.min(r, 6); rle.push({ sym: 16, extra: take - 3, extraBits: 2 }); r -= take; }
      while (r > 0) { rle.push({ sym: v, extra: 0, extraBits: 0 }); r--; }
    }
    i += run;
  }
  const freqCl = new Float64Array(19);
  for (const e of rle) freqCl[e.sym]++;
  const clLen = buildLengths(freqCl, 7);
  const clCode = canonicalCodes(clLen);
  let hclen = 19; while (hclen > 4 && clLen[CL_ORDER[hclen - 1]] === 0) hclen--;
  return { hlit, hdist, hclen, clLen, clCode, rle };
}

/** Bits the dynamic block header costs (block type, counts, code-length code
 * and the RLE of the lit/dist lengths), not counting the LZ77 symbols. */
function headerBits(litLen, distLen) {
  const { hclen, clLen, rle } = encodeLengths(litLen, distLen);
  let bits = 3 + 5 + 5 + 4 + 3 * hclen;
  for (const e of rle) bits += clLen[e.sym] + e.extraBits;
  return bits;
}

function emitBlock(bw, seq, last) {
  const freqLit = new Float64Array(288);
  const freqDist = new Float64Array(30);
  for (const s of seq) {
    if (typeof s === 'number') freqLit[s]++;
    else { freqLit[257 + lenCodeOf(s.len)]++; freqDist[distCodeOf(s.dist)]++; }
  }
  freqLit[256] = 1;
  const litLen = buildLengths(freqLit, 15);
  let distLen = buildLengths(freqDist, 15);
  if (freqDist.every((f) => f === 0)) { distLen = new Uint8Array(30); distLen[0] = 1; }
  const { hlit, hdist, hclen, clLen, clCode, rle } = encodeLengths(litLen, distLen);
  bw.writeBits(last ? 1 : 0, 1);
  bw.writeBits(2, 2); // dynamic
  bw.writeBits(hlit - 257, 5);
  bw.writeBits(hdist - 1, 5);
  bw.writeBits(hclen - 4, 4);
  for (let k = 0; k < hclen; k++) bw.writeBits(clLen[CL_ORDER[k]], 3);
  for (const e of rle) { bw.writeCode(clCode[e.sym], clLen[e.sym]); if (e.extraBits > 0) bw.writeBits(e.extra, e.extraBits); }
  const litCode = canonicalCodes(litLen);
  const distCode = canonicalCodes(distLen);
  for (const s of seq) {
    if (typeof s === 'number') bw.writeCode(litCode[s], litLen[s]);
    else {
      const lc = lenCodeOf(s.len);
      bw.writeCode(litCode[257 + lc], litLen[257 + lc]);
      if (LEN_EXTRA[lc] > 0) bw.writeBits(s.len - LEN_BASE[lc], LEN_EXTRA[lc]);
      const dc = distCodeOf(s.dist);
      bw.writeCode(distCode[dc], distLen[dc]);
      if (DIST_EXTRA[dc] > 0) bw.writeBits(s.dist - DIST_BASE[dc], DIST_EXTRA[dc]);
    }
  }
  bw.writeCode(litCode[256], litLen[256]);
}

function adler32(bytes) {
  let a = 1, b = 0;
  for (let i = 0; i < bytes.length;) {
    const end = Math.min(bytes.length, i + 5552);
    for (; i < end; i++) { a += bytes[i]; b += a; }
    a %= 65521; b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/** Optimal-parse DEFLATE of `data` as one zlib stream.
 *
 * Hash-chain match finding (bounded chain, Pareto frontier of length/distance
 * pairs per position), DP optimal parse over the frontier, iterative dynamic
 * Huffman (zlib-style length-limited code lengths). Every search is bounded
 * by fixed work, never by time: no clock, no environment input, so two runs
 * produce identical bytes. Iterations are selected by true symbol cost
 * (frequencies times code lengths), not by the DP model cost.
 */
export function deflateOptimal(data, { blockSize = 131072, chainLimit = null, goodLen = 128, iterations = 4 } = {}) {
  const n = data.length;
  const limit = chainLimit !== null ? chainLimit : (n <= 1000000 ? 1024 : 128);
  const matches = findMatches(data, limit, goodLen);
  const bw = new BitWriter(n);
  const blendLit = (lengths) => {
    const c = new Float64Array(288);
    for (let i = 0; i < 288; i++) c[i] = lengths[i] > 0 ? lengths[i] : FIXED_LITLEN[i];
    return c;
  };
  const blendDist = (lengths) => {
    const c = new Float64Array(30);
    for (let i = 0; i < 30; i++) c[i] = lengths[i] > 0 ? lengths[i] : 5;
    return c;
  };
  for (let b = 0; b * blockSize < n || b === 0; b++) {
    const start = b * blockSize;
    const end = Math.min(n, start + blockSize);
    const last = end === n;
    let bestSeq = null;
    let bestTrue = Infinity;
    let litCost = FIXED_LITLEN;
    let distCost = new Float64Array(30).fill(5);
    for (let it = 0; it < iterations; it++) {
      const lenCostBits = new Float64Array(259);
      for (let L = MIN_MATCH; L <= MAX_MATCH; L++) {
        const lc = lenCodeOf(L);
        lenCostBits[L] = litCost[257 + lc] + LEN_EXTRA[lc];
      }
      const distCostBits = new Float64Array(32769);
      for (let d = 1; d <= WINDOW; d++) {
        const dc = distCodeOf(d);
        distCostBits[d] = distCost[dc] + DIST_EXTRA[dc];
      }
      const { seq, freqLit, freqDist } = parseBlock(data, start, end, matches, litCost, lenCostBits, distCostBits);
      freqLit[256] = 1;
      const litLen = buildLengths(freqLit, 15);
      let distLen = buildLengths(freqDist, 15);
      if (freqDist.every((f) => f === 0)) { distLen = new Uint8Array(30); distLen[0] = 1; }
      // True cost of this parse under its own code lengths, including the
      // bits its Huffman tables cost to transmit and the length/distance
      // extra bits each match carries.
      let trueBits = headerBits(litLen, distLen);
      for (let s = 0; s < 288; s++) trueBits += freqLit[s] * litLen[s];
      for (let s = 0; s < 30; s++) trueBits += freqDist[s] * distLen[s];
      for (const s of seq) {
        if (typeof s !== 'number') {
          trueBits += LEN_EXTRA[lenCodeOf(s.len)] + DIST_EXTRA[distCodeOf(s.dist)];
        }
      }
      if (trueBits < bestTrue) {
        bestTrue = trueBits;
        bestSeq = seq;
      }
      litCost = blendLit(litLen);
      distCost = blendDist(distLen);
    }
    emitBlock(bw, bestSeq, last);
  }
  const body = bw.finish();
  const out = new Uint8Array(2 + body.length + 4);
  out[0] = 0x78; out[1] = 0x9c;
  out.set(body, 2);
  new DataView(out.buffer).setUint32(2 + body.length, adler32(data));
  return out;
}
