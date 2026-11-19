// Auto-lyrics: transcribe the soundtrack's vocals on-device (Whisper via
// transformers.js, WebGPU when available) and turn the words into captions.
// The speech model downloads from Hugging Face once and is cached by the browser.

const TF_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.0';
// The merged q4 decoder exposes cross-attention for word-level timestamps.
const MODEL = 'Xenova/whisper-small';
const MT_JA = 'Xenova/opus-mt-ja-en'; // Japanese → English text translation (Whisper's own is rough)
let asrPromise = null, mtPromise = null;
// one Whisper run at a time: the footage's dialogue scan and a lyrics build can be asked for at once
let asrQueue = Promise.resolve();
const queued = (fn) => { const run = asrQueue.then(fn, fn); asrQueue = run.catch(() => {}); return run; };

function loadModel(onStatus) {
  if (!asrPromise) {
    asrPromise = (async () => {
      onStatus && onStatus('Downloading the speech model on first use…');
      const tf = await import(TF_URL);
      const files = {};
      return tf.pipeline('automatic-speech-recognition', MODEL, {
        revision: '2d67713f236afa48a18992566e7647f6ca848e13',
        dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' },
        device: navigator.gpu ? 'webgpu' : 'wasm',
        progress_callback: (p) => {
          if (p.status === 'progress' && p.file) {
            files[p.file] = p.progress || 0;
            const vals = Object.values(files);
            onStatus && onStatus(`Downloading the speech model… ${Math.round(vals.reduce((a, b) => a + b, 0) / vals.length)}%`);
          }
        },
      });
    })().catch((e) => { asrPromise = null; throw e; });
  }
  return asrPromise;
}

// Mid channel, band-limited to the vocal range, resampled to 16 kHz for Whisper.
async function vocalPcm(buffer, offset, duration) {
  const sr = 16000;
  const ctx = new OfflineAudioContext(1, Math.max(1, Math.ceil(duration * sr)), sr);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass'; hp.frequency.value = 140;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass'; lp.frequency.value = 7000;
  src.connect(hp).connect(lp).connect(ctx.destination);
  src.start(0, Math.max(0, offset), duration);
  return (await ctx.startRendering()).getChannelData(0);
}

// Returns [{ text, start, end }] in seconds relative to `offset`.
export async function transcribeSong(buffer, offset, duration, onStatus) {
  const asr = await loadModel(onStatus);
  onStatus && onStatus('Listening for the lyrics…');
  const pcm = await vocalPcm(buffer, offset, duration);
  const out = await queued(() => asr(pcm, { return_timestamps: 'word', chunk_length_s: 30, stride_length_s: 5 }));
  const words = [];
  for (const c of out.chunks || []) {
    const text = (c.text || '').trim();
    const [a, b] = c.timestamp || [];
    if (!text || a == null || /[[\]♪()]/.test(text)) continue;
    const end = b != null ? b : a + 0.3;
    if (end - a > 2.5) continue; // stretched tokens are usually hallucinations over music
    words.push({ text, start: a, end });
  }
  return words;
}

function loadTranslator(onStatus) {
  if (!mtPromise) {
    mtPromise = (async () => {
      onStatus && onStatus('Loading the translation model (first time ~80 MB)…');
      const tf = await import(TF_URL);
      return tf.pipeline('translation', MT_JA, { device: 'wasm', revision: '1a906cfaaf7c8f4193f67f5885c082aa6dbd9d16' });
    })().catch((e) => { mtPromise = null; throw e; });
  }
  return mtPromise;
}

const JA = /[\u3040-\u30ff\u31f0-\u31ff\uff66-\uff9f]/; // kana: Japanese, not Chinese

// How much of a line is held notes (0..1): the share of its voiced moments that sit on one pitch
// (within half a semitone) for 150 ms or more. Singing lives on held notes; speech glides all the
// time (measured on anime: spoken lines 0–0.16, an ending theme sung over the scene 0.18–0.49).
// A simple autocorrelation pitch track at 8 kHz, 40 ms frames every 10 ms.
export function heldNotes(pcm, a, b) {
  const sr = 8000, i0 = Math.max(0, Math.floor(a * 16000)), i1 = Math.min(pcm.length, Math.ceil(b * 16000));
  const n = Math.floor((i1 - i0) / 2);
  if (n < sr * 0.4) return 0;
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = (pcm[i0 + 2 * i] + pcm[i0 + 2 * i + 1]) / 2;
  const W = 320, H = 80, lo = 20, hi = 100; // lags for 400 Hz down to 80 Hz
  const f0 = [];
  for (let s = 0; s + W + hi < n; s += H) {
    let e0 = 0;
    for (let i = 0; i < W; i++) e0 += x[s + i] * x[s + i];
    if (e0 < 1e-5 * W) { f0.push(0); continue; }
    let best = 0, lag = 0;
    for (let L = lo; L <= hi; L++) {
      let c = 0, e1 = 0;
      for (let i = 0; i < W; i++) { c += x[s + i] * x[s + i + L]; e1 += x[s + i + L] * x[s + i + L]; }
      const r = c / Math.sqrt(e0 * e1 + 1e-12);
      if (r > best) { best = r; lag = L; }
    }
    f0.push(best > 0.6 ? sr / lag : 0);
  }
  let voiced = 0, held = 0, run = 0, ref = 0;
  const end = () => { if (run >= 15) held += run; };
  for (const v of f0) {
    if (v) voiced++;
    if (v && ref && Math.abs(12 * Math.log2(v / ref)) < 0.5) run++;
    else { end(); run = v ? 1 : 0; ref = v; }
  }
  end();
  return voiced >= 8 ? held / voiced : 0;
}

// What the characters say in a video's own sound, in English: [{ text, original, start, end, loud }]
// in seconds of the video, `loud` being how far the line stands above the clip's typical level
// (clear speech over music scores high). Whisper writes down each line in the language it's spoken
// in (it hears Japanese well); Japanese lines are then translated by a text translation model,
// which reads far more naturally than Whisper's own translation. Used to open an edit on a spoken
// line, like the Bleach edit's cold open.
export async function transcribeDialogue(buffer, onStatus) {
  const asr = await loadModel(onStatus);
  onStatus && onStatus('Listening for dialogue…');
  const dur = Math.min(buffer.duration, 600);
  const pcm = await vocalPcm(buffer, 0, dur);
  // anime is almost always in Japanese: written down as Japanese first (left to guess, Whisper
  // assumes English and half-translates, half-romanises); if hardly any of it comes back as kana
  // it's a dub, and it's heard again without a language set
  let out = await queued(() => asr(pcm, { task: 'transcribe', language: 'japanese', return_timestamps: true, chunk_length_s: 30, stride_length_s: 5 }));
  const cs = (out.chunks || []).filter((c) => (c.text || '').trim());
  if (cs.length && cs.filter((c) => JA.test(c.text)).length < cs.length * 0.3) {
    out = await queued(() => asr(pcm, { task: 'transcribe', return_timestamps: true, chunk_length_s: 30, stride_length_s: 5 }));
  }
  // loudness per 50 ms, to tell clear speech from mumbling under music
  const fr = 800, nF = Math.floor(pcm.length / fr), rms = new Float32Array(nF);
  for (let i = 0; i < nF; i++) { let e = 0; for (let j = i * fr; j < (i + 1) * fr; j++) e += pcm[j] * pcm[j]; rms[i] = Math.sqrt(e / fr); }
  const med = [...rms].sort((a, b) => a - b)[Math.floor(nF / 2)] || 1e-4;
  const segs = [];
  for (const c of out.chunks || []) {
    const text = (c.text || '').replace(/\s+/g, ' ').trim();
    const [a, b] = c.timestamp || [];
    if (!text || a == null) continue;
    const end = b != null ? Math.min(b, dur) : a + 2;
    // music, sound effects and the usual hallucinations over silence aren't lines
    if (/[[\]♪()*]|thank(s| you) for watching|subscribe|subtitle|^(you|music|applause|oh|ah)[.!]*$|ご視聴|チャンネル登録|字幕|お疲れ様でした$/i.test(text)) continue;
    if (end - a < 0.3 || end - a > 12) continue;
    // a looping hallucination: more text than anyone can say in the time, or the same words over and over
    const ws = text.toLowerCase().split(/\s+/);
    if (text.length / (end - a) > 22 || text.length > 140 || (ws.length >= 6 && new Set(ws).size / ws.length < 0.45)) continue;
    let e = 0, n = 0, pk = 0;
    const i0 = Math.floor(a * 20), i1 = Math.min(nF, Math.ceil(end * 20));
    for (let i = i0; i < i1; i++) { e += rms[i]; n++; pk = Math.max(pk, rms[i]); }
    // Whisper's segment edges are loose (room tone before, the next line's breath after): the line
    // runs from its first to its last clearly voiced moment
    const thr = Math.max(med * 1.5, pk * 0.25);
    let f0 = i0, f1 = i1 - 1;
    while (f0 < f1 && rms[f0] < thr) f0++;
    while (f1 > f0 && rms[f1] < thr) f1--;
    const seg = { text, original: text, start: f0 / 20, end: Math.min(end, (f1 + 1) / 20 + 0.08), loud: n ? e / n / med : 0 };
    // an opening or ending theme sung over the scene isn't dialogue
    seg.held = +heldNotes(pcm, seg.start, seg.end).toFixed(2);
    segs.push(seg);
  }
  // the same line over and over across music is a hallucination loop, not dialogue
  const key = (x) => x.original.replace(/[\s、。,.!?！？…]/g, '');
  const looped = new Set(segs.filter((x) => segs.filter((y) => key(y) === key(x) && Math.abs(y.start - x.start) < 20).length >= 3).map(key));
  for (let i = segs.length - 1; i >= 0; i--) if (looped.has(key(segs[i]))) segs.splice(i, 1);
  // Japanese lines into English; anything else that isn't English (no Latin letters) through
  // Whisper's own translation of that stretch
  const ja = segs.filter((x) => JA.test(x.original));
  if (ja.length) {
    onStatus && onStatus('Translating the dialogue…');
    const mt = await loadTranslator(onStatus);
    for (const x of ja) x.text = ((await mt(x.original))[0].translation_text || '').trim();
  }
  for (const x of segs) {
    if (JA.test(x.original) || /[a-z]/i.test(x.original)) continue;
    const r = await queued(() => asr(pcm.subarray(Math.floor(x.start * 16000), Math.ceil(x.end * 16000)), { task: 'translate' }));
    x.text = (r.text || '').trim();
  }
  return segs.filter((x) => x.text && /[a-z]/i.test(x.text));
}

// Dialogue written down before the build (tools/transcribe.py: Whisper large on the Mac's GPU, run
// on the voices alone), finished here like a heard one: sung lines measured, Japanese translated.
export async function finishDialogue(lines, buffer, onStatus) {
  const segs = [];
  for (const x of lines || []) {
    if (!x || !x.original || !(x.end > x.start)) continue;
    const seg = { text: x.original, original: x.original, start: x.start, end: x.end, loud: x.loud || 0, words: x.words || null };
    seg.held = +heldNotes(await vocalPcm(buffer, seg.start, seg.end - seg.start), 0, seg.end - seg.start).toFixed(2);
    segs.push(seg);
  }
  const ja = segs.filter((x) => JA.test(x.original));
  if (ja.length) {
    onStatus && onStatus('Translating the dialogue…');
    const mt = await loadTranslator(onStatus);
    for (const x of ja) x.text = ((await mt(x.original))[0].translation_text || '').trim();
  }
  return segs.filter((x) => x.text && /[a-z]/i.test(x.text));
}

// Group words into short phrases: break on punctuation, pauses, or `max` words.
export function phrases(words, max = 4) {
  const out = [];
  let cur = null;
  for (const w of words) {
    const gap = cur ? w.start - cur.end : 0;
    if (!cur || gap > 0.35 || cur.n >= max || /[.,!?;:]$/.test(cur.text)) {
      cur = { text: w.text, start: w.start, end: w.end, n: 1, ws: [w] };
      out.push(cur);
    } else {
      cur.text += ' ' + w.text;
      cur.end = w.end;
      cur.n++;
      cur.ws.push(w);
    }
  }
  return out;
}

// Caption lines from heard words, broken where a reader expects: at the start of a sentence (the
// speech model capitalises them), at punctuation and at pauses, into lines of about three to five
// words. Cutting every few words as they come breaks mid-sentence ("turning blue The feeling is");
// this weighs every boundary of the stretch at once and keeps the strongest.
const SELF = /^I($|'|’)/; // "I", "I'm", "I'll" are capitalised anywhere: no sign of a new sentence
export function sentenceLines(words) {
  const n = words.length;
  if (!n) return [];
  const gap = (i) => words[i].start - words[i - 1].end;
  // how much the words want a break before word i
  const cut = (i) => {
    const prev = words[i - 1].text, w = words[i].text;
    return Math.min(1, Math.max(0, gap(i)) / 0.4) + (/[.!?;:]$/.test(prev) ? 1.2 : /,$/.test(prev) ? 0.6 : 0)
      + (/^\p{Lu}/u.test(w) && !SELF.test(w) ? 0.9 : SELF.test(w) && gap(i) > 0.12 ? 0.3 : 0);
  };
  // words a..b-1 as one line: three to five words read best, and no line stays up too long
  const fit = (a, b) => {
    const L = b - a, dur = words[b - 1].end - words[a].start;
    return (L === 1 ? 1.2 : L === 2 ? 0.3 : L <= 5 ? 0 : L === 6 ? 0.5 : L === 7 ? 1.5 : 3 + L) + (dur > 4.5 ? 2 : 0);
  };
  const best = new Array(n + 1).fill(Infinity), from = new Array(n + 1).fill(0);
  best[0] = 0;
  for (let b = 1; b <= n; b++) {
    for (let a = b - 1; a >= Math.max(0, b - 9); a--) {
      if (a + 1 < b && gap(a + 1) > 0.8) break; // a long pause always ends a line
      const c = best[a] + fit(a, b) + (a > 0 ? 0.7 - cut(a) : 0);
      if (c < best[b]) { best[b] = c; from[b] = a; }
    }
  }
  const out = [];
  for (let b = n; b > 0; b = from[b]) {
    const ws = words.slice(from[b], b);
    out.unshift({ text: ws.map((w) => w.text).join(' '), start: ws[0].start, end: ws[ws.length - 1].end, n: ws.length, ws });
  }
  return out;
}

function editDistance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length];
}

// Snap pasted lyrics onto the transcribed timing. The real words replace what the speech
// model heard, matched by spelling with a semi-global alignment (the clip can be any part of
// the song, so lyrics before and after it are skipped for free). Misheard words still take
// the timing of the word they stand in for; words the model missed get times spread evenly
// between their neighbours. Returns null when the lyrics don't match what's sung.
// A stylised number in a lyric sheet as it's sung, for matching and for the letter aligner (which
// only knows letters): a digit spelling on into its word ("6ix": six), a digit standing for its
// sound ("2gether", "4ever", "l8r"). The caption keeps the sheet's spelling. ("6ix" against the
// heard "six" lost the first half of a line, and the line after it slid back over the gap.)
// Pasted lyrics sometimes carry a Cyrillic or Greek letter that looks just like a Latin one (an "е"
// from a lyrics site): the caption faces have no glyph for it, so it falls back to a serif in the
// middle of a word, and the aligner can't match the word to what it heard. In a word that's
// otherwise Latin, each look-alike becomes its Latin twin (a word in Russian or Greek stays).
const LOOKALIKE = { 'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'у': 'y', 'х': 'x', 'і': 'i', 'ј': 'j', 'ѕ': 's', 'ԁ': 'd', 'һ': 'h', 'ԛ': 'q', 'ԝ': 'w', 'ӏ': 'l', 'А': 'A', 'В': 'B', 'Е': 'E', 'К': 'K', 'М': 'M', 'Н': 'H', 'О': 'O', 'Р': 'P', 'С': 'C', 'Т': 'T', 'Х': 'X', 'У': 'Y', 'І': 'I', 'Ј': 'J', 'Ѕ': 'S', 'Α': 'A', 'Β': 'B', 'Ε': 'E', 'Ζ': 'Z', 'Η': 'H', 'Ι': 'I', 'Κ': 'K', 'Μ': 'M', 'Ν': 'N', 'Ο': 'O', 'Ρ': 'P', 'Τ': 'T', 'Υ': 'Y', 'Χ': 'X', 'ο': 'o' };
const LOOK_RE = new RegExp('[' + Object.keys(LOOKALIKE).join('') + ']', 'g');
export function foldLookalikes(text) {
  return String(text || '').replace(/[^\s]+/g, (w) => (/[A-Za-z]/.test(w) && LOOK_RE.test(w) ? w.replace(LOOK_RE, (c) => LOOKALIKE[c]) : w));
}

const NUM_WORD = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
const NUM_SOUND = { 2: 'to', 4: 'for', 8: 'ate' };
export function spoken(w) {
  const s = String(w);
  if (!/\d[a-z]|[a-z]\d/i.test(s)) return s;
  return s.replace(/(\d)([a-z]*)/gi, (m0, d, rest) => {
    const nw = NUM_WORD[Number(d)], r = rest.toLowerCase();
    if (r && r.startsWith(nw.slice(1))) return nw + rest.slice(nw.length - 1);
    if (NUM_SOUND[d] && (r || /[a-z]$/i.test(s.slice(0, s.indexOf(m0))))) return NUM_SOUND[d] + rest;
    return m0;
  });
}

export function alignLyrics(words, text, runs = null) {
  const norm = (s) => spoken(s).toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]/gu, '');
  const P = [];
  // section labels ([Chorus], [Refrain]…) aren't sung, and echoed ad-libs in brackets would
  // only clutter the captions
  text.split(/\n+/).map((l) => l.replace(/\[[^\]]*\]/g, ' ').replace(/\([^)]*\)/g, ' ').trim()).filter(Boolean).forEach((l, line) => {
    for (const w of l.split(/\s+/)) if (norm(w)) P.push({ text: w, line, n: norm(w) });
  });
  const T = words.map((w) => ({ ...w, n: norm(w.text) }));
  const m = P.length, n = T.length;
  if (!m || !n) return null;
  const simOf = (a, b) => {
    if (a === b) return 2;
    const r = 1 - editDistance(a, b) / Math.max(a.length, b.length);
    return r >= 0.5 ? r * 2 - 0.4 : -0.5;
  };
  const SIM = new Float32Array(m * n);
  for (let i = 0; i < m; i++) for (let j = 0; j < n; j++) SIM[i * n + j] = simOf(P[i].n, T[j].n);
  const GAP_P = -0.4, GAP_T = -0.6; // a lyric word the model missed / a heard word not in the lyrics
  const at = (i, j) => i * (n + 1) + j;
  // semi-global alignment of the lyric words (in the order `ord`) against the heard words
  const run = (ord) => {
    const S = new Float32Array((m + 1) * (n + 1)), D = new Uint8Array((m + 1) * (n + 1));
    for (let j = 1; j <= n; j++) { S[at(0, j)] = j * GAP_T; D[at(0, j)] = 2; }
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        const diag = S[at(i - 1, j - 1)] + SIM[ord[i - 1] * n + j - 1], up = S[at(i - 1, j)] + GAP_P, left = S[at(i, j - 1)] + GAP_T;
        const best = Math.max(diag, up, left);
        S[at(i, j)] = best;
        D[at(i, j)] = best === diag ? 0 : best === up ? 1 : 2;
      }
    }
    let end = 1;
    for (let i = 1; i <= m; i++) if (S[at(i, n)] > S[at(end, n)]) end = i;
    return { S, D, end, score: S[at(end, n)] };
  };
  const order = P.map((_, i) => i);
  const { D, end, score } = run(order);
  // lyric index → heard index, for words that really match. Two different words paired up (the
  // alignment pairs them when that's cheaper than skipping both) are not a match: a misheard word
  // ("Dracula" heard as "Jackie Clark") must not take the time of whatever it got paired with.
  const pairs = new Map();
  let good = 0;
  for (let i = end, j = n; i > 0 && j > 0;) {
    const d = D[at(i, j)];
    if (d === 0) { if (SIM[(i - 1) * n + j - 1] > 0) { pairs.set(i - 1, j - 1); good++; } i--; j--; } else if (d === 1) i--; else j--;
  }
  if (!pairs.size) return null;
  if (good < n * 0.3) {
    // breathy vocals under loud guitars leave few clean matches even with the right lyrics, so a
    // weaker match still counts when the lyrics in their real order fit clearly better than the
    // same words shuffled (wrong lyrics fit no better than their shuffles)
    if (good < Math.max(6, n * 0.2)) return null;
    let seed = 7;
    const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    let rival = -Infinity;
    for (let k = 0; k < 8; k++) {
      const q = order.slice();
      for (let i = q.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [q[i], q[j]] = [q[j], q[i]]; }
      rival = Math.max(rival, run(q).score);
    }
    if (score < rival + 3) return null;
  }
  const idx = [...pairs.keys()].sort((a, b) => a - b);
  const out = [];
  for (let i = idx[0]; i <= idx[idx.length - 1]; i++) {
    const j = pairs.get(i), t = j != null ? T[j] : null;
    // exact: the heard word is this very word (not a partial or near match like "limbo" for "kalimbo")
    out.push({ text: P[i].text, line: P[i].line, start: t ? t.start : null, end: t ? t.end : null, heard: !!t, timed: !!(t && t.timed), unlagged: !!(t && t.unlagged), exact: j != null && SIM[i * n + j] >= 2, hj: j });
  }
  // A line the clip catches partway: its first words, sung inside the clip but not recognised (rap
  // over a loud beat), were dropped as if sung before it, and the line's next words slid back over
  // the gap (the Solo Leveling edit lost the first half of its opening line). With room before the
  // first recognised word they stay, spread into that room, and the letter aligner finds them; a
  // line's last words at the clip's end stay only while singing is still heard after them.
  {
    const mk = (q) => ({ text: P[q].text, line: P[q].line, start: null, end: null, heard: false, timed: false, unlagged: false, exact: false, how: 'missed', lead: q < idx[0] });
    const spread = (ws, a, b) => {
      const wts = ws.map((w) => Math.max(1, w.text.replace(/[^\p{L}\p{N}]/gu, '').length)), tot = wts.reduce((x, y) => x + y, 0);
      let acc = 0;
      ws.forEach((w, q) => { w.start = a + ((b - a) * acc) / tot; acc += wts[q]; w.end = a + ((b - a) * acc) / tot; });
    };
    const first = idx[0];
    let a0 = first;
    while (a0 > 0 && P[a0 - 1].line === P[first].line) a0--;
    const tFirst = T[pairs.get(first)].start;
    if (first > a0 && tFirst > 0.3 + 0.18 * (first - a0)) {
      const lead = [];
      for (let q = a0; q < first; q++) lead.push(mk(q));
      spread(lead, Math.max(0.05, tFirst - (0.32 * lead.length + 0.1)), tFirst - 0.02);
      out.unshift(...lead);
    }
    const last = idx[idx.length - 1], jl = pairs.get(last);
    let z1 = last;
    while (z1 + 1 < m && P[z1 + 1].line === P[last].line) z1++;
    const after = T.slice(jl + 1);
    if (z1 > last && after.length) {
      const tail = [];
      for (let q = last + 1; q <= z1; q++) tail.push(mk(q));
      spread(tail, T[jl].end + 0.02, Math.max(T[jl].end + 0.2 * tail.length, after[after.length - 1].end));
      out.push(...tail);
    }
  }
  // Words with no match: whatever the model heard between the matched neighbours is where they
  // were sung (a misheard word is still sound in the right place), so they share out that stretch
  // by length; only with nothing heard in between are they spread across the gap. Either way the
  // letters then pin them to the vocals.
  for (let i = 0; i < out.length; i++) {
    if (out[i].start != null) continue;
    let j = i;
    while (out[j].start == null) j++;
    const k = j - i, j0 = out[i - 1].hj, j1 = out[j].hj, heardBetween = T.slice(j0 + 1, j1);
    // misheard (something was heard where they were sung) or missed outright (nothing heard)
    for (let q = i; q < j; q++) out[q].how = heardBetween.length ? 'misheard' : 'missed';
    let a = out[i - 1].end, b = out[j].start;
    if (heardBetween.length) { a = Math.max(a, heardBetween[0].start); b = Math.min(b, Math.max(a + 0.1, heardBetween[heardBetween.length - 1].end)); }
    // neighbours that overlap (or a heard stretch past the next word) leave no room: the words
    // squeeze in just before the next one, still in order and after the word before
    if (b - a < 0.06 * k) { a = Math.max(out[i - 1].start + 0.05, b - 0.06 * k); if (b - a < 0.06 * k) b = a + 0.06 * k; }
    const wts = out.slice(i, j).map((w) => Math.max(1, w.text.replace(/[^\p{L}\p{N}]/gu, '').length)), tot = wts.reduce((x, y) => x + y, 0);
    let acc = 0;
    for (let q = 0; q < k; q++) {
      out[i + q].start = a + ((b - a) * acc) / tot;
      acc += wts[q];
      out[i + q].end = a + ((b - a) * acc) / tot;
    }
    i = j;
  }
  // How far each word's heard timing can be trusted. A word heard exactly is sure, unless a lyric
  // word near it in the line was missed outright (nothing heard there): then the heard words around
  // it were timed with too few words to go on ("on quillara and the window" heard as "on the
  // window" squeezes "the" early and lets "window" start on "the"); or unless an extra heard word
  // sits right beside it, which took some of its sound. Unsure words are timed again from the
  // lyrics' own letters.
  for (const w of out) if (!w.how) w.how = w.exact ? 'exact' : 'near';
  out.forEach((w, i) => {
    if (w.how !== 'exact') return;
    const p = out[i - 1], q = out[i + 1];
    // a missed word up to two away in the same line (the heard line was short of words, so its
    // other words were spread over the missing ones' sound), or a heard word that isn't in the
    // lyrics right beside it (a long held note heard as an extra word: "I" held, heard "capital I")
    const missed = out.slice(Math.max(0, i - 2), i + 3).some((x) => x.how === 'missed' && x.line === w.line);
    const extra = (p && p.hj != null && w.hj - p.hj > 1) || (q && q.hj != null && q.hj - w.hj > 1);
    w.unsure = !!(missed || extra);
  });
  // A line whose first words were kept from before its first recognised word (above): those words,
  // and any heard word ahead of the line's first sure one (a word heard into the silence before
  // the singing, as the opening hook word was, at 1.8 s with the vocal starting at 2.04), are
  // spread back from that sure word over the singing that leads into it, so the letters look for
  // them there, not in an ad-lib a second earlier.
  if (out.length && out[0].lead) {
    const ln = out[0].line;
    const fs = out.findIndex((w) => w.line === ln && w.how === 'exact' && !w.unsure);
    if (fs > 0) {
      // (from where the singing that leads into the sure word starts, with the vocal's stretches to
      // go on (a rap line's first words sit in the second before it, a sung line's spread wider);
      // without them, at a middle pace)
      const tS = out[fs].start, k = fs, run = runs && runs.filter((r) => r[0] <= tS + 0.05).pop();
      const a = run && run[1] >= tS - 0.3 ? Math.max(run[0], tS - (0.6 * k + 0.1)) : Math.max(0.05, tS - (0.3 * k + 0.1));
      const wts = out.slice(0, k).map((w) => Math.max(1, w.text.replace(/[^\p{L}\p{N}]/gu, '').length)), tot = wts.reduce((x, y) => x + y, 0);
      let acc = 0;
      for (let q = 0; q < k; q++) {
        out[q].start = a + ((tS - 0.02 - a) * acc) / tot; acc += wts[q]; out[q].end = a + ((tS - 0.02 - a) * acc) / tot;
        if (out[q].how === 'exact') { out[q].how = 'missed'; out[q].unsure = true; }
      }
    }
  }
  for (const w of out) delete w.hj;
  return out;
}

// ---------- signal helpers ----------
function fftReal(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let j = 0; j < len / 2; j++) {
        const a = i + j, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
}

// ---------- forced alignment: every word's real start, from the sound of its letters ----------
// Whisper's word times run late (measured on test songs with known word times: every word, by
// 0.25 s typically and up to 0.42 s), and nudging them onto onsets can't fix that. Forced
// alignment can: a CTC speech model (wav2vec2) scores every letter for every 20 ms of the vocals,
// and a Viterbi search finds the one path through the known words that fits the sound best, so
// each word starts where its first letter is actually heard. English letters only; anything
// else keeps its earlier times.
const ALIGN_MODEL = 'Xenova/wav2vec2-base-960h';
const ALIGN_REVISION = 'a19f851b3d42865797e410752b4c570c871e4825';
let alignPromise = null;
function loadAligner(onStatus) {
  if (!alignPromise) {
    alignPromise = (async () => {
      onStatus && onStatus('Loading the timing model (first time ~95 MB, then cached)…');
      const tf = await import(TF_URL);
      const [model, processor] = await Promise.all([
        tf.AutoModelForCTC.from_pretrained(ALIGN_MODEL, { dtype: 'q8', device: 'wasm', revision: ALIGN_REVISION }),
        tf.AutoProcessor.from_pretrained(ALIGN_MODEL, { revision: ALIGN_REVISION }),
      ]);
      const vocab = model.config.vocab_size || 32;
      return { model, processor, vocab };
    })().catch((e) => { alignPromise = null; throw e; });
  }
  return alignPromise;
}
// wav2vec2's letters: blank 0, word gap 4, A–Z and the apostrophe (its vocab.json)
const CTC_IDS = { "'": 27, '|': 4, A: 7, B: 24, C: 19, D: 14, E: 5, F: 20, G: 21, H: 11, I: 10, J: 29, K: 26, L: 15, M: 17, N: 9, O: 8, P: 23, Q: 30, R: 13, S: 12, T: 6, U: 16, V: 25, W: 18, X: 28, Y: 22, Z: 31 };
const letters = (w) => spoken(w).normalize('NFKD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[’‘`]/g, "'").split('').filter((c) => CTC_IDS[c] != null && c !== '|');

// The lead vocal, pulled out of a stereo mix: lead vocals sit dead centre while most instruments,
// reverb and backing parts are spread left and right, so each sliver of sound (every frequency,
// every 16 ms) is kept as far as left and right agree on it, in level and in phase. Band-limited
// to the voice. A mono file just gets the band limit.
export async function centreVocals(buffer, offset, duration) {
  const sr = 16000, n = Math.max(1, Math.ceil(duration * sr));
  const ctx = new OfflineAudioContext(2, n, sr);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(ctx.destination);
  src.start(0, Math.max(0, offset), duration);
  const r = await ctx.startRendering();
  const Lc = r.getChannelData(0), Rc = r.numberOfChannels > 1 ? r.getChannelData(1) : r.getChannelData(0);
  const N = 1024, hop = 256, lo = Math.floor((120 * N) / sr), hi = Math.ceil((7800 * N) / sr);
  const win = new Float32Array(N).map((_, i) => Math.sqrt(0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N)));
  const out = new Float32Array(n + N), norm = new Float32Array(n + N);
  const lr = new Float32Array(N), li = new Float32Array(N), rr = new Float32Array(N), ri = new Float32Array(N);
  for (let s = -N + hop; s < n; s += hop) {
    for (let i = 0; i < N; i++) { const j = s + i, w = win[i]; lr[i] = j >= 0 && j < n ? Lc[j] * w : 0; rr[i] = j >= 0 && j < n ? Rc[j] * w : 0; li[i] = 0; ri[i] = 0; }
    fftReal(lr, li); fftReal(rr, ri);
    for (let k = 0; k <= N / 2; k++) {
      let g = 0;
      if (k >= lo && k <= hi) {
        const pl = lr[k] * lr[k] + li[k] * li[k], pr = rr[k] * rr[k] + ri[k] * ri[k];
        const cross = lr[k] * rr[k] + li[k] * ri[k]; // Re(L·R*): same phase, same level → 1
        const sim = pl + pr > 1e-12 ? Math.max(0, (2 * cross) / (pl + pr)) : 0;
        g = sim * sim * sim;
      }
      const mr = ((lr[k] + rr[k]) / 2) * g, mi = ((li[k] + ri[k]) / 2) * g;
      lr[k] = mr; li[k] = mi;
      if (k > 0 && k < N / 2) { lr[N - k] = mr; li[N - k] = -mi; }
    }
    // inverse FFT by conjugation
    for (let i = 0; i < N; i++) li[i] = -li[i];
    fftReal(lr, li);
    for (let i = 0; i < N; i++) { const j = s + i; if (j < 0 || j >= n) continue; out[j] += (lr[i] / N) * win[i]; norm[j] += win[i] * win[i]; }
  }
  const pcm = new Float32Array(n);
  for (let j = 0; j < n; j++) pcm[j] = norm[j] > 1e-6 ? out[j] / norm[j] : 0;
  return pcm;
}

// The whole song's letter scores, worked out once per song (the heard words and the pasted
// lyrics are both timed from them), and a window of them.
const scoreCache = new WeakMap();
function songScores(buffer, onStatus) {
  if (!scoreCache.has(buffer)) scoreCache.set(buffer, letterScores(buffer, 0, buffer.duration, onStatus).catch((e) => { scoreCache.delete(buffer); throw e; }));
  return scoreCache.get(buffer);
}
function scoreWindow(S, a, b) {
  const f0 = Math.max(0, Math.floor((a - S.t0) * S.rate)), f1 = Math.min(S.frames, Math.ceil((b - S.t0) * S.rate));
  return { ...S, lp: S.lp.subarray(f0 * S.vocab, f1 * S.vocab), frames: f1 - f0, t0: S.t0 + f0 / S.rate };
}

// Where each sung line starts, from the sound alone: the lead vocal (the centre of the mix) rising
// after a breath. Kicks and snares in the centre are short; a line is voice held for a while. So:
// loudness every 10 ms, a level for "singing" set from the song's own quiet and loud parts, on
// after 120 ms above it, off after 300 ms below; a line starts where the voice comes back after
// at least 0.3 s of rest. Returns song times in seconds.
// The stretches the lead vocal sings, [start, end] seconds: its level over the song (the centred
// vocal, 10 ms frames, a 50 ms running median), on once it's been over the threshold for 120 ms and
// off after 300 ms under the lower one; a stretch that starts under 0.3 s after the last ended
// carries on as the same phrase.
export async function vocalRuns(buffer) {
  const sr = 16000, pcm = await centreVocals(buffer, 0, buffer.duration), fr = 160, n = Math.floor(pcm.length / fr);
  if (n < 50) return [];
  const env = new Float32Array(n);
  for (let i = 0; i < n; i++) { let e = 0; for (let j = i * fr; j < (i + 1) * fr; j++) e += pcm[j] * pcm[j]; env[i] = 10 * Math.log10(e / fr + 1e-10); }
  // a 50 ms running median smooths out single hits
  const sm = new Float32Array(n);
  for (let i = 0; i < n; i++) { const w = []; for (let k = Math.max(0, i - 2); k <= Math.min(n - 1, i + 2); k++) w.push(env[k]); w.sort((a, b) => a - b); sm[i] = w[w.length >> 1]; }
  const sorted = [...sm].sort((a, b) => a - b), q = (p) => sorted[Math.floor(p * (n - 1))];
  const floor = q(0.15), loud = q(0.85), on = floor + (loud - floor) * 0.55, off = floor + (loud - floor) * 0.4;
  const out = [];
  let active = false, run = 0, lastOff = -Infinity;
  for (let i = 0; i < n; i++) {
    if (!active) {
      run = sm[i] > on ? run + 1 : 0;
      if (run >= 12) {
        active = true;
        const start = i - run + 1;
        if ((start - lastOff) / 100 >= 0.3 || !out.length) out.push([start / 100, n / 100]);
        run = 0;
      }
    } else {
      run = sm[i] < off ? run + 1 : 0;
      if (run >= 30) { active = false; lastOff = i - run + 1; out[out.length - 1][1] = lastOff / 100; run = 0; }
    }
  }
  return out;
}

// Where sung phrases begin (the vocal's own phrasing, for cutting on lines when no lyrics are given).
export async function vocalPhrases(buffer) {
  return (await vocalRuns(buffer)).map((r) => r[0]);
}

// Log-probabilities of every letter, 50 frames a second, for the song from a to b seconds.
async function letterScores(buffer, a, b, onStatus) {
  const { model, processor, vocab } = await loadAligner(onStatus);
  const sr = 16000, pcm = await centreVocals(buffer, a, b - a);
  const win = 20 * sr, pad = 1.5 * sr, hop = 320, frames = Math.floor(pcm.length / hop);
  const lp = new Float32Array(frames * vocab).fill(-30);
  for (let s = 0; s < pcm.length; s += win) {
    const c0 = Math.max(0, s - pad), c1 = Math.min(pcm.length, s + win + pad);
    if (c1 - c0 < 1600) break;
    const { logits } = await model(await processor(pcm.slice(c0, c1)));
    const F = logits.dims[1], V = logits.dims[2], d = logits.data, per = (c1 - c0) / F; // samples per frame
    for (let f = 0; f < F; f++) {
      const at = c0 + (f + 0.5) * per; // the frame's centre
      if (at < s || at >= Math.min(pcm.length, s + win)) continue; // the overlap belongs to the neighbour
      const g = Math.floor(at / hop);
      if (g >= frames) continue;
      let mx = -Infinity;
      for (let v = 0; v < V; v++) mx = Math.max(mx, d[f * V + v]);
      let se = 0;
      for (let v = 0; v < V; v++) se += Math.exp(d[f * V + v] - mx);
      const ls = mx + Math.log(se);
      for (let v = 0; v < V; v++) lp[g * vocab + v] = d[f * V + v] - ls;
    }
  }
  return { lp, frames, vocab, rate: sr / hop, t0: a };
}

// The best path of the words' letters through the scores (CTC Viterbi: each letter held for one
// or more frames, blanks between them and wherever nothing is sung, a word gap between words).
// Each word may only start within its window [lo, hi] and pays a soft price for starting away
// from its expected frame, so where the letters are clear they decide the time to the frame,
// and where the vocals are buried the word stays near where it was heard instead of wandering.
// Returns each word's [first frame, last frame].
function viterbi(S, ids, wordOfTok, prior) {
  const { lp, frames: T, vocab } = S, N = ids.length, L = 2 * N + 1;
  const lab = (s) => (s & 1 ? ids[s >> 1] : 0);
  const NEG = -1e30;
  const wOf = (s) => (s & 1 ? wordOfTok[s >> 1] : -1);
  const firstTok = (s) => (s & 1) && wordOfTok[s >> 1] >= 0 && ((s >> 1) === 0 || wordOfTok[(s >> 1) - 1] !== wordOfTok[s >> 1]);
  let prev = new Float64Array(L).fill(NEG), cur = new Float64Array(L);
  const back = new Uint8Array(T * L); // 0 stay, 1 from s-1, 2 from s-2
  const allowed = (s, t) => { const w = wOf(s); if (w < 0) return true; const p = prior.get(w); return !p || (t >= p.lo && t <= p.hi); };
  prev[0] = lp[0];
  if (L > 1 && allowed(1, 0)) prev[1] = lp[lab(1)];
  for (let t = 1; t < T; t++) {
    const row = t * vocab;
    for (let s = 0; s < L; s++) {
      if (!allowed(s, t)) { cur[s] = NEG; back[t * L + s] = 0; continue; }
      let enter = NEG, k = 0;
      if (s >= 1) { enter = prev[s - 1]; k = 1; }
      // skipping a blank between two different letters
      if (s >= 2 && (s & 1) && lab(s) !== lab(s - 2) && prev[s - 2] > enter) { enter = prev[s - 2]; k = 2; }
      if (enter > NEG && firstTok(s)) { const p = prior.get(wOf(s)); if (p) { const d = (t - p.c) / p.sd; enter -= 0.5 * d * d; } }
      if (prev[s] >= enter) { cur[s] = prev[s] + lp[row + lab(s)]; back[t * L + s] = 0; } else { cur[s] = enter + lp[row + lab(s)]; back[t * L + s] = k; }
    }
    [prev, cur] = [cur, prev];
  }
  let s = L > 1 && prev[L - 2] > prev[L - 1] ? L - 2 : L - 1;
  if (prev[s] <= NEG / 2) return new Map(); // no path fits the windows: nothing is moved
  const first = new Int32Array(N).fill(-1), last = new Int32Array(N).fill(-1);
  for (let t = T - 1; t >= 0 && s >= 0; t--) {
    if (s & 1) { const k = s >> 1; first[k] = t; if (last[k] < 0) last[k] = t; }
    s -= back[t * L + s];
  }
  const spans = new Map();
  for (let k = 0; k < N; k++) {
    const w = wordOfTok[k];
    if (w < 0 || first[k] < 0) continue;
    const sp = spans.get(w);
    if (!sp) spans.set(w, [first[k], last[k]]);
    else { sp[0] = Math.min(sp[0], first[k]); sp[1] = Math.max(sp[1], last[k]); }
  }
  return spans;
}

// Whisper's word starts run this late (measured on test songs with known word times: 0.25 s
// typical, every word late). The two timings fail in opposite places: the letters pin a word
// that starts on a consonant to the frame ("heartbeat", "chasing", where Whisper is 0.1–0.2 s late)
// but fire late on a short word that starts on a vowel ("and", "is", "in", "are": 0.12–0.19 s),
// which is exactly where Whisper, less its lag, is right (within 0.02 s). So each word takes the
// timing that's reliable for it.
const HEARD_LAG = 0.25;
const vowelStart = (w) => { const l = letters(w); return l.length <= 3 && /^[AEIOU]/.test(l.join('')); };

// Whisper's times less its lag: what words get where the timing model can't be loaded (offline)
// or a word can't be placed.
// (Marked, so a word that already lost the lag never loses it twice. The lag is Whisper's, so a
// word in Japanese, which the letters can't time, loses it too.)
export function unlagWords(words) {
  return words.map((w) => (w.heard !== false && !w.timed && !w.unlagged && w.start != null ? { ...w, start: w.start - HEARD_LAG, end: (w.end ?? w.start + 0.3) - HEARD_LAG, unlagged: true } : { ...w }));
}

// Give words (with rough times) their real start and end from the vocals. A word Whisper heard is
// looked for within 0.6 s of where it should be (its time less Whisper's lag); a lyric word it
// missed (its time only filled in between neighbours) gets a wider window and a looser pull.
// Words with no English letters keep Whisper's times (less its lag).
export async function alignWordsToAudio(buffer, words, onStatus) {
  const idx = words.map((w, i) => i).filter((i) => letters(words[i].text).length);
  if (idx.length < 2) return unlagWords(words);
  const a = Math.max(0, Math.min(...idx.map((i) => words[i].start)) - 1.5);
  const b = Math.min(buffer.duration, Math.max(...idx.map((i) => words[i].end ?? words[i].start + 0.5)) + 1.5);
  onStatus && onStatus('Timing every word to the vocals…');
  const S = scoreWindow(await songScores(buffer, onStatus), a, b);
  const ids = [], wordOfTok = [], prior = new Map();
  idx.forEach((i, n) => {
    if (n > 0) { ids.push(CTC_IDS['|']); wordOfTok.push(-1); }
    for (const c of letters(words[i].text)) { ids.push(CTC_IDS[c]); wordOfTok.push(i); }
    // (words already timed to the vocals, as heard words are before lyrics are matched to them,
    // don't lose Whisper's lag twice)
    // Pasted lyrics matched to heard words that are already timed: how hard each word is held to
    // the time it came with depends on how it was matched (see alignLyrics):
    //   exact and sure: an anchor, held to its time;
    //   exact but unsure (the model heard a word too many or too few beside it): timed again from
    //     the lyrics' letters, the heard time a loose guide;
    //   near (a partial match like "limbo" for "kalimbo"): the letters find where it really starts;
    //   misheard (sung where something else was heard): starts where that heard sound starts;
    //   missed (nothing heard): spread between its neighbours, then found by its letters.
    // Heard words with no lyrics pasted are all first timed here from Whisper's times.
    const w = words[i], heard = w.heard !== false;
    const kind = w.how || (heard ? 'whisper' : 'missed'), anchor = !!w.timed && kind === 'exact' && !w.unsure;
    const c = (w.start - (heard && !w.timed && !w.unlagged ? HEARD_LAG : 0) - S.t0) * S.rate;
    const P = anchor ? [0.03, 0.08] : kind === 'exact' ? [0.2, 0.8] : kind === 'near' ? [0.15, 0.8] : kind === 'misheard' ? [0.04, 0.12] : kind === 'missed' ? [0.35, 1.2] : [0.1, 0.6];
    const len = Math.max(0, (w.end ?? w.start) - w.start);
    prior.set(i, { c, sd: P[0] * S.rate, lo: Math.floor(c - P[1] * S.rate), hi: Math.ceil(c + P[1] * S.rate + len * S.rate), anchor });
  });
  let spans = viterbi(S, ids, wordOfTok, prior);
  // the windows can't all be met (times that came in crossed): search again with only the soft
  // pull toward each word's time, rather than leave the whole song untimed
  if (!spans.size) spans = viterbi(S, ids, wordOfTok, new Map([...prior].map(([k, p]) => [k, { ...p, lo: -Infinity, hi: Infinity }])));
  // anything the search couldn't place still loses Whisper's lag
  const out = unlagWords(words);
  for (const [i, [f0, f1]] of spans) {
    if (prior.get(i) && prior.get(i).anchor) continue; // anchors keep their time
    const st = S.t0 + f0 / S.rate, en = S.t0 + (f1 + 1) / S.rate;
    out[i].end = Math.max(st + 0.06, en);
    out[i].timed = true;
    // a short vowel-led word Whisper heard keeps Whisper's start (less its lag), within reason;
    // so does any short word the letters put far from it (too little sound to go on), unless it sits
    // by a mishearing, where the heard time is the thing in doubt
    // (a word whose heard time is in doubt, or that never had one of its own, goes by its letters)
    // (the letters' lateness on a vowel-led word holds whatever else is in doubt around it)
    const kind = words[i].how, gap = Math.abs(out[i].start - st);
    const ownTime = words[i].heard !== false && kind !== 'misheard' && kind !== 'missed';
    const trustHeard = ownTime && !words[i].unsure;
    if ((ownTime && vowelStart(words[i].text) && gap < 0.3) || (trustHeard && letters(words[i].text).length <= 3 && gap > 0.12)) {
      // keeping the heard start keeps the word's sung length after it too (the letters may have
      // put the word earlier, ending before that start)
      out[i].end = Math.max(out[i].end, out[i].start + Math.max(0.06, en - st));
      continue;
    }
    // a word that opens on a hiss ("stars", "city") starts on the hiss, which is quiet and easy to miss
    out[i].start = st - (/^(S|Z|C[EIY])/.test(letters(words[i].text).join('')) ? 0.05 : 0);
  }
  // starts stay in order (words without letters among them too), and every word ends after it starts
  for (let n = 1; n < idx.length; n++) { const p = out[idx[n - 1]], w = out[idx[n]]; if (w.start < p.start + 0.05) w.start = p.start + 0.05; }
  for (let i = 1; i < out.length; i++) { const p = out[i - 1], w = out[i]; if (p.start != null && w.start != null && w.start < p.start + 0.05) w.start = p.start + 0.05; }
  for (const w of out) if (w.start != null && !(w.end >= w.start + 0.06)) w.end = w.start + 0.06;
  return out;
}
