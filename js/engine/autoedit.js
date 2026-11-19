// Auto-edit engine: turns music + footage analysis into an edit plan and a list
// of independent, toggleable suggestions (cuts, ramps, drop hits, looks...).
import { uid, clamp, avgSpeedOfKeys, getMedia, formatSize, clipSpan, fmtTime, srcTimeAt } from '../state.js';
import { defaultParams, LOOKS, GRADE_DEFAULT } from '../effects.js';
import { gridMean, salProfile, bestCropCenter } from '../analysis/video.js';
import { pickSound, sfxById, sfxManifest } from '../sfx.js';
import { pickVfx } from '../vfx.js';

// Styles distilled from viral TikTok / Instagram anime edits (see README "Edit styles").
// `shot` is the target shot length in seconds per energy level. The reference edits
// average ~0.9 s per shot. Cuts still land on the beat: the nearest 1/2/4/8-beat
// grid is used. Effects are deliberately sparse so every shot stays readable.
export const STYLES = {
  auto: { label: 'Auto — match the song' },
  hype: {
    label: 'Hype', shot: { low: 1.4, mid: 0.85, high: 0.6 }, buildup: 'fast', look: 'neon', kit: 'full',
    finish: { glow: 0.15, glowThreshold: 0.78, vignette: 0.3, grain: 0.06, sharpen: 0.45 }, motionBlur: 0.35, transitions: ['zoomblur', 'whip'], transitionEvery: 0,
    rec: ['cuts', 'drops', 'beatzoom', 'shakes', 'strobe', 'impact', 'bw', 'grade', 'finish', 'motionblur', 'reframe', 'fadeout', 'sfx', 'burst', 'camera', 'actionhits', 'flare', 'fxboost'],
  },
  phonk: {
    label: 'Phonk / Aggressive', shot: { low: 1.4, mid: 0.85, high: 0.65 }, buildup: 'normal', look: 'blood', kit: 'full', impactMode: 'red',
    finish: { glow: 0.12, glowThreshold: 0.8, vignette: 0.35, grain: 0.1, sharpen: 0.5, vhs: 0.1 }, motionBlur: 0.35, transitions: ['zoomblur'], transitionEvery: 0,
    rec: ['cuts', 'velocity', 'drops', 'twitch', 'impact', 'freeze', 'grade', 'finish', 'motionblur', 'reframe', 'fadeout', 'sfx', 'burst', 'camera', 'bw', 'actionhits', 'fxboost'],
  },
  velocity: {
    label: 'Velocity', shot: { low: 1.6, mid: 1.0, high: 0.8 }, buildup: 'normal', look: 'vivid', kit: 'full',
    finish: { glow: 0.15, glowThreshold: 0.78, vignette: 0.25, grain: 0, sharpen: 0.45 }, motionBlur: 0.35, transitions: ['zoomblur', 'whip'], transitionEvery: 0,
    rec: ['cuts', 'velocity', 'drops', 'beatzoom', 'speedlines', 'transitions', 'letterbox', 'grade', 'finish', 'motionblur', 'reframe', 'fadeout', 'sfx', 'burst', 'camera', 'actionhits', 'flare', 'fxboost'],
  },
  glow: {
    label: 'Glow / Amber', shot: { low: 1.6, mid: 1.0, high: 0.8 }, buildup: 'normal', look: 'amber', kit: 'full',
    finish: { glow: 0.23, glowThreshold: 0.74, vignette: 0.25, grain: 0, sharpen: 0.4 }, motionBlur: 0.35, transitions: ['zoomblur', 'spin'], transitionEvery: 0,
    rec: ['cuts', 'velocity', 'drops', 'beatzoom', 'warp', 'transitions', 'grade', 'finish', 'motionblur', 'reframe', 'fadeout', 'sfx', 'burst', 'camera', 'bw', 'actionhits', 'flare', 'fxboost'],
  },
  flow: {
    label: 'Smooth Flow', shot: { low: 2.2, mid: 1.4, high: 1.0 }, buildup: null, look: 'dreamy', kit: 'soft',
    finish: { glow: 0.2, glowThreshold: 0.76, vignette: 0.2, grain: 0, sharpen: 0.35, leaks: 0.22 }, motionBlur: 0.4, transitions: ['echo', 'zoomblur', 'echo', 'defocus'], transitionEvery: 6,
    rec: ['cuts', 'transitions', 'camera', 'drops', 'pulses', 'grade', 'finish', 'motionblur', 'reframe', 'fadein', 'fadeout'],
  },
  lyric: {
    label: 'Lyric / Soft', shot: { low: 2.6, mid: 1.8, high: 1.2 }, buildup: null, look: 'pastel', kit: 'soft',
    finish: { glow: 0.17, glowThreshold: 0.76, vignette: 0.15, grain: 0.04, sharpen: 0.3, leaks: 0.3 }, motionBlur: 0.25, transitions: ['echo', 'zoomblur', 'echo', 'defocus'], transitionEvery: 6,
    rec: ['cuts', 'transitions', 'pulses', 'camera', 'grade', 'finish', 'reframe', 'fadein', 'fadeout'],
  },
  emotional: {
    label: 'Emotional / Sad', shot: { low: 2.8, mid: 1.8, high: 1.2 }, buildup: null, look: 'faded', kit: 'soft',
    finish: { glow: 0.12, glowThreshold: 0.78, vignette: 0.3, grain: 0.08, sharpen: 0.3 }, motionBlur: 0.25, transitions: ['echo', 'defocus'], transitionEvery: 0,
    rec: ['cuts', 'camera', 'letterbox', 'drops', 'grade', 'finish', 'reframe', 'fadein', 'fadeout'],
  },
  dark: {
    label: 'Dark / Framed', shot: { low: 2.0, mid: 1.2, high: 0.8 }, buildup: 'normal', look: 'noir', kit: 'full',
    finish: { glow: 0.1, glowThreshold: 0.8, vignette: 0.3, grain: 0.1, sharpen: 0.45 }, motionBlur: 0.4, transitions: ['zoomblur', 'whip'], transitionEvery: 0,
    rec: ['cuts', 'framed', 'drops', 'glitch', 'impact', 'camera', 'grade', 'finish', 'reframe', 'fadein', 'fadeout', 'sfx', 'burst', 'actionhits', 'fxboost'],
  },
  cinematic: {
    label: 'Cinematic', shot: { low: 3.0, mid: 2.0, high: 1.4 }, buildup: null, look: 'tealorange', kit: 'soft',
    finish: { glow: 0.1, glowThreshold: 0.78, vignette: 0.3, grain: 0.06, sharpen: 0.3 }, motionBlur: 0.3, transitions: ['zoomblur', 'whip', 'echo'], transitionEvery: 0,
    rec: ['cuts', 'letterbox', 'camera', 'transitions', 'drops', 'grade', 'finish', 'reframe', 'fadein', 'fadeout'],
  },
};

// CapCut-style speed curves (Edit → Speed → Curve) plus the ramps used in velocity edits.
export const SPEED_CURVES = {
  // ramps only speed up from normal speed: anime is drawn on 2s/3s, so anything slower holds each
  // drawing even longer and reads as stutter (the "slow" part is normal speed after a rush);
  // fast parts stay ≤ 1.7× so the action can still be followed
  swell: [[0, 1.5], [0.42, 1], [0.6, 1], [1, 1.6]],
  hit: [[0, 1], [0.4, 1], [1, 1.6]],
  bullet: [[0, 1.6], [0.38, 1], [0.62, 1], [1, 1.7]],
  hero: [[0, 1], [0.3, 1.6], [0.5, 1], [0.7, 1.6], [1, 1]],
  montage: [[0, 1.4], [0.25, 1], [0.5, 1.45], [0.75, 1], [1, 1.4]],
  jumpcut: [[0, 0.7], [0.44, 0.7], [0.5, 3], [0.56, 0.7], [1, 0.7]],
  flashin: [[0, 2.4], [0.35, 1], [1, 0.9]],
  flashout: [[0, 0.9], [0.65, 1], [1, 2.4]],
  freeze: [[0, 1], [0.45, 1], [0.5, 0.001], [1, 0.001]],
};

export const LENGTHS = { auto: 'Auto (~18s)', 15: '15 sec', 30: '30 sec', 60: '60 sec', full: 'Full song' };

// The pro profile (the reference edits the user shared, broken down frame by frame): the style the
// song picks keeps its pace and look, and on top of it
//  - the edit is the song's peak only (about 16 s: two bars into the drop, then its run);
//  - it tells one story: shots in the order the footage tells it (the director's story ranges when
//    given), each continuing the action of the last;
//  - a long slowed hero shot before the drop and to close, with in-betweens between its drawings;
//  - a flurry of micro-cuts on the drop (glimpses of the action to come), then the reveal;
//  - the camera never stops (an eased push, pull, roll or drift on every shot) and the cuts hide
//    inside zoom-throughs and whips, each with a whoosh; a riser, sub-boom and impact on the drop;
//  - one bold colour for the whole edit.
// Bigger camera moves are allowed (enlargement up to 1.7× held, 2.3× briefly), and drawings on twos
// may be slowed on hero shots (the in-betweens fill them); the clean profile keeps the stricter rules.
export const HERO_SPEED = 0.45;
// Match the length and attack of each synthesized sound to the cut.
const PRO_SOUNDS = {
  zoom: ['synth/whoosh-deep', 'synth/whoosh-heavy'],
  quick: ['synth/whoosh-air', 'synth/whoosh-swish'],
  buildup: ['synth/riser'],
  dropHit: ['synth/hit'],
  hit: ['synth/hit'],
  actionHit: ['synth/hit'],
  swell: ['synth/swell'],
};
function proSound(role, i = 0) {
  const sounds = PRO_SOUNDS[role];
  return sfxById(sounds[i % sounds.length]);
}
export function proStyle(S) {
  const rec = [...new Set([...S.rec, 'transitions', 'camera', 'sfx', 'drops', 'motionblur', 'grade', 'finish', 'songedits', 'burst', 'backdrop'])].filter((x) => !['letterbox', 'bw', 'pulses', 'fadein', 'fadeout'].includes(x));
  return { ...S, pro: true, length: 16, rec, transitionEvery: 1, buildup: S.buildup || 'normal' };
}

// `motion` is the footage's average motion (0..1; fight scenes run about 0.4, romance and slice of
// life about 0.15).
export function pickAutoStyle(A, motion = null) {
  if (!A) return { key: 'flow', why: 'no soundtrack — smooth cuts and transitions' };
  const f = A.features, bpm = Math.round(f.bpm);
  if (f.meanLoud < 0.33 && f.bpm < 105) return { key: 'emotional', why: `soft, ${bpm} BPM track` };
  // calm footage (faces, talking, scenery) takes a soft style whatever the song's energy: hit
  // effects, bursts and shakes on two people quietly looking at each other read as a mismatch.
  // The song still sets the pace: the cuts land on its beats and the drops still lift.
  if (motion != null && motion < 0.22) {
    if (A.drops.length && f.dynamicRange > 0.3) return { key: 'flow', why: `calm footage on a ${bpm} BPM track with ${A.drops.length} lift${A.drops.length > 1 ? 's' : ''}` };
    return { key: 'lyric', why: `calm footage on a steady ${bpm} BPM track` };
  }
  if (f.bassiness > 0.55 && f.bpm >= 118) return { key: 'phonk', why: `${bpm} BPM with heavy 808 bass` };
  if (f.hitRate > 3.4) return { key: 'hype', why: `${bpm} BPM with constant hard hits` };
  if (A.drops.length && f.dynamicRange > 0.3) return { key: 'velocity', why: `${A.drops.length} big drop${A.drops.length > 1 ? 's' : ''} at ${bpm} BPM` };
  if (f.bpm < 95) return { key: 'cinematic', why: `slow ${bpm} BPM build` };
  return { key: 'glow', why: `steady, driving ${bpm} BPM track` };
}

const CUT_LEAD = 1 / 30;
const levelAt = (sections, t) => (sections.find((s) => t >= s.start && t < s.end) || { level: 'mid' }).level;

function energyMean(A, a, b) {
  if (!A) return 0.5;
  const r = A.curveRate;
  let s = 0, c = 0;
  for (let k = Math.floor(a * r); k < Math.ceil(b * r); k++) if (k >= 0 && k < A.energy.length) { s += A.energy[k]; c++; }
  return c ? s / c : 0.5;
}

function videosOf(project) {
  return project.media.filter((m) => m.kind === 'video' && m.analysis);
}

export function baseClips(project, L) {
  const clips = [];
  let t = 0;
  for (const m of project.media.filter((x) => x.kind === 'video')) {
    if (L != null && t >= L - 0.01) break;
    const dur = L != null ? Math.min(m.duration, L - t) : m.duration;
    clips.push({ id: uid('c'), mediaId: m.id, start: t, dur, srcIn: 0, speedKeys: null, pan: null, scene: [0, m.duration] });
    t += dur;
  }
  return clips;
}

// ---------- plan ----------
export function buildPlan(project, opts) {
  const musicMedia = project.music && getMedia(project, project.music.mediaId);
  const A = musicMedia && musicMedia.audio && musicMedia.audio.analysis;
  const videos = videosOf(project);
  const footage = videos.reduce((s, m) => s + m.duration, 0);
  // footage that can actually carry a shot (scenes long enough, minus their edges)
  const usable = videos.reduce((s, m) => s + (m.analysis ? m.analysis.scenes.reduce((a, sc) => a + Math.max(0, sc.end - sc.start - 0.24), 0) : m.duration), 0);
  let mw = 0, ms = 0;
  for (const m of videos) { const g = m.analysis && m.analysis.grid; if (g && g.motion && g.motion.length) { ms += g.motion.reduce((a, b) => a + b, 0) / g.motion.length * m.duration; mw += m.duration; } }
  const picked = opts.style === 'auto' ? pickAutoStyle(A, mw ? ms / mw : null) : { key: opts.style, why: 'chosen by you' };
  const S0 = opts.pro ? proStyle(STYLES[picked.key]) : STYLES[picked.key];
  // (the director's `ending`: "hold" closes on a held shot, "climax" on half-beat cuts, "beat" keeps
  // one shot a beat to the end; by default the song decides, holding only where it relaxes)
  let S = opts.notes && opts.notes.ending ? { ...S0, ending: String(opts.notes.ending) } : S0;
  // (the director's `mood`: "gentle" sets a slow emotional edit as one style: shots held about four
  // beats through the build and two after the drop, no quickening into it, soft transitions, no
  // impact shakes, smashes or punchy sounds, gentler camera moves, the song muffling into the drop
  // instead of cutting out; `pace: { build, hits }` in beats overrides the cut rhythm in any mood)
  const nt = opts.notes || {}, pc = nt.pace || {};
  if (nt.mood === 'gentle') S = { ...S, gentle: true, buildup: null, shot: { low: 2.2, mid: 2.2, high: 2.2 }, pace: 2 };
  // (a cold open's lead is the muffled bed under a voice line: nothing in it is a sung line to cut on)
  if (Number(nt.lead) > 0) S = { ...S, lead: Number(nt.lead) };
  // (`cuts: { "4.13": 4.86 }`: the director moves a cut, named by its time in the report, to another
  // time, say the next beat, so a line finishes before the cut)
  if (Array.isArray(nt.cutlist) && nt.cutlist.length) S = { ...S, cutlist: nt.cutlist };
  if (nt.cuts && typeof nt.cuts === 'object') S = { ...S, cutMoves: Object.entries(nt.cuts).map(([a, b]) => [Number(a), Number(b)]).filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b)) };
  if (Number(pc.build) > 0 && A) { const t = Number(pc.build) * A.beatDur; S = { ...S, buildup: null, shot: { low: t, mid: t, high: t } }; }
  if (Number(pc.hits) > 0) S = { ...S, pace: Math.round(Number(pc.hits)) };

  // beat grid (synthetic 120 BPM when there is no soundtrack)
  let G;
  if (A) {
    G = { beats: A.beats, downPhase: A.downPhase, beatDur: A.beatDur, sections: A.sections, drops: A.drops.map((d) => d.t), hits: A.hits, bpm: A.bpm, duration: A.duration };
  } else {
    const dur = Math.min(footage, opts.length === 'full' ? footage : Number(opts.length) || 30);
    const beats = [];
    for (let t = 0; t < dur; t += 0.5) beats.push(t);
    G = { beats, downPhase: 0, beatDur: 0.5, sections: [{ start: 0, end: dur, level: 'mid' }], drops: [], hits: [], bpm: 120, duration: dur };
  }

  // never ask for more edit than the footage can fill without repeating shots
  // (a pro edit needs 28 beats for its whole arc: build, the held shots, the drop's hits, the close)
  const want = S.pro && A ? Math.max(S.length, 28 * G.beatDur) : S.length;
  let win = chooseWindow(G, A, opts.length, opts.length === 'auto' ? want : null, opts.length === 'auto' ? Math.min(footage * 0.95, Math.max(usable * 0.85, 6)) : null);
  // the director's song window (`window: [start, end]`, song seconds), snapped to the beats either side
  if (A && Array.isArray((opts.notes || {}).window)) {
    // (a beat within half a beat, else the second as given: a cold open before the song has none)
    const [a, b] = opts.notes.window.map(Number), near = (t) => { if (opts.notes.windowExact) return t; const n = G.beats.length ? nearest(G.beats, t) : t; return Math.abs(n - t) < G.beatDur / 2 ? n : t; };
    if (Number.isFinite(a) && Number.isFinite(b) && b > a + 4) win = { start: Math.max(0, near(a)), end: Math.min(G.duration, near(b)) };
  }
  // the director's drop (`drop`, song seconds): where the arc lands, whatever the analysis found
  // (a song with a cold open in front reads its own entry as the biggest lift)
  if (A && Number.isFinite(Number((opts.notes || {}).drop))) { const d = Number(opts.notes.drop); G.drops = [G.beats.length ? nearest(G.beats, d) : d]; }
  // pro, when no drop in the window can carry the arc (a rap verse, a steady groove): the arc lands
  // on the strongest line start instead, and the song edits make that moment drop (the bass pulls
  // out for the bar before it and slams back on it)
  // (not with the director's own cut list: there's no arc to land, and a lift would put a drop's
  // flash and punch wherever it fell)
  if (S.pro && A && !S.cutlist && !G.drops.some((d) => d >= win.start + G.beatDur * 7.5 && d <= win.end - G.beatDur * 8)) {
    const lift = liftPoint(G, A, win, opts.phrases);
    if (lift != null) G.drops = [...G.drops, lift].sort((a, b) => a - b);
  }
  const slots = buildSlots(G, A, win, S, opts.cutTimes, opts.phrases);
  const notes = opts.notes || {};
  const { clips: picks, scenesUsed, scenesTotal } = assignFootage(slots, videos, win, opts.order || 'story', (m) => cropWidth(project, m), { notes, soft: S.kit === 'soft', pro: !!S.pro });
  // (the flurry glimpses the shots after it as the notes leave them; a note can still pin a glimpse)
  const pins = shotNotesBySlot(picks, videos, notes);
  applyShotNotes(picks, videos, pins);
  fillFlurry(picks, slots, win);
  applyShotNotes(picks, videos, pins, true);
  mergeShotNotes(picks, pins);
  applyLockNotes(picks.filter(Boolean), videos, notes, G, win);
  const clips = placeVoices(picks.filter(Boolean), videos, notes, musicMedia && musicMedia.audio && musicMedia.audio.buffer ? levelOf(musicMedia.audio.buffer, win.start, win.end, 0.5) : null);
  if (S.pro) balanceShots(project, clips);
  const firstDrop = G.drops.find((d) => d > win.start + 1 && d < win.end - 0.5);
  const ctx = { beatDur: G.beatDur, drop: firstDrop != null ? firstDrop - win.start : null, pro: !!S.pro };
  return { styleKey: picked.key, why: picked.why, S, A, G, win, slots, clips, scenesUsed, scenesTotal, L: win.end - win.start, ctx, notes };
}

// Voice lines woven into the edit, from the director's `voices` notes: each `{ at: a source second
// inside the line, t: the timeline second it starts at, text: its subtitle, speaker, color, hold }`
// (the line's span comes from the speech found in the footage, or `from`/`to`). The line's sound
// runs over the cuts, the song ducked under it, the way the references weave a character's words
// into the song: the picture shows the speaker, lips in sync, for up to `hold` seconds (1.6 by
// default, the longest a shot sits still while the song is loud), and a longer line carries on
// under the shots after it while the edit keeps cutting on the beat. Its caption comes with the
// lyrics, in their type and the speaker's colour.
const SPEAKER_COLORS = ['#7fe3ff', '#b6f56b', '#ff7ad1', '#ffd36b', '#c3a6ff'];
// How loud a stretch of audio is: RMS over `frame`-second windows, the given percentile of them
// (speech: the 80th, so pauses between words don't count; a song: the median).
function levelOf(buf, a, b, pct = 0.8, frame = 0.05) {
  const sr = buf.sampleRate, n = Math.max(1, Math.round(frame * sr)), chs = [...Array(buf.numberOfChannels).keys()].map((c) => buf.getChannelData(c));
  const i0 = Math.max(0, Math.floor(a * sr)), i1 = Math.min(buf.length, Math.floor(b * sr)), out = [];
  for (let i = i0; i + n <= i1; i += n) {
    let e = 0;
    for (let j = i; j < i + n; j++) { let v = 0; for (const ch of chs) v += ch[j]; v /= chs.length; e += v * v; }
    out.push(Math.sqrt(e / n));
  }
  if (!out.length) return null;
  out.sort((x, y) => x - y);
  return out[Math.min(out.length - 1, Math.floor(out.length * pct))];
}

// Where speech starts inside a line (seconds from s0): the voice band's loudness every 20 ms, the
// stretches clearly above the line's own floor, pauses under 0.16 s bridged. A translated subtitle
// can't follow the Japanese word for word, but its phrases can come in as the phrases are spoken.
function speechOnsets(buf, s0, s1) {
  const sr = buf.sampleRate, n = Math.round(sr * 0.02), chs = [...Array(buf.numberOfChannels).keys()].map((c) => buf.getChannelData(c));
  const env = [];
  for (let i = Math.floor(s0 * sr); i + n <= Math.min(buf.length, Math.ceil(s1 * sr)); i += n) {
    let e = 0;
    for (let j = i; j < i + n; j += 2) { let v = 0; for (const ch of chs) v += ch[j]; e += v * v; }
    env.push(Math.sqrt(e / (n / 2)));
  }
  if (env.length < 3) return [0];
  const sorted = [...env].sort((a, b) => a - b), thr = Math.max(sorted[sorted.length - 1] * 0.2, sorted[Math.floor(sorted.length * 0.3)] * 2);
  const segs = [];
  let cur = null;
  env.forEach((v, i) => {
    const t = i * 0.02;
    if (v >= thr) { if (cur && t - cur.e <= 0.16) cur.e = t + 0.02; else { cur = { s: t, e: t + 0.02 }; segs.push(cur); } }
  });
  const on = segs.filter((g) => g.e - g.s >= 0.1).map((g) => g.s);
  return on.length ? on : [0];
}

// (a line separated by Demucs before the build, tools/stems.py via sakuga.py: its stem file, which
// starts `stemPre` seconds before the line)
const stemOf = (v) => (v.stem && v.clean !== false ? { stem: String(v.stem), stemPre: Number(v.stemPre) || 0 } : {});

// (a speaker's shot that cuts in late leaves the time before to a copy of the shot planned there:
// the copy's slot, for notes numbered as the report numbers the shots)
const splitFrom = new WeakMap();

function placeVoices(clips, videos, notes, songLevel = null) {
  const vs = notes.voices;
  if (!Array.isArray(vs) || !vs.length) return clips;
  const speakers = [];
  for (const v of vs) {
    const m = videos[Number(v.video) || 0];
    if (!m || v.at == null || v.t == null) continue;
    const at = Number(v.at);
    const line = (m.dialogue || []).find((x) => at >= x.start - 0.05 && at <= x.end + 0.05);
    const s0 = v.from != null ? Number(v.from) : line ? line.start : at - 0.3, s1 = v.to != null ? Number(v.to) : line ? line.end : at + 1.2;
    if (!(s1 - s0 > 0.2)) continue;
    const len = s1 - s0, vis = Math.min(len, v.hold != null ? Math.max(0.3, Number(v.hold)) : 1.6);
    // (`shot: false`: a voice-over; the picture stays as it is and only the line's sound and caption
    // are laid in, carried by the shot playing at its start)
    if (v.shot === false) {
      const T0 = Number(v.t), sp1 = v.speaker || 'voice';
      if (!speakers.includes(sp1)) speakers.push(sp1);
      const host = clips.find((c) => c.start <= T0 + 1e-3 && c.start + c.dur > T0) || clips[0];
      const vl0 = m.audio && m.audio.buffer && songLevel ? levelOf(m.audio.buffer, s0, s1) : null;
      host.voiceAudio = { mediaId: m.id, off: T0 - host.start, srcIn: s0, dur: len, volume: Number(v.volume) || (vl0 ? Math.max(1, Math.min(10, (songLevel * 1.5) / vl0)) : 1.6), duck: v.duck != null ? Number(v.duck) : 0.55, clean: v.clean !== false, target: songLevel ? +(songLevel * 1.5).toFixed(5) : null, ...stemOf(v) };
      host.voiceLine = { ...(Array.isArray(v.words) ? { wordAt: v.words.map(Number) } : {}), ...(Array.isArray(v.spot) ? { spot: v.spot.map(Number) } : {}), text: String(v.text || (line && line.text) || ''), speaker: sp1, color: v.color || SPEAKER_COLORS[speakers.indexOf(sp1) % SPEAKER_COLORS.length], t0: T0, t1: T0 + len, onsets: m.audio && m.audio.buffer ? speechOnsets(m.audio.buffer, s0, s1).map((o) => +(T0 + o).toFixed(3)) : [T0] };
      continue;
    }
    let T = Number(v.t);
    const over = clips.filter((c) => c.start < T + vis + 0.3 && c.start + c.dur > T - 0.12);
    if (!over.length) continue;
    const c0 = over[0], start = c0.start, end = over[over.length - 1].start + over[over.length - 1].dur;
    const sc = ((m.analysis && m.analysis.scenes) || []).find((x) => s0 >= x.start - 0.05 && s0 < x.end);
    // (the line lands at t unless the scene starts too late for that; then it lands as early as it can)
    let srcIn = Math.max(sc ? sc.start + 0.02 : 0, s0 - (T - start));
    T = start + (s0 - srcIn);
    // (the shot opens on its speaker's own line: where the footage before the line has them saying
    // something else, a mouth would talk with no voice, so the shot cuts in as that line ends and
    // the shot it replaces keeps the time before, at least half a second of it; `lead: true` keeps
    // the speaker's lead-in)
    let open = start;
    const said = v.lead === true ? [] : (m.dialogue || []).filter((x) => x.end > srcIn + 0.1 && x.start < s0 - 0.15 && x.end <= s0 + 0.05);
    if (said.length) {
      const at = start + (Math.min(Math.max(...said.map((x) => x.end)) + 0.06, s0) - srcIn);
      if (at - start >= 0.5 && T - at >= 0.05) open = at;
    }
    if (open > start) {
      // (the time before stays with the shot planned there, a copy of it; the speaker's shot is c0)
      const before = { ...c0, id: uid('c'), dur: open - start, voiceAudio: null, voiceLine: null };
      // (it was slowed to fill the whole slot; its shorter time plays at speed where the scene has room)
      if (!before.hero && before.scene && before.srcIn + before.dur <= before.scene[1] - 0.02) before.speedKeys = null;
      splitFrom.set(before, c0);
      clips.splice(clips.indexOf(c0), 0, before);
      srcIn += open - start;
    }
    // (where its scene runs out before the merged shots do, the speaker's shot ends at the last cut
    // inside the scene that still clears what it shows of the line, and the shots after keep their places)
    let D = end;
    if (sc && start + (sc.end - 0.02 - srcIn) < end) {
      const room = start + (sc.end - 0.02 - srcIn), need = T + vis + 0.15;
      const cuts = over.slice(1).map((c) => c.start).filter((x) => x >= need && x <= room);
      if (cuts.length) D = Math.max(...cuts);
    }
    const sp = v.speaker || 'voice';
    if (!speakers.includes(sp)) speakers.push(sp);
    // (levelled to the song: anime mixes its dialogue well under a song's level, so the line is
    // raised until it reads as loud as the song, the ducked song a bed under it: its louder words
    // at 1.5x the song's median level, the song about 5 dB under it; `volume` in the notes overrides)
    const vl = m.audio && m.audio.buffer && songLevel ? levelOf(m.audio.buffer, s0, s1) : null;
    const gain = Number(v.volume) || (vl ? Math.max(1, Math.min(12, (songLevel * 1.5) / vl)) : 1.6);
    Object.assign(c0, { mediaId: m.id, srcIn, start: open, dur: D - open, speedKeys: null, pan: null, scene: sc ? [sc.start, sc.end] : c0.scene, volume: 0, audioOut: null,
      // (the song carries on under the line about 6 dB down, still there, `duck` overriding: 0.3 is
      // the old deep duck, 1 none)
      voiceAudio: { mediaId: m.id, off: T - open, srcIn: s0, dur: len, volume: +gain.toFixed(2), duck: v.duck != null ? Number(v.duck) : 0.55, clean: v.clean !== false, target: songLevel ? +(songLevel * 1.5).toFixed(5) : null, ...stemOf(v), ...(v.under === 'bass' ? { under: 'bass', duck: 0.75 } : v.under === 'cut' ? { under: 'cut', duck: 1 } : {}) }, role: 'voice', hero: false, noted: true,
      voiceLine: { ...(Array.isArray(v.words) ? { wordAt: v.words.map(Number) } : {}), ...(Array.isArray(v.spot) ? { spot: v.spot.map(Number) } : {}), text: String(v.text || (line && line.text) || ''), speaker: sp, color: v.color || SPEAKER_COLORS[(speakers.indexOf(sp)) % SPEAKER_COLORS.length], t0: T, t1: T + len,
        onsets: m.audio && m.audio.buffer ? speechOnsets(m.audio.buffer, s0, s1).map((o) => +(T + o).toFixed(3)) : [T] } });
    clips = clips.filter((c) => !over.includes(c) || c === c0 || c.start >= D - 1e-6);
  }
  return clips;
}

// pro: the shots are balanced before the look goes on, as a colourist matches them: one far darker
// than the edit's own run (a dungeon among daylight shots) is lifted towards the rest, up to 0.9
// stops, so the dark one-colour look doesn't crush it to black (Solo Leveling's dungeon shots sat at
// 0.08 and 0.06 of full brightness against a median of 0.24 and came out at 0.01); the darkest shot
// stays the darkest, and a director's `exposure` note stands
function balanceShots(project, clips) {
  const lum = clips.map((c) => {
    const m = getMedia(project, c.mediaId), g = m && m.analysis && m.analysis.grid;
    return g && g.pl ? gridMean(g, 'pl', c.srcIn, c.srcIn + clipSpan(c)) : null;
  });
  const known = lum.filter((x) => x != null).sort((a, b) => a - b);
  if (known.length < 3) return;
  const target = Math.min(0.17, known[Math.floor(known.length / 2)] * 0.6);
  clips.forEach((c, i) => {
    if (lum[i] == null || c.expo || lum[i] >= target) return;
    c.expo = +clamp(Math.log2(target / Math.max(lum[i], 0.02)), 0, 0.9).toFixed(2);
  });
}

// Director notes name scenes as the footage scan numbered them: a number for the first video
// ("12"), or "video:scene" when there are several ("1:12").
function sceneRef(ref, videos) {
  const [vi, si] = String(ref).includes(':') ? String(ref).split(':').map(Number) : [0, Number(ref)];
  const m = videos[vi], sc = m && m.analysis && m.analysis.scenes[si];
  return sc ? { m, sc, key: m.id + ':' + si } : null;
}

// The peak of a stretch of footage's detail, motion and colour across the frame (0..1, in source
// x), or null when nothing stands out. A cut that keeps the subject where the eye already is reads
// as one gesture; one that makes the eye jump across the frame reads as a jolt.
export function focalOf(g, a, b) {
  if (!g || !g.sal) return null;
  const pr = salProfile(g, a, b);
  let sw = 0, sx = 0, mx = 0;
  for (let q = 0; q < 16; q++) { const w = pr[q] * pr[q]; sw += w; sx += (w * (q + 0.5)) / 16; mx = Math.max(mx, pr[q]); }
  return sw > 0 && mx > 1.6 / 16 ? sx / sw : null;
}

// A shot's subject where it opens and where it ends (source x), from the footage under it as it
// now stands: notes, speed ramps and slow motion move the footage after it was first picked.
export function clipFocal(project, c) {
  const m = getMedia(project, c.mediaId), g = m && m.analysis && m.analysis.grid;
  if (!g) return [null, null];
  const span = clipSpan(c);
  return [focalOf(g, c.srcIn, c.srcIn + Math.min(0.4, span)), focalOf(g, Math.max(c.srcIn, c.srcIn + span - 0.4), c.srcIn + span)];
}

// notes.shots: { "5": { scene: 31, at: 0.4 } } puts shot 5 on scene 31, 0.4 s in, and
// { "5": { src: 149.6 } } on the scene around that source second (the cut's timing and everything
// built on it stay; only the footage under that shot changes)
// Shot numbers in the notes are the report's, counted after voice lines have merged the shots
// under them into one: a dry run of the voice placement maps each back to its slot.
function shotNotesBySlot(picks, videos, notes) {
  if (!notes.shots || !Array.isArray(notes.voices) || !notes.voices.length) return notes;
  const dry = picks.map((c) => c && { ...c });
  const fin = placeVoices(dry.filter(Boolean), videos, notes), shots = {};
  // (a lead-in left before a speaker's late cut shares its slot: its notes and the speaker's are joined)
  for (const [k, v] of Object.entries(notes.shots)) { const f = fin[Number(k)], i = f ? dry.indexOf(splitFrom.get(f) || f) : -1; if (i >= 0) shots[i] = { ...(shots[i] || {}), ...v }; }
  return { ...notes, shots };
}

// `merge: true` on a shot: it joins the shot before, which holds on through its time (the director
// giving a moment longer than the beat grid would); the held shot's scene slides back, or slows a
// touch if it runs out
function mergeShotNotes(clips, notes) {
  const ks = Object.entries(notes.shots || {}).filter(([, v]) => v && v.merge).map(([k]) => Number(k)).sort((a, b) => b - a);
  for (const i of ks) {
    const c = clips[i], prev = clips[i - 1];
    if (!c || !prev) continue;
    prev.dur += c.dur;
    const len = prev.scene ? prev.scene[1] - prev.scene[0] : Infinity;
    if (!prev.speedKeys && prev.scene && prev.srcIn + prev.dur > prev.scene[1] - 0.02) prev.srcIn = Math.max(prev.scene[0] + 0.02, prev.scene[1] - 0.02 - prev.dur);
    if (len < prev.dur) prev.speedKeys = [[0, len / prev.dur], [1, len / prev.dur]];
    if (c.role === 'reveal') prev.role = c.role;
    clips.splice(i, 1);
  }
}

// A shot pinned by its source second (`src`, as the report lists it): the scene around it, and how
// far into it that is. Survives the footage being scanned again (a new browser profile numbers the
// scenes a little differently), where a scene number doesn't.
function srcRef(v, videos) {
  const m = videos[Number(v.video) || 0], t = Number(v.src), scs = (m && m.analysis && m.analysis.scenes) || [];
  const si = scs.findIndex((x) => t >= x.start - 0.02 && t < x.end);
  return si >= 0 ? { m, sc: scs[si], key: m.id + ':' + si, at: Math.max(0, t - scs[si].start) } : null;
}

function applyShotNotes(clips, videos, notes, flurry = false) {
  for (const [k, v] of Object.entries(notes.shots || {})) {
    const c = clips[Number(k)];
    // (with the director's cut list, or `exact: true`, a `src` pin is taken exactly: that source second
    // shows at the cut, at its own speed, whatever the footage scan made of its scenes; the scan trims
    // a sliver at every cut, so a clip's first frame falls between scenes, and it splits a clip on its
    // own flash frames, where a pin would land on a sliver and be slowed to fill the shot)
    if (c && v && v.src != null && (v.exact || Array.isArray(notes.cutlist)) && flurry === (c.role === 'flurry')) {
      const m = videos[Number(v.video) || 0];
      if (!m) continue;
      const slow = Number(v.slow) > 0 && Number(v.slow) < 1 ? clamp(Number(v.slow), 0.2, 1) : null;
      const s0 = Math.max(0, Number(v.src)), span = slow ? c.dur * slow : c.dur, g = m.analysis.grid;
      Object.assign(c, { mediaId: m.id, srcIn: s0, scene: [s0, Math.min(m.duration || Infinity, s0 + span + 0.05)], speedKeys: slow ? [[0, slow], [1, slow]] : null,
        focus: g && g.sal ? bestCropCenter(salProfile(g, s0, s0 + span), 0.35).c : 0.5, noted: true,
        camNote: v.cam || null, expo: Number(v.exposure) || 0, tallFit: v.tall === 'fit', memory: v.look === 'memory' });
      continue;
    }
    const r = v && (v.src != null ? srcRef(v, videos) : sceneRef(v.scene, videos));
    // (a note with no scene can still set the shot's camera or exposure)
    if (c && v && !r && flurry === (c.role === 'flurry')) { if (v.cam) c.camNote = v.cam; if (v.exposure) c.expo = Number(v.exposure) || 0; if (v.look === 'memory') c.memory = true; if (v.tall === 'fit') c.tallFit = true; continue; }
    if (!c || !r || flurry !== (c.role === 'flurry')) continue;
    // (a pinned scene plays at its own speed: the slow-down the planner gave the scene it had picked
    // only stays on a hero shot, where it's meant)
    // (`slow`: real slow motion picked by the director, 0.5 = half speed; the export puts RIFE
    // in-betweens under it on a shot drawn on ones, and QA warns when the shot isn't)
    const slow = Number(v.slow) > 0 && Number(v.slow) < 1 ? clamp(Number(v.slow), 0.2, 1) : null;
    const span = slow ? c.dur * slow : c.hero ? clipSpan(c) : c.dur, len = r.sc.end - r.sc.start;
    const s0 = r.sc.start + clamp(r.at != null ? r.at : Number.isFinite(Number(v.at)) ? Number(v.at) : 0.1, 0, Math.max(0, len - span));
    const g = r.m.analysis.grid;
    Object.assign(c, { mediaId: r.m.id, srcIn: s0, scene: [r.sc.start, r.sc.end], speedKeys: len < span ? [[0, len / c.dur], [1, len / c.dur]] : slow ? [[0, slow], [1, slow]] : c.hero ? c.speedKeys : null,
      focus: g.sal ? bestCropCenter(salProfile(g, s0, s0 + Math.min(span, len)), 0.35).c : 0.5, noted: true,
      // (`cam`: "still" for a wide shot that must keep its edges; `exposure` in stops for a shot that's off)
      camNote: v.cam || null, expo: Number(v.exposure) || 0, tallFit: v.tall === 'fit', memory: v.look === 'memory' });
  }
}

// Lock words (docs/refs/group-G.md, the Love Me letter trend): the shot under each `lockwords` note
// is timed so its lock frame (`src`: the frame where the thing sits in the letter's gap) lands on the
// downbeat, the first one inside the shot unless `at` (song seconds) says. Up to there the footage
// plays at its own speed (`rate` under 1: real slow motion, RIFE in-betweens on a shot drawn on ones),
// stopping dead on the lock frame (`ease` seconds of slowing first, if asked) into a hold
// (`hold` 0: the lock frame held while the camera drifts on). An approach that would reach back past
// the start of the thing's own scene is slowed to fit, and the report says so.
function applyLockNotes(clips, videos, notes, G, win) {
  const list = Array.isArray(notes.lockwords) ? notes.lockwords : [];
  const downs = G.beats.filter((_, i) => (((i - G.downPhase) % 4) + 4) % 4 === 0).map((b) => b - win.start);
  for (const w of list) {
    const c = clips[Number(w && w.shot)], m = videos[Number(w && w.video) || 0];
    if (!c || !m || w.src == null) continue;
    let at = Number.isFinite(Number(w.at)) ? Number(w.at) - win.start : downs.find((d) => d > c.start + 0.15 && d < c.start + c.dur - 0.25);
    if (at == null) at = c.start + c.dur * 0.4;
    at = clamp(at, c.start + 0.1, c.start + c.dur - 0.1);
    const src = Math.max(0, Number(w.src)), lead = at - c.start;
    const scs = (m.analysis && m.analysis.scenes) || [], sc = scs.find((x) => src >= x.start - 0.02 && src < x.end);
    const room = sc ? src - sc.start - 0.02 : src;
    // (the footage plays at a steady rate and stops dead on the lock frame, the camera easing out into
    // it: easing the footage itself, even drawn on ones, left the in-betweens stepping as it slowed;
    // `ease` (seconds) asks for it anyway)
    const ease = clamp(w.ease != null ? Number(w.ease) : 0, 0, lead * 0.8);
    let rate = clamp(Number(w.rate) || 1, 0.25, 1.5), slowed = null;
    // (the source the approach covers: the steady part plus about 0.4 of the ease)
    // (a scene a little short is slowed to fit; one far too short holds its first drawing for the
    // difference and plays at speed: slowing drawings to a tenth stutters, drawing by drawing)
    let wait = 0;
    if ((lead - ease * 0.6) * rate > room && room > 0) {
      const need = room / (lead - ease * 0.6);
      if (need >= 0.7) { rate = need; slowed = +rate.toFixed(2); } else { wait = lead - room / rate; }
    }
    const hold = clamp(Number(w.hold) || 0.001, 0.001, 0.3);
    const uL = lead / c.dur, uE = Math.max(0, (lead - ease) / c.dur), uM = uE + (uL - uE) * 0.35;
    const uW = wait / c.dur;
    c.speedKeys = wait > 0.02 ? [[0, 0.001], [uW, 0.001], [uW + 1e-4, rate], [Math.max(uW + 2e-4, uL - 1e-4), rate], [uL, hold], [1, hold]]
      : ease > 0 ? [[0, rate], [uE, rate], [uM, rate * 0.4], [uL, hold], [1, hold]] : [[0, rate], [Math.max(0, uL - 1e-4), rate], [uL, hold], [1, hold]];
    c.srcIn = 0;
    const s = srcTimeAt(c, lead);
    c.srcIn = Math.max(0, src - s);
    // (the camera aims at the thing: its box, or the middle of the surface the word lies on)
    const kq = w.plane && Array.isArray(w.plane.keys) && w.plane.keys[0];
    const aim = Array.isArray(w.box) && w.box.length >= 2 ? [Number(w.box[0]), Number(w.box[1])] : kq ? [(kq[1] + kq[3] + kq[5] + kq[7]) / 4, (kq[2] + kq[4] + kq[6] + kq[8]) / 4] : null;
    Object.assign(c, { mediaId: m.id, scene: [c.srcIn, Math.min(m.duration || Infinity, src + 0.3)], noted: true, lock: { at, src, rate: +rate.toFixed(2), slowed, held: wait > 0.02 ? +wait.toFixed(2) : null, short: src - s < -0.01, aim, plane: !!kq } });
  }
}

function nearest(arr, t) {
  let best = arr[0];
  for (const x of arr) if (Math.abs(x - t) < Math.abs(best - t)) best = x;
  return best;
}

function chooseWindow(G, A, lengthOpt, styleLen, maxLen) {
  const barDur = G.beatDur * 4;
  if (!A || lengthOpt === 'full') return { start: 0, end: G.duration };
  const want = styleLen || 18;
  let L = lengthOpt === 'auto' ? clamp(Math.max(1, Math.round(want / barDur)) * barDur, 8, 40) : Number(lengthOpt);
  if (maxLen && L > maxLen) L = Math.max(barDur * 2, Math.floor(maxLen / barDur) * barDur);
  // a stand-in for a song you'll add later: the edit starts where you'll start the song
  if (A.guide) {
    const e = G.beats.find((b) => b >= L - 0.02);
    return { start: 0, end: Math.min(e ?? L, G.duration) };
  }
  if (G.duration <= L + 1) return { start: 0, end: G.duration };
  const downs = G.beats.filter((_, i) => (i - G.downPhase) % 4 === 0);
  let start;
  const snapDown = (t, limit) => {
    const ok = downs.filter((d) => d <= limit + 0.01);
    return ok.length ? nearest(ok, t) : t;
  };
  // anchor on the strongest drop whose intro (a few bars before it) still fits in the song
  // the references hit their drop early (2–7 s in): 2–4 bars of tension, then the drop
  const preBars = clamp(Math.round((L * 0.2) / barDur), 2, 4);
  const byScore = [...A.drops].sort((a, b) => b.score - a.score);
  let anchor = null;
  for (const d of byScore) {
    let s = snapDown(Math.max(0, d.t - preBars * barDur), d.t);
    s = clamp(s, 0, Math.max(0, G.duration - L));
    const pos = d.t - s;
    if (pos >= Math.min(2 * barDur, d.t) - 0.05 && pos <= L * 0.6) { anchor = s; break; }
  }
  if (anchor != null) start = anchor;
  else if (A.mainDrop != null) start = snapDown(A.mainDrop - preBars * barDur, A.mainDrop);
  else {
    let best = -1;
    start = 0;
    for (const d of downs) {
      if (d + L > G.duration) break;
      const e = energyMean(A, d, d + L);
      if (e > best) { best = e; start = d; }
    }
  }
  start = clamp(start, 0, Math.max(0, G.duration - L));
  let end = start + L;
  const after = G.beats.filter((b) => b >= end - 0.02 && b <= G.duration);
  if (after.length) end = after[0];
  return { start, end: Math.min(end, G.duration) };
}

// Fraction of the source width that stays visible in the output (1 = nothing cropped).
export function cropWidth(project, m) {
  const { w, h } = formatSize(project);
  const layout = project.layout || 'fill';
  if (layout === 'blur' || !m || !m.w) return 1;
  let Ao = { 'framed-1:1': 1, 'framed-4:5': 0.8, 'framed-16:9': 16 / 9 }[layout] || w / h;
  const As = m.w / m.h;
  if (layout === 'rotate' && (As > 1) !== (w > h)) Ao = h / w;
  return As > Ao ? Ao / As : 1;
}

// Beats per cut closest to the target shot length. 1/2/4/8 keep cuts on the bar
// grid and are preferred; 3 and 6 fill the gaps (e.g. ~1.1 s shots at fast tempos).
function beatsPerCut(target, bd) {
  let best = 1, bv = Infinity;
  for (const k of [1, 2, 3, 4, 6, 8]) {
    const v = Math.abs(Math.log((k * bd) / target)) + (k === 3 || k === 6 ? 0.05 : 0);
    if (v < bv) { bv = v; best = k; }
  }
  return best;
}

function buildSlots(G, A, win, S, cutTimes, phrases) {
  const cuts = [win.start];
  const bd = G.beatDur;
  // the director's own cut list (notes `cutlist`: edit seconds, or { t, role, hero }; t 0 sets the
  // first shot's role): every cut exactly where the director put it, no beat grid, no arc
  if (S.cutlist) {
    const pts = S.cutlist.map((x) => (typeof x === 'number' ? { t: x } : { ...x, t: Number(x.t) })).filter((x) => Number.isFinite(x.t) && x.t >= 0 && win.start + x.t < win.end - 0.1).sort((a, b) => a.t - b.t);
    const at = pts.length && pts[0].t <= 0.05 ? [{ ...pts[0], t: 0 }, ...pts.slice(1)] : [{ t: 0 }, ...pts];
    return at.map((x, i) => {
      const s0 = win.start + x.t, end = i + 1 < at.length ? win.start + at[i + 1].t : win.end;
      const dropped = G.drops.some((d) => d <= s0 + 0.01);
      return { start: s0, end, dur: end - s0, level: levelAt(G.sections, s0 + 0.01), energy: energyMean(A, s0, end), isDrop: G.drops.some((d) => Math.abs(d - s0) < 0.06),
        beats: Math.max(1, Math.round((end - s0) / bd)), role: x.role || (dropped ? 'burst' : 'build'), hero: !!x.hero };
    });
  }
  // lyric edits cut on the words; stretches without vocals fall back to the beat grid
  const words = cutTimes && cutTimes.length ? cutTimes.filter((t) => t > win.start + 0.05 && t < win.end - 0.1) : null;
  if (words) cuts.push(...words);
  const nearWord = (t) => words && words.some((w) => Math.abs(w - t) < Math.max(0.7, bd * 1.5));
  const arc = buildArc(G, win, S, words, A);
  // A new sung line starts on a new shot, the way editors cut to lyrics: the cut grid re-phases at
  // the beat each line lands on (cuts still come every few beats, now counted from the line), so the
  // rhythm stays even and every line opens on a fresh shot. The drop and the arc's held and burst
  // shots keep their own timing.
  const anchors = new Set(), lineAt = new Map();
  if (phrases && phrases.length && !words) {
    for (const ph of phrases) {
      if (ph <= win.start + bd || ph >= win.end - bd) continue;
      let bi = 0;
      for (let i = 0; i < G.beats.length; i++) if (Math.abs(G.beats[i] - ph) < Math.abs(G.beats[bi] - ph)) bi = i;
      const bt = G.beats[bi];
      if (Math.abs(bt - ph) > bd * 0.5 || G.drops.some((d) => Math.abs(d - bt) < bd * 1.5) || (arc && bt > arc.holdStart - 0.02 && bt < arc.burstEnd + 0.02)) continue;
      anchors.add(bi);
      lineAt.set(bi, ph);
    }
  }
  let phase = G.downPhase;
  for (let i = 0; i < G.beats.length; i++) {
    const t = G.beats[i];
    if (anchors.has(i)) {
      phase = i;
      // the shot before a line keeps at least a beat and a half (a shorter one would stutter)
      const last = cuts[cuts.length - 1];
      if (last != null && t - last < bd * 1.5 && last > win.start + 0.05 && !G.drops.some((d) => Math.abs(d - last) < 0.06)) cuts.pop();
    }
    if (t <= win.start + 0.05 || t >= win.end - 0.1) continue;
    // the drop's own shot holds at least a beat and a half
    if (G.drops.some((d) => t > d + 0.01 && t - d < bd * 1.45)) continue;
    let lvl = levelAt(G.sections, t + 0.01);
    if (arc && t > arc.drop && lvl === 'low') lvl = 'mid'; // after the drop the edit keeps moving
    let bpc = beatsPerCut(S.shot[lvl], bd);
    const nd = G.drops.find((d) => d > t + 0.01);
    if (S.buildup && nd != null) {
      // cuts quicken into the drop
      const dt = nd - t;
      // (whole beats: halving 3 beats per cut gives 2, not 1.5, which would never land on a beat)
      const half = Math.max(1, Math.round(bpc / 2)), quarter = bpc / 4 < 1 ? 0.5 : Math.round(bpc / 4);
      if (dt <= bd * 4 + 0.02) bpc = S.buildup === 'fast' && bd >= 0.4 ? quarter : half;
      else if (dt <= bd * 8 + 0.02) bpc = half;
    }
    const k = i - phase;
    if (nearWord(t)) continue;
    if (bpc < 1) {
      cuts.push(t);
      cuts.push((t + (G.beats[i + 1] ?? t + bd)) / 2);
    } else if ((((k % bpc) + bpc) % bpc) === 0) {
      // (gentle: a line the singer starts ahead of the beat gets its cut on the word itself, not the
      // beat after it, so the line never opens on the old shot; its soft transition carries it)
      const ph = lineAt.get(i);
      cuts.push(S.gentle && ph != null && t - ph > 0.06 && ph > (S.lead || 0) + 0.3 ? ph : t);
    }
  }
  for (const d of G.drops) if (d > win.start + 0.05 && d < win.end - 0.1) cuts.push(d);
  // styles with a freeze-frame hold the last two beats before each drop in one shot
  if (S.rec.includes('freeze')) {
    for (const d of G.drops) {
      const h = d - 2 * bd;
      if (h <= win.start + 0.05 || d >= win.end - 0.1) continue;
      for (let i = cuts.length - 1; i >= 0; i--) if (cuts[i] > h + 0.02 && cuts[i] < d - 0.02) cuts.splice(i, 1);
      cuts.push(h);
    }
  }
  // story arc (what a human editor does): two held shots before the drop, the
  // biggest moment on the drop, one hit per beat right after it, held shots to end
  if (arc) {
    for (let i = cuts.length - 1; i >= 0; i--) {
      const c = cuts[i];
      if ((c > arc.holdStart + 0.02 && c < arc.drop - 0.02) || (c > arc.drop + 0.02 && c < arc.burstEnd - 0.02) || c > arc.outroStart + 0.02) cuts.splice(i, 1);
    }
    cuts.push(...arc.cuts);
  }
  cuts.sort((a, b) => a - b);
  const isDrop = (c) => G.drops.some((d) => Math.abs(d - c) < 0.06);
  const arcCut = (c) => arc && arc.cuts.some((a) => Math.abs(a - c) < 0.01);
  const flurryCut = (c) => !!(arc && arc.flurry && arc.flurry.some((a) => Math.abs(a - c) < 0.005));
  const clean = [];
  for (const c of cuts) {
    const last = clean[clean.length - 1];
    // (the flurry's micro-cuts, and the reveal straight after them, are closer than any other cuts)
    const afterFlurry = last != null && flurryCut(last) && arc.reveal != null && Math.abs(c - arc.reveal) < 0.005;
    if ((flurryCut(c) && last != null && (flurryCut(last) || c - last > 0.2)) || afterFlurry) { if (Math.abs(c - last) > 0.005) clean.push(c); continue; }
    if (!clean.length || c - last > (cutTimes && cutTimes.length ? 0.17 : 0.2)) {
      // a grid cut just before one of the arc's own (the held shots, the outro) would leave a
      // sliver of a shot: the arc's cut takes its place
      // (gentle: anything under two and a half beats before a held shot is a sliver too)
      if (arcCut(c) && last != null && !arcCut(last) && !isDrop(last) && c - last < bd * (S.gentle ? 2.6 : 0.95) && clean.length > 1) clean[clean.length - 1] = c;
      else clean.push(c);
    } else if (isDrop(c)) clean[clean.length - 1] = c;
  }
  if (clean.length > 1 && win.end - clean[clean.length - 1] < 0.35) clean.pop();
  // the director's moved cuts (report times are a frame before the beat: CUT_LEAD)
  for (const [from, to] of S.cutMoves || []) {
    const i = clean.findIndex((c, k) => k > 0 && Math.abs(c - CUT_LEAD - from) < 0.08);
    if (i > 0 && to + CUT_LEAD > clean[i - 1] + 0.3 && (i + 1 >= clean.length || to + CUT_LEAD < clean[i + 1] - 0.3)) clean[i] = to + CUT_LEAD;
  }
  // every cut lands a frame before its beat (like the reference edits): the eye registers a cut
  // a touch late, so it reads as exactly on the beat
  const at = (i) => (i === 0 ? clean[0] : i < clean.length ? clean[i] - CUT_LEAD : win.end);
  return clean.map((c, i) => {
    const s0 = at(i), end = at(i + 1);
    let role = null, hero = false;
    if (arc) {
      if (flurryCut(c)) role = 'flurry';
      else if (arc.reveal != null && Math.abs(c - arc.reveal) < 0.01) role = 'reveal';
      else if (c >= arc.holdStart - 0.02 && c < arc.drop - 0.02) role = 'hold';
      else if (Math.abs(c - arc.drop) < 0.06) role = 'reveal';
      else if (c > arc.drop && c < arc.burstEnd - 0.02) role = c >= (arc.climax ?? Infinity) - 0.02 ? 'climax' : 'burst';
      else if (c >= arc.outroStart - 0.02) role = 'outro';
      else role = 'build';
      // pro: the second held shot (into the drop) and the closing shot are the hero shots, slowed
      // (gentle: no slowed hero shots; the drawings play at their own speed)
      hero = !!(S.pro && !S.gentle && ((role === 'hold' && Math.abs(c - arc.holdMid) < 0.01) || (role === 'outro' && i === clean.length - 1)));
    }
    return {
      start: s0, end, dur: end - s0,
      level: levelAt(G.sections, c + 0.01),
      energy: energyMean(A, c, end),
      isDrop: isDrop(c),
      beats: Math.max(1, Math.round((end - c) / bd)),
      role, hero,
    };
  });
}

// Where a stretch of song with no drop lifts, for the arc: a downbeat from 35% of the way in (after
// the held shots), leaving room after it for the hits and, when the window is long enough, the
// closing shots; best where a sung line starts on it and the music swells across it, near 45% in.
// null when there's no room.
function liftPoint(G, A, win, phrases) {
  const bd = G.beatDur, L = win.end - win.start;
  const lo = win.start + Math.max(bd * 7.5, L * 0.35) - 0.02, hi = win.end - bd * (L >= bd * 27.5 ? 16 : 8) + 0.02;
  let best = null, bv = -Infinity;
  G.beats.forEach((t, i) => {
    if (t < lo || t > hi || ((i - G.downPhase) % 4 + 4) % 4 !== 0) return;
    const line = !!(phrases && phrases.some((p) => Math.abs(p - t) < bd * 0.5));
    const swell = energyMean(A, t, t + bd * 2) - energyMean(A, t - bd * 2, t);
    const v = (line ? 1 : 0) + swell * 4 - Math.abs((t - win.start) / L - 0.45) * 2;
    if (v > bv) { bv = v; best = t; }
  });
  return best;
}

function buildArc(G, win, S, words, A) {
  if (S.arc === false || (words && words.length)) return null;
  const bd = G.beatDur;
  // (the strongest drop with room for the arc either side, the song analysis's own score deciding)
  const fits = G.drops.filter((d) => d >= win.start + bd * 7.5 && d <= win.end - bd * 8);
  const score = (d) => ((A && A.drops) || []).reduce((best, x) => (Math.abs(x.t - d) < 0.05 ? x.score : best), 0);
  const D = fits.length ? fits.reduce((a, b) => (score(b) > score(a) ? b : a)) : null;
  if (D == null) return null;
  let di = 0;
  for (let i = 0; i < G.beats.length; i++) if (Math.abs(G.beats[i] - D) < Math.abs(G.beats[di] - D)) di = i;
  const beat = (k) => G.beats[di + k] ?? D + k * bd;
  if (S.pro && S.kit !== 'soft') return proArc(G, win, D, beat, bd, A, S.ending, S.pace || 1, !!S.gentle);
  const holdStart = beat(-8), holdMid = beat(-4);
  // a hit on every beat after the drop; calm edits (and very fast songs) every other beat, so a
  // love song lifts without turning frantic
  const burstStep = bd < 0.3 || S.kit === 'soft' ? 2 : 1;
  const burstEnd = beat(8);
  const cuts = [holdStart, holdMid, D];
  // pro: the drop opens on a flurry of micro-cuts (six glimpses over its first beat, two or three
  // frames each, like the references), then the reveal holds two beats before the hits
  let flurry = null, reveal = null;
  if (S.pro && S.kit !== 'soft') {
    flurry = [D];
    for (let k = 1; k < 6; k++) flurry.push(D + (bd * k) / 6);
    reveal = beat(1);
    cuts.push(...flurry.slice(1), reveal);
    for (let k = 3; k < 8; k += burstStep) cuts.push(beat(k));
  } else for (let k = 2; k < 8; k += burstStep) cuts.push(beat(k));
  // two held shots to finish, if the edit is long enough to afford them
  let outroStart = Infinity;
  const tail = G.beats.filter((b) => b <= win.end + 0.01);
  // (pro: as soon as there are two bars after the hits; the last of them is the slowed hero shot)
  if (win.end - burstEnd >= bd * (S.pro ? 8 : 14) - 0.02 && tail.length > 8) {
    outroStart = tail[tail.length - 9] ?? win.end - bd * 8;
    cuts.push(outroStart, tail[tail.length - 5] ?? win.end - bd * 4);
  }
  return { drop: D, holdStart, holdMid, burstEnd, outroStart, flurry, reveal, cuts: cuts.filter((c) => c > win.start + 0.05 && c < win.end - 0.1) };
}

// The pro arc, from 24 reference edits measured shot by shot: the build ends on two shots of two
// beats and the hero held four beats into the drop; the drop lands on its own shot (the decisive
// moment, played whole for two beats) with a flash; then one shot a beat to the end, whips hiding
// the cuts. Energy rises to the end rather than peaking on the drop and coasting: while the song is
// still loud in the last bar it doubles to half-beat cuts (the climax) and the edit ends on the last
// hit; only where the song relaxes does a held hero shot close it. Nothing is shown twice, so the
// payoff is never given away before the shot that earns it.
function proArc(G, win, D, beat, bd, A, ending, pace = 1, gentle = false) {
  // (gentle: the held stretch into the drop is one four-beat shot, then the hero shot)
  // (gentle: the drop's own shot holds four beats, through the line it lands on)
  const holdStart = beat(-8), holdMid = beat(-4), hits = beat(gentle ? 4 : 2);
  const cuts = gentle ? [holdStart, holdMid, D, hits] : [holdStart, beat(-6), holdMid, D, hits];
  const tail = G.beats.filter((b) => b > hits + 0.02 && b <= win.end + 0.01);
  const end = tail.length ? tail[tail.length - 1] : win.end;
  // (relaxing: the last bar is clearly quieter than the drop's first two bars)
  const relax = ending === 'hold' || (!ending && !!A && energyMean(A, end - bd * 4, end) < energyMean(A, D, D + bd * 8) * 0.8);
  let outroStart = Infinity, climax = Infinity;
  if (relax && tail.length > 6) outroStart = tail[tail.length - 5];
  else if (tail.length > 6 && ending !== 'beat') climax = tail[tail.length - 5];
  // (`pace`: beats per cut after the drop, counted from the first hit)
  tail.forEach((b, i) => {
    if (b >= end - 0.02 || b > outroStart + 0.02) return;
    if (pace > 1 && (i + 1) % pace) return;
    // (no sliver of a shot just before the held close: that cut goes)
    if (pace > 1 && outroStart < Infinity && b < outroStart - 0.02 && outroStart - b < bd * pace * 0.9) return;
    cuts.push(b);
    if (b >= climax - 0.02) cuts.push(b + bd / 2);
  });
  if (outroStart < Infinity) cuts.push(outroStart);
  // burstEnd is the end of the beat-cut stretch (the grid's own cuts are cleared up to there)
  // (the drop's own shot is the reveal; the cut two beats on starts the hits)
  return { drop: D, holdStart, holdMid, burstEnd: outroStart < Infinity ? outroStart : win.end + 1, outroStart, flurry: null, reveal: D, climax, cuts: cuts.filter((c) => c > win.start + 0.05 && c < win.end - 0.1) };
}

// Picks a window of footage for every slot. A good window is readable (sharp,
// detailed, well exposed), keeps its subject inside the crop, matches the music's
// energy with its motion, follows story order and doesn't repeat shots.
// notes.story: the director's story, as stretches of the footage in the order they're told:
// [[12.5, 30], "1:05-1:20", { video: 1, from: 40, to: 52 }]. Seconds or m:ss.
function storyRanges(notes, videos) {
  const sec = (v) => { if (typeof v === 'number') return v; const p = String(v).trim().split(':').map(Number); return p.length === 2 ? p[0] * 60 + p[1] : p[0]; };
  const out = [];
  for (const r of notes.story || []) {
    let vi = 0, a, b;
    if (Array.isArray(r)) [a, b] = r;
    else if (typeof r === 'string') { const m = r.match(/^(?:(\d+)@)?\s*([\d:.]+)\s*-\s*([\d:.]+)$/); if (!m) continue; vi = m[1] ? Number(m[1]) : 0; a = m[2]; b = m[3]; }
    else if (r && typeof r === 'object') { vi = Number(r.video) || 0; a = r.from; b = r.to; }
    const m = videos[vi], A = sec(a), B = sec(b);
    if (m && Number.isFinite(A) && Number.isFinite(B) && B > A + 0.3) out.push({ m, a: Math.max(0, A), b: Math.min(m.duration, B) });
  }
  return out;
}

function assignFootage(slots, videos, win, order, cropW, { notes = {}, soft = false, pro = false } = {}) {
  // director notes: scenes to leave out (a comedy aside, a side character) and scenes to favour
  const sn = notes.scenes || {};
  const banned = new Set((sn.ban || []).map((r) => sceneRef(r, videos)).filter(Boolean).map((r) => r.key));
  const bias = new Map();
  for (const r of sn.prefer || []) { const x = sceneRef(r, videos); if (x) bias.set(x.key, 1.2); }
  for (const [r, w] of Object.entries(sn.weight || {})) { const x = sceneRef(r, videos); if (x) bias.set(x.key, Number(w) || 0); }
  const scenes = [];
  // a story told by the director: only its stretches, in its order (each cut at the footage's own
  // scene cuts, so no window spans two shots)
  const story = storyRanges(notes, videos);
  if (story.length) {
    for (const r of story) {
      r.m.analysis.scenes.forEach((s, si) => {
        const a = Math.max(r.a, s.start + 0.12), b = Math.min(r.b, s.end - 0.12);
        if (b - a >= 0.3 && !banned.has(r.m.id + ':' + si)) scenes.push({ m: r.m, a, b, id: scenes.length, bias: bias.get(r.m.id + ':' + si) || 0, si });
      });
    }
  }
  if (!scenes.length) for (const m of videos) {
    m.analysis.scenes.forEach((s, si) => {
      const a = s.start + 0.12, b = s.end - 0.12;
      if (b - a >= 0.35 && !banned.has(m.id + ':' + si)) scenes.push({ m, a, b, id: scenes.length, bias: bias.get(m.id + ':' + si) || 0, si });
    });
  }
  const storyMode = !!story.length && scenes.length > 0;
  if (!scenes.length) for (const m of videos) scenes.push({ m, a: 0, b: m.duration, id: scenes.length });
  let total = 0;
  for (const sc of scenes) { sc.off = total; total += sc.b - sc.a; sc.w = cropW(sc.m); }
  const need = slots.reduce((s, x) => s + x.dur, 0);
  const allowReuse = need > total * 0.85;
  // one fight is often cut into many short shots: picks within this many seconds of each
  // other read as the same moment twice (scaled to how much footage there is)
  const near = clamp(total / 20, 1.5, 6);
  const used = [];
  const clips = [];
  const N = slots.length;
  // how hard the footage keeps to the order it's told in: a director's story is kept to the letter,
  // and pro edits keep to the footage's own order far more than clean ones
  const orderW = storyMode ? 8 : pro ? 5 : 3;
  let lastPos = -Infinity; // how far through the story the edit has got
  let prev = -1, prev2 = -1, prevSrc = null, prevHue = null, dropPhase = 0;
  const usedScenes = new Set();
  const useCount = new Map(); // each source shot should appear once; repeats read as filler
  const coverCache = new Map();
  const coverOf = (sc, s, span) => {
    if (sc.w >= 0.999) return 1;
    const key = sc.id + '|' + Math.round(s * 5) + '|' + Math.round(span * 20);
    let v = coverCache.get(key);
    if (v == null) { v = bestCropCenter(salProfile(sc.m.analysis.grid, s, s + span), sc.w).cover; coverCache.set(key, v); }
    return v;
  };
  const mean = (g, key, a, b, def) => (g[key] ? gridMean(g, key, a, b) : def);
  // Eye trace: where the eye is at the end of one shot and where the next shot's subject opens.
  let prevFocal = null;

  slots.forEach((slot, i) => {
    // the drop's flurry is filled once the shots after it are chosen (glimpses of them)
    if (slot.role === 'flurry') { clips.push(null); return; }
    // a hero shot plays slowed: it needs that much less footage
    const span = slot.hero ? slot.dur * HERO_SPEED : slot.dur;
    const role = slot.role;
    // 0 before the first drop, 1 during it (while the energy stays high), 2 after
    if (slot.isDrop && dropPhase === 0) dropPhase = 1;
    else if (dropPhase === 1 && slot.level !== 'high') dropPhase = 2;
    let desired = slot.level === 'high' ? 0.8 : slot.level === 'mid' ? 0.5 : 0.3;
    if (role === 'hold' || role === 'outro') desired = 0.25;
    if (role === 'burst' || role === 'climax' || role === 'reveal') desired = 0.85;
    // slow motion shows on movement (hair, a cape, a turn, a leap), not on a still face
    if (slot.hero) desired = 0.5;
    const stretch = role === 'hold' || role === 'outro' ? 0.5 : 0.6; // held close-ups may play slow-mo
    // where the story should be at this point of the edit (by time: the flurry's micro-shots don't
    // move it on)
    const target = ((slot.start - win.start + slot.dur / 2) / Math.max(0.1, win.end - win.start)) * total;
    let best = null;
    for (const sc of scenes) {
      const len = sc.b - sc.a;
      const g = sc.m.analysis.grid;
      const cands = [];
      if (len >= span) {
        const step = Math.max(0.2, (len - span) / 40);
        for (let s = sc.a; s <= sc.b - span + 1e-6; s += step) cands.push({ s, span, fit: 1 });
      } else if (len >= span * stretch) {
        cands.push({ s: sc.a, span: len, fit: len / span });
      }
      for (const c of cands) {
        const mot = gridMean(g, 'pm', c.s, c.s + c.span);
        const lum = gridMean(g, 'pl', c.s, c.s + c.span);
        const edge = mean(g, 'pe', c.s, c.s + c.span, 0.5);
        const sat = mean(g, 'ps', c.s, c.s + c.span, 0.3);
        let score = 1 - Math.abs(mot - desired) + mot * (slot.level === 'high' ? 0.3 : 0.1);
        if (slot.isDrop) score += mot * 0.5 + edge * 0.3;
        if (i === 0) score += edge * 0.5; // open on a clear, detailed shot
        if (role) {
          const face = mean(g, 'pf', c.s, c.s + c.span, 0);
          if (role === 'hold' || role === 'outro') score += Math.min(1, face * 3) * (slot.hero ? 0.8 : 1.6); // faces and eyes carry the tension
          if (role === 'burst' || role === 'climax') score += Math.min(1, face * 3) * 0.4;
          // the drop wants the most explosive moment: motion, colour and a flash right at the start
          if (role === 'reveal') score += mot * 0.8 + Math.min(0.5, sat) * 0.8 + (g.pk ? gridMean(g, 'pk', c.s, c.s + 0.4) * 1.5 : 0);
        }
        score += edge * 0.7 + Math.min(0.5, sat) * 0.4 + sc.bias;
        // calm edits live on faces: close-ups of the characters over empty rooms and skies
        if (soft) score += Math.min(1, mean(g, 'pf', c.s, c.s + c.span, 0) * 3) * 0.6;
        if (lum < 0.08) score -= 1.5; else if (lum < 0.16) score -= 0.5; else if (lum > 0.9) score -= 0.6;
        if (sc.w < 0.999) score += (coverOf(sc, c.s, c.span) - sc.w) * 1.5;
        // a window with an undetected cut or a big flash inside reads as chaos: one shot per slot
        // pro: the impact inside a clip (a hit, a flash, a smear: a spike in the picture) lands on a beat
        // of its slot, the way editors line the hit up with the music, not just the cut; spikes off
        // the beats still read as chaos (or an undetected cut)
        let onBeat = 0;
        if (pro && !soft && g.pk && slot.beats > 0) {
          const step = (slot.dur / slot.beats) * Math.min(1, c.fit);
          for (let k = 0; k < slot.beats; k++) { const t = c.s + k * step; onBeat += gridMean(g, 'pk', t - 0.05, t + 0.07) * 0.12 * g.rate; }
          score += Math.min(1.2, onBeat * 0.8);
        }
        if (g.pk && c.span > 0.3 && role !== 'reveal') score -= Math.max(0, gridMean(g, 'pk', c.s + 0.1, c.s + c.span - 0.05) * (c.span - 0.15) * g.rate - onBeat) * 0.6;
        if (c.fit < 1) score -= 0.25 + (1 - c.fit) * 0.6;
        const pos = sc.off + (c.s - sc.a);
        if (order === 'story' || storyMode) score -= (Math.abs(pos + c.span / 2 - target) / Math.max(1, total)) * orderW;
        // the director's story only moves forward
        if (storyMode && pos < lastPos - 0.25) score -= 2.5;
        // pro: a shot that picks up the action where the last one left it (the next moment of the
        // same sequence) reads as one story
        if (pro && prevSrc && prevSrc.m === sc.m && sc.id !== prev && c.s >= prevSrc.end - 0.1 && c.s <= prevSrc.end + 4) score += 0.35;
        let ov = 0;
        for (const u of used) if (u.m === sc.m) ov += Math.max(0, Math.min(u.b, c.s + c.span) - Math.max(u.a, c.s));
        score -= (ov / c.span) * (allowReuse ? 0.6 : 4);
        let close = 0;
        for (const u of used) if (u.m === sc.m) close += Math.max(0, 1 - Math.abs((u.a + u.b) / 2 - (c.s + c.span / 2)) / near);
        score -= Math.min(2.5, close * 1.4);
        score -= (useCount.get(sc.id) || 0) * (allowReuse ? 0.8 : 1.6);
        if (sc.id === prev) score -= 1.2;
        if (prevSrc && prevSrc.m === sc.m && Math.abs(c.s - prevSrc.t) < 3 && !(pro && sc.id !== prev)) score -= 0.9; // reads as a jump cut
        if (sc.id === prev2) score -= 0.3;
        // colour flow, like the reference mixes: builds and later drops jump to a fresh colour on
        // each cut; the first drop holds one colour family for its run
        if (prevHue && g.phx) {
          const hx = gridMean(g, 'phx', c.s, c.s + c.span), hy = gridMean(g, 'phy', c.s, c.s + c.span);
          if (Math.hypot(hx, hy) > 0.04 && prevHue.ch > 0.04) {
            const dh = Math.abs((((Math.atan2(hy, hx) - prevHue.a) * 180) / Math.PI + 540) % 360 - 180);
            score += dropPhase === 1 ? (dh <= 30 ? 0.35 : dh > 70 ? -0.3 : 0) : dh >= 90 ? 0.3 : dh < 25 ? -0.2 : 0;
          }
        }
        if (prevFocal != null) {
          const fi = focalOf(g, c.s, c.s + Math.min(0.4, c.span));
          if (fi != null) score += 0.35 * (1 - Math.min(1, Math.abs(fi - prevFocal) / 0.3)) - 0.12;
        }
        if (!best || score > best.score) best = { score, sc, mot, ...c };
      }
    }
    if (!best) {
      const sc = scenes[i % scenes.length];
      best = { sc, s: sc.a, span: Math.min(span, sc.b - sc.a), fit: Math.min(1, (sc.b - sc.a) / span), mot: 0.5 };
    }
    used.push({ m: best.sc.m, a: best.s, b: best.s + best.span });
    {
      const g = best.sc.m.analysis.grid;
      if (g.phx) { const hx = gridMean(g, 'phx', best.s, best.s + best.span), hy = gridMean(g, 'phy', best.s, best.s + best.span); prevHue = { a: Math.atan2(hy, hx), ch: Math.hypot(hx, hy) }; }
    }
    usedScenes.add(best.sc.id);
    useCount.set(best.sc.id, (useCount.get(best.sc.id) || 0) + 1);
    prev2 = prev; prev = best.sc.id;
    prevSrc = { m: best.sc.m, t: best.s + best.span / 2, end: best.s + best.span };
    lastPos = Math.max(lastPos, best.sc.off + (best.s - best.sc.a) + best.span);
    const gB = best.sc.m.analysis.grid, focalIn = focalOf(gB, best.s, best.s + Math.min(0.4, best.span));
    prevFocal = focalOf(gB, Math.max(best.s, best.s + best.span - 0.4), best.s + best.span);
    clips.push({
      id: uid('c'), mediaId: best.sc.m.id,
      start: slot.start - win.start, dur: slot.dur, srcIn: best.s,
      // (a hero shot plays at HERO_SPEED, a window too short for its slot stretches to fit)
      speedKeys: slot.hero ? [[0, HERO_SPEED * best.fit], [1, HERO_SPEED * best.fit]] : best.fit < 1 ? [[0, best.fit], [1, best.fit]] : null,
      pan: null, scene: [best.sc.a, best.sc.b], motion: best.mot,
      focus: best.sc.m.analysis.grid.sal ? bestCropCenter(salProfile(best.sc.m.analysis.grid, best.s, best.s + best.span), 0.35).c : 0.5,
      level: slot.level, energy: slot.energy, isDrop: slot.isDrop, beats: slot.beats, role: slot.role, hero: !!slot.hero,
      focalIn, focalOut: prevFocal,
    });
  });
  return { clips, scenesUsed: usedScenes.size, scenesTotal: scenes.length };
}

// The flurry (its slots left empty by assignFootage): glimpses of the shots that follow the drop
// (the reveal and the hits), a moment from the heart of each in turn, so the drop flashes forward
// through the action it opens on.
function fillFlurry(clips, slots, win) {
  const ahead = (i) => { const out = []; for (let j = i + 1; j < clips.length && out.length < 6; j++) if (clips[j]) out.push(clips[j]); return out; };
  let fk = 0;
  clips.forEach((c, i) => {
    if (c) return;
    const slot = slots[i], src = ahead(i).length ? ahead(i) : clips.filter(Boolean).slice(-6);
    const from = src[fk % src.length] || null;
    if (!from) return;
    const fspan = from.dur * (from.speedKeys ? from.speedKeys[0][1] : 1);
    const at = clamp(from.srcIn + fspan * (0.3 + 0.4 * ((fk * 0.618) % 1)), from.scene[0], Math.max(from.scene[0], from.scene[1] - slot.dur));
    clips[i] = { id: uid('c'), mediaId: from.mediaId, start: slot.start - win.start, dur: slot.dur, srcIn: at, speedKeys: null, pan: null, scene: [...from.scene], motion: from.motion, focus: from.focus,
      level: slot.level, energy: slot.energy, isDrop: slot.isDrop, beats: slot.beats, role: 'flurry', hero: false, focalIn: from.focalIn, focalOut: from.focalOut };
    fk++;
  });
}

// ---------- suggestions ----------
function fx(type, start, dur, params = {}) {
  return { id: uid('fx'), type, start: Math.max(0, start), dur, params: { ...defaultParams(type), ...params } };
}

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const timesList = (ts) => ts.slice(0, 3).map((t) => fmtTime(t)).join(', ') + (ts.length > 3 ? '…' : '');

// Moments where a song's bass drops out (song seconds a..b): the low end falls more than 15 dB
// under its level over the previous 0.2 s for 40–300 ms, after the bass had been playing.
function bassGaps(buf, a, b) {
  const sr = buf.sampleRate, L = buf.getChannelData(0), R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : L;
  const hop = Math.round(sr * 0.01), n = Math.max(0, Math.floor((b - a) * 100)), i0 = Math.max(0, Math.floor(a * sr));
  const al = Math.exp((-2 * Math.PI * 110) / sr), env = new Float32Array(n);
  let y = 0;
  for (let k = 0; k < n; k++) {
    let s = 0;
    for (let j = 0; j < hop; j++) { const i = i0 + k * hop + j; if (i >= L.length) break; y = al * y + (1 - al) * (L[i] + R[i]) * 0.5; s += y * y; }
    env[k] = 10 * Math.log10(s / hop + 1e-10);
  }
  const gaps = [];
  for (let k = 20; k < n;) {
    let pk = -1e9;
    for (let j = k - 20; j < k; j++) pk = Math.max(pk, env[j]);
    if (pk > -40 && env[k] < pk - 15) {
      let e = k;
      while (e < n && env[e] < pk - 12) e++;
      if (e - k >= 4 && e - k <= 30) gaps.push([a + k / 100, a + e / 100]);
      k = e + 5;
    } else k++;
  }
  return gaps;
}

// A cold open on the characters' own voices (the Bleach edit): the best spoken line in the footage
// (clear over the music, a face on screen, a few seconds long), and where the song opens up after
// it: on a drop if one lands soon after, otherwise the next downbeat. Calm (soft) edits open this
// way whenever the footage has a good line; the others only when the line runs straight into a drop.
const VOICE_LEAD = 0.25;
function voiceLine(project, plan, beats, drops) {
  const { S, L } = plan, vn = plan.notes && plan.notes.voice;
  if (vn === false) return null; // the director said no voice intro
  // or which line: a source time inside it ({ at }), or a stretch of lines ({ from, to }) that the
  // speech model split up ("Miyamura…" / "your hands and ears are cold")
  const forced = vn && vn.at != null ? Number(vn.at) : null;
  const range = vn && vn.from != null && vn.to != null ? [Number(vn.from), Number(vn.to)] : null;
  if (range) {
    for (const m of videosOf(project)) {
      const lines = (m.dialogue || []).filter((x) => x.end > range[0] + 0.05 && x.start < range[1] - 0.05);
      if (!lines.length) continue;
      const a = lines[0].start, b = lines[lines.length - 1].end, need = b - a + VOICE_LEAD + 0.3;
      const dr = drops.find((d) => d >= need && d <= need + 2.2), dn = beats.find((x) => x.down && x.t >= need);
      const E = dr ?? (dn ? dn.t : need);
      const next = (m.dialogue || []).find((x) => x.start > b - 0.05 && !lines.includes(x));
      return { score: 9, m, a, b, E, lines, out: Math.max(b - 0.05, Math.min(b + 0.2, next ? next.start - 0.32 : Infinity)) };
    }
  }
  let best = null;
  for (const m of videosOf(project)) {
    // clear over the music, and spoken: a theme song sung over the scene (held notes) isn't a line
    const g = m.analysis.grid, segs = (m.dialogue || []).filter((x) => x.loud > 0.9 && !(x.held >= 0.22));
    for (let i = 0; i < segs.length; i++) {
      for (let k = i; k < Math.min(segs.length, i + 3); k++) {
        if (k > i && segs[k].start - segs[k - 1].end > 0.7) break; // one exchange, back to back
        const a = segs[i].start, b = segs[k].end, len = b - a;
        if (len > 6.5) break;
        if (len < 1.2 || a < VOICE_LEAD) continue;
        const lines = segs.slice(i, k + 1), text = lines.map((x) => x.text).join(' '), words = text.split(/\s+/).length;
        if (forced != null && (forced < a - 0.3 || forced > b + 0.3 || k > i)) continue;
        if (words < 2 && forced == null) continue;
        const need = len + VOICE_LEAD + 0.3;
        const dr = drops.find((d) => d >= need && d <= need + 2.2);
        const dn = beats.find((x) => x.down && x.t >= need && x.t <= need + 2.2);
        const E = dr ?? (dn && dn.t);
        if (E == null || E > Math.min(8, L * 0.4) || a - VOICE_LEAD + E > m.duration - 0.05) continue;
        if (S.kit !== 'soft' && dr == null && forced == null) continue;
        const skin = gridMean(g, 'pf', a, b), lum = gridMean(g, 'pl', a, b);
        const loud = lines.reduce((t, x) => t + x.loud, 0) / lines.length;
        // a line that stays on one shot usually has its speaker on screen; one that runs across
        // cuts is often off-screen chatter (and harder to hear right)
        const cuts = (m.analysis.scenes || []).filter((x) => x.start > a + 0.1 && x.start < b - 0.1).length;
        const held = Math.max(...lines.map((x) => x.held || 0));
        const score = Math.min(1.2, skin * 4) + clamp((loud - 1) * 0.5, 0, 1) - Math.abs(len - 3.5) * 0.35 - cuts * 0.4 - clamp((held - 0.12) * 10, 0, 1)
          + (dr != null ? 0.5 : 0) + (/[!?！？]/.test(text + lines.map((x) => x.original || '').join('')) ? 0.2 : 0) - (lum < 0.12 ? 1 : 0) - (words > 18 ? 0.5 : 0);
        // the clip's sound fades out after the line, before anyone starts the next one
        const next = (m.dialogue || []).find((x) => x.start > b - 0.05 && !lines.includes(x));
        const out = Math.min(b + 0.2, next ? next.start - 0.32 : Infinity);
        if (!best || score > best.score) best = { score, m, a, b, E, lines, out: Math.max(b - 0.05, out) };
      }
    }
  }
  return best && (best.score > 0.3 || forced != null) ? best : null;
}

export function buildSuggestions(project, plan) {
  const { S, G, A, win, L } = plan;
  // its own copy of the plan's shots: the voice intro and the loop seam change them, and the
  // suggestions can be rebuilt from the same plan (when the effect libraries finish loading)
  const clips = plan.clips.map((c) => ({ ...c, scene: c.scene && [...c.scene], speedKeys: c.speedKeys && c.speedKeys.map((k) => [...k]) }));
  const tl = (t) => t - win.start;
  const inWin = (t) => t >= win.start - 0.001 && t < win.end - 0.05;
  const drops = G.drops.filter(inWin).map(tl);
  const beats = G.beats.map((b, i) => ({ t: tl(b), i, lvl: levelAt(G.sections, b + 0.01), down: (i - G.downPhase) % 4 === 0 })).filter((b) => b.t >= 0 && b.t < L - 0.05);
  const nearDrop = (t, w = 0.15) => drops.some((d) => Math.abs(d - t) < w);
  const bd = G.beatDur;
  const out = [];
  // effects that read as gimmicks next to the clean reference edits: offered, never on by default
  const GIMMICKS = ['beatzoom', 'speedlines', 'flare', 'warp', 'twitch', 'strobe', 'shakes'];
  // (a gentle edit plays the drawings at their own speed: no velocity ramps, nothing flaring on hits)
  const GENTLE_OFF = ['preview', 'burst', 'actionhits', 'pulses', 'expstrobe', 'velocity', 'glint'];
  // (a lock-word edit, group G, is clean: its words and cuts carry it, no hit effects or zoom pulses
  // on top, and the words and the sign-off card the director asked for are always in)
  const lockEdit = !!(plan.notes && Array.isArray(plan.notes.lockwords) && plan.notes.lockwords.length);
  const add = (s) => { s.recommended = (S.rec.includes(s.id) && !GIMMICKS.includes(s.id) && !(S.gentle && GENTLE_OFF.includes(s.id)) && !(lockEdit && LOCK_OFF.includes(s.id))) || ['lockwords', 'endcard'].includes(s.id); out.push(s); };
  // an edit you made yourself (kept uncut) already has its own hits and camera moves: the auto
  // edit adds a light, clean touch on top instead of piling effects onto it
  const light = !!plan.uncut;

  // the voice intro opens the cut: the line's shot from just before it starts, running on to where
  // the song opens up (or to the source's next cut after the line, the cut's own shots filling the
  // rest); the shots it covers give way and the one it reaches loses its head
  // (pro edits open straight into the song, as the reference edits do: a spoken line only when the
  // director's notes ask for one)
  const voice = plan.uncut || (S.pro && !(plan.notes && plan.notes.voice && typeof plan.notes.voice === 'object')) ? null : voiceLine(project, plan, beats, drops);
  if (voice) {
    const { m, a, b, E } = voice;
    // a breath of the line's shot before it starts, never a stray frame of the shot before
    const own = (m.analysis.scenes || []).find((x) => a >= x.start - 0.05 && a < x.end);
    const s0 = Math.max(a - VOICE_LEAD, own ? own.start + 0.02 : 0);
    voice.s0 = s0;
    const cutAfter = (m.analysis.scenes || []).map((x) => x.start).find((x) => x > b + 0.15 && x < s0 + E - 0.3);
    let D = cutAfter != null ? cutAfter - s0 : E;
    const rest = [];
    for (const c of clips) {
      if (c.start + c.dur <= D + 0.04) { D = Math.max(D, c.start + c.dur); continue; }
      if (c.start < D) {
        const cut = D - c.start;
        if (c.dur - cut < 0.35) { D = c.start + c.dur; continue; }
        c.srcIn += cut * avgSpeedOfKeys(c.speedKeys);
        c.start = D; c.dur -= cut;
      }
      rest.push(c);
    }
    D = Math.min(D, m.duration - 0.05 - s0);
    const g = m.analysis.grid;
    const intro = {
      id: uid('c'), mediaId: m.id, start: 0, dur: D, srcIn: s0, speedKeys: null, pan: null, scene: [s0, s0 + D], motion: 0,
      focus: g.sal ? bestCropCenter(salProfile(g, s0, s0 + D), 0.35).c : 0.5,
      level: 'low', role: 'hold', voice: true, volume: 0, audioOut: voice.out - s0,
    };
    clips.splice(0, clips.length, intro, ...rest);
    voice.D = D;
    // the intro's shot doesn't come back later in the edit: a later shot from the same scene takes
    // an unused scene instead (the one with the most face in it that's long enough)
    const sceneOf = (t) => (m.analysis.scenes || []).find((x) => t >= x.start - 0.01 && t < x.end);
    const introScenes = new Set([sceneOf(s0), sceneOf(s0 + D - 0.05)].filter(Boolean));
    const usedSc = new Set(clips.map((c) => getMedia(project, c.mediaId) === m && sceneOf(c.srcIn)).filter(Boolean));
    for (const c of rest) {
      if (c.mediaId !== m.id || !introScenes.has(sceneOf(c.srcIn))) continue;
      const span = clipSpan(c);
      const alt = (m.analysis.scenes || []).filter((x) => !usedSc.has(x) && !introScenes.has(x) && x.end - x.start >= span + 0.3)
        .map((x) => ({ x, f: gridMean(g, 'pf', x.start, x.end) })).sort((p, q) => q.f - p.f)[0];
      if (!alt) continue;
      usedSc.add(alt.x);
      const st = alt.x.start + Math.min(0.15, (alt.x.end - alt.x.start - span) / 2);
      Object.assign(c, { srcIn: st, scene: [alt.x.start, alt.x.end], focus: g.sal ? bestCropCenter(salProfile(g, st, st + span), 0.35).c : 0.5 });
    }
  }

  // a seamless loop as one unbroken shot: the last shot is the footage just before the first
  // one, at normal speed, so on autoplay the end runs straight on into the start (no blend)
  // (a pro edit ends on its slowed hero shot instead: the loop then blends the end into the start)
  // (never on an edit that ends on an outro instead of a loop, nor over shots the director pinned)
  const noLoop = plan.notes && plan.notes.outro && plan.notes.outro !== 'loop';
  if (!plan.uncut && clips.length >= 3 && !noLoop && !clips[0].noted && !clips[clips.length - 1].noted && !(S.pro && clips[clips.length - 1].hero)) {
    const first = clips[0], last = clips[clips.length - 1];
    const m = getMedia(project, first.mediaId);
    const sc = ((m && m.analysis && m.analysis.scenes) || []).find((x) => first.srcIn >= x.start - 0.01 && first.srcIn < x.end);
    const need = last.dur, span = clipSpan(first);
    if (sc) {
      let s0 = first.srcIn;
      const room = s0 - need >= sc.start + 0.04;
      if (!room) s0 = sc.start + 0.04 + need;
      if ((room || !first.voice) && s0 + span <= sc.end - 0.04) { // a spoken line stays put
        first.srcIn = s0;
        Object.assign(last, { mediaId: first.mediaId, srcIn: s0 - need, speedKeys: null, pan: first.pan, focus: first.focus, scene: [s0 - need, s0] });
        first.seam = last.seam = true;
      }
    }
    if (!first.seam && !first.voice) {
      // no room before the first shot: the first shot carries on from where the last one ends
      const lm = getMedia(project, last.mediaId), lsc = ((lm && lm.analysis && lm.analysis.scenes) || []).find((x) => last.srcIn >= x.start - 0.01 && last.srcIn < x.end);
      const lspan = clipSpan(last), fspan = first.dur;
      if (lsc && last.srcIn + lspan + fspan <= lsc.end - 0.04) {
        Object.assign(first, { mediaId: last.mediaId, srcIn: last.srcIn + lspan, speedKeys: null, pan: last.pan, focus: last.focus, scene: [last.srcIn + lspan, last.srcIn + lspan + fspan] });
        last.speedKeys = null;
        first.seam = last.seam = true;
      }
    }
  }

  add({
    id: 'cuts', icon: '✂', group: 'Structure', title: 'Cut to the beat',
    desc: `${plural(clips.length, 'cut')} locked to ${Math.round(G.bpm)} BPM` + (drops.length ? `, hardest motion on the drop at ${fmtTime(drops[0])}` : '') + ` · ${plan.scenesUsed}/${plan.scenesTotal} scenes used`,
    clips, at: 0,
  });

  if (voice) {
    const { E, D, lines, s0 } = voice;
    // subtitles timed to the line (the source plays from s0 at timeline 0)
    const texts = lines.map((x, i) => {
      const st = Math.max(0.05, x.start - s0), en = Math.min(i < lines.length - 1 ? lines[i + 1].start - s0 - 0.04 : x.end - s0 + 0.35, E - 0.05);
      return { text: x.text, start: st, dur: Math.max(0.5, en - st), style: 'dialogue', size: 0.036, x: 0.5, y: 0.82, align: 'center', color: '#f7d7a8', anim: 'fade', subtitle: true };
    });
    add({
      id: 'voiceintro', icon: '🗣', group: 'Structure', title: 'Voice intro',
      desc: `Opens on a character's own spoken line from the footage, with the song low and muffled under it until it opens up at ${fmtTime(E)}`,
      mod: 'voice', voice: { end: E, line: D }, effects: [fx('muffle', 0, E, { intensity: 0.75, closed: true })], at: 0,
    });
    out[out.length - 1].recommended = true;
    // English subtitles for the line, like the reference (translated automatically: the wording is
    // worth a glance on the Text track)
    add({ id: 'voicesubs', icon: '💬', group: 'Text', title: 'Subtitle the voice intro', desc: `The line in English: "${lines.map((x) => x.text).join(' ').slice(0, 70)}" (translated automatically, retype it on the Text track if it's off)`, texts, at: 0 });
    out[out.length - 1].recommended = true;
  }

  // footage kept as it is (an edit made for another song): keep its shots and their order, and
  // move every cut onto this song's beat
  const retimed = plan.uncut ? retimeToBeats(project, G, win) : null;
  if (retimed) {
    add({ id: 'retime', icon: '⏱', group: 'Structure', title: 'Re-time cuts to the beat', desc: `Your ${plural(retimed.clips.length, 'shot')} in the same order, each cut moved onto the ${Math.round(G.bpm)} BPM beat (on average ${Math.round(retimed.moved * 1000)} ms), at normal speed and trimmed to fit`, clips: retimed.clips, at: 0 });
    out[out.length - 1].recommended = true;
  }

  const rampable = clips.filter(rampEligible);
  if (rampable.length) {
    add({ id: 'velocity', icon: '⚡', group: 'Motion', title: 'Velocity ramps', desc: `Speed ramps on ${plural(rampable.length, 'clip')} — fast into slow-mo right on the beat`, mod: 'velocity', at: rampable[0].start });
  }

  if (drops.length) {
    const soft = S.kit === 'soft';
    const effects = [];
    for (const d of drops) {
      // (never on the very first frames: the first frame is the thumbnail and the hook, and has to be
      // the clean picture, not a flash)
      if (d < 0.5) continue;
      if (soft) {
        effects.push(fx('flash', d - 0.02, 0.5, { intensity: 0.55 }), fx('zoom', d, 0.7, { intensity: 0.3 }));
      } else if (S.pro) {
        // pro, as the references hit a drop: one frame of white decaying over three or four, and the
        // held drop shot shaking lightly on twos (the camera pulls back off the hit on its own)
        const shot = clips.find((c) => d + 0.05 >= c.start && d + 0.05 < c.start + c.dur);
        // (`transitions: { drop: "whiteout" }`: the picture ramps up to white over the last few frames
        // into it instead, a hard cut on the drop out of the white)
        const tdrop = plan.notes && plan.notes.transitions && plan.notes.transitions.drop;
        if (tdrop === 'whiteout') effects.push(fx('whiteout', d - 0.3, 0.3 - 0.005, { intensity: 1 }), fx('flash', d - 0.005, 3 / 24, { intensity: 0.5 }));
        else effects.push(fx('flash', d - 0.01, 1 / 24 + 4 / 24, { intensity: S.gentle ? 0.5 : 0.9 }));
        // (gentle: the drop lands without a shake, and from it the memories keep their own warm colour)
        if (shot && !S.gentle) effects.push(fx('shake', d, Math.min(0.6, shot.start + shot.dur - d - 0.05), { intensity: 0.16, style: 'stepped' }));
        if (S.gentle) effects.push(fx('natural', d - 0.05, L - d + 0.05, { intensity: 1, warm: 0.5 }));
        // (a shot noted `look: "memory"`: a remembered moment, warm and softly glowing against the
        // present day's one-colour grade)
        for (const c of clips) if (c.memory) effects.push(fx('natural', c.start - 0.02, c.dur + 0.04, { intensity: 1, warm: 0.6, memory: 1 }));
      } else {
        // a long drop shot (held for the bar, like the reference edits) shakes on twos for its
        // length; a quick one gets the usual hit shake
        const shot = (plan.uncut ? (retimed ? retimed.clips : project.clips) : clips).find((c) => d + 0.05 >= c.start && d + 0.05 < c.start + c.dur);
        const held = shot && shot.start + shot.dur - d >= 1.2;
        if (light) effects.push(fx('flash', d - 0.02, 0.28, { intensity: 0.6 }));
        else effects.push(fx('flash', d - 0.02, 0.32, { intensity: 0.75 }), fx('zoom', d, 0.45, { intensity: 0.32 }), held ? fx('shake', d, Math.min(0.7, shot.start + shot.dur - d - 0.05), { intensity: 0.22, style: 'stepped' }) : fx('shake', d, 0.35, { intensity: 0.25 }), fx('rgb', d, 0.2, { intensity: 0.1 }));
        // and a soft white bar sweeps the frame two frames after the beat
        effects.push(fx('sweep', d + 2 / 30, 2 / 30 + 0.005, { intensity: 0.85 }));
      }
    }
    add({ id: 'drops', icon: '💥', group: 'Impact', title: soft ? 'Glow hit on the drop' : 'Drop impact', desc: (soft ? 'Soft flash + push on ' : 'Flash, zoom punch, shake (on twos when the drop shot is held), RGB split and a flash sweep bar on ') + `${plural(drops.length, 'drop')} (${timesList(drops)})`, effects, at: Math.max(0, drops[0] - 1) });
    // the exposure strobe of phonk edits: a held drop shot flips between blown-out glow and
    // normal on the beat's eighth notes for its first bar
    const strobeDrops = drops.filter((d) => { const sh = (plan.uncut ? (retimed ? retimed.clips : project.clips) : clips).find((c) => d + 0.05 >= c.start && d + 0.05 < c.start + c.dur); return sh && sh.start + sh.dur - d >= 1.2; });
    if (strobeDrops.length && !soft) add({ id: 'expstrobe', icon: '◫', group: 'Impact', title: 'Exposure strobe on held drops', desc: `The picture flips between blown-out glow and normal on eighth notes for the first bar of ${plural(strobeDrops.length, 'held drop')}`, effects: strobeDrops.map((d) => fx('expstrobe', d + 0.04, Math.min(bd * 4, 1.6), { intensity: 0.55, rate: Math.round(2 / bd) })), at: Math.max(0, strobeDrops[0] - 1) });
    add({ id: 'flare', icon: '✸', group: 'Impact', title: 'Light burst on the drop', desc: 'Rays and a lens streak bursting from the character on the main drop', effects: [fx('flare', drops[0] - 0.02, 0.7, { intensity: 0.75 })], at: Math.max(0, drops[0] - 1) });
    add({ id: 'warp', icon: '∿', group: 'Impact', title: 'Warp on the drop', desc: 'Bulge distortion that snaps back on the main drop', effects: [fx('warp', drops[0], 0.4, { intensity: 0.55, mode: 'bulge' })], at: Math.max(0, drops[0] - 1) });
    add({ id: 'speedlines', icon: '✳', group: 'Impact', title: 'Anime speed lines', desc: 'Manga-style action lines for one beat on the main drop', effects: [fx('speedlines', drops[0], bd * 1.5, { intensity: 0.45 })], at: Math.max(0, drops[0] - 0.5) });
  }

  // accents are budgeted: at most one per bar, so shots stay readable
  const bar = bd * 4;
  const burst = clips.filter((c) => c.role === 'burst');
  const inBurst = (t) => burst.some((c) => t >= c.start - 0.05 && t < c.start + c.dur);
  if (burst.length) {
    const effects = [];
    burst.forEach((c, i) => {
      const d = Math.min(0.4, c.dur * 0.9);
      if (i === 0) {
        // an aimed smash on the first beat: push toward where this shot's action is hottest
        const g = getMedia(project, c.mediaId)?.analysis?.grid;
        const k = g ? Math.max(0, Math.min(g.motion.length - 1, Math.round((c.srcIn + 0.05) * g.rate))) : 0;
        if (g && g.ix) effects.push(fx('smash', c.start, Math.max(0.3, d), { intensity: 0.5, x: g.ix[k], y: g.iy[k], hold: 0 }));
        else effects.push(fx('zoom', c.start, d, { intensity: 0.25 }));
      }
      // a clean punch-in or a small 3D swing on the other beats: no shake every beat, so the
      // action stays readable
      // then the cuts themselves carry the rhythm, with a small punch-in on every other beat (pro:
      // the camera's settling zoom on every cut does that job, and flashes wait for the climax)
      else if (i % 2 === 0 && !S.pro) effects.push(fx('zoom', c.start, Math.min(d, 0.3), { intensity: 0.14 }));
      if (i % 4 === 0 && S.kit !== 'soft' && !S.pro) effects.push(fx('flash', c.start - 0.01, Math.min(0.2, c.dur * 0.6), { intensity: 0.22 }));
    });
    // pro: the climax (half-beat cuts in the last bar) strobes, a two-frame flash on every other cut
    clips.filter((c) => c.role === 'climax').forEach((c, i) => { if (i % 2 === 0) effects.push(fx('flash', c.start - 0.01, 2 / 24 + 0.02, { intensity: 0.3 })); });
    add({ id: 'burst', icon: '⚡', group: 'Impact', title: 'Hit every beat after the drop', desc: `${plural(burst.length, 'quick cut')} right after the drop: an aimed smash on the first, then a small punch-in on every other beat${S.kit !== 'soft' ? ' and a light flash every fourth' : ''}`, effects, at: Math.max(0, burst[0].start - 1.5) });
  }

  // hits on the action: find where a hit actually lands inside each shot (a surge of
  // motion or a flash in the footage) and put a shake + punch sound exactly there
  const hitTimes = []; // where hits land in the footage (also used by the FX boost)
  const hitPts = []; // …and where in the frame, how hard and in what colour (for VFX overlays)
  {
    // impact shots: find where a punch, throw or hit actually lands in each shot (a surge of motion
    // or a flash) and where in the frame (the part that changes most violently), then hit back
    // right there. The hardest hits get the full shot — a 3-frame hit-stop, a smash zoom and a
    // shockwave from the contact point, a flash; others a lighter smash. All get a shake (no punch
    // sounds: they read as fake over a song). Spaced at least 0.9 s apart so every one lands.
    const cands = [];
    const rampsComing = S.rec.includes('velocity') && !plan.uncut;
    // footage kept uncut (an edit you made elsewhere): find the hits on the clip as it is
    for (const c of plan.uncut ? (retimed ? retimed.clips : project.clips) : clips) {
      if (c.role === 'hold' || c.role === 'outro' || c.isDrop || c.dur < 0.3 || (rampsComing && rampEligible(c))) continue;
      const m = getMedia(project, c.mediaId);
      const g = m && m.analysis && m.analysis.grid;
      if (!g || !g.spike) continue;
      const span = clipSpan(c);
      // one hit per shot inside the clip (a long uncut clip holds many shots)
      const cuts = (m.analysis.scenes || []).map((sc) => sc.start).filter((x) => x > c.srcIn + 0.3 && x < c.srcIn + span - 0.3);
      const bounds = [c.srcIn, ...cuts, c.srcIn + span];
      for (let si = 0; si < bounds.length - 1; si++) {
        let best = null;
        const k0 = Math.ceil((bounds[si] + 0.12) * g.rate), k1 = Math.floor((bounds[si + 1] - 0.08) * g.rate);
        for (let k = Math.max(2, k0); k < Math.min(g.motion.length, k1); k++) {
          const v = g.spike[k] + Math.max(0, g.motion[k] - g.motion[k - 2]) * 2;
          if (v > 0.35 && (!best || v > best.v)) best = { v, k };
        }
        if (!best) continue;
        const t = c.start + ((best.k / g.rate - c.srcIn) * c.dur) / span;
        if (nearDrop(t, 0.35) || inBurst(t)) continue;
        cands.push({ t, v: best.v, x: g.ix ? g.ix[best.k] : c.focus ?? 0.5, y: g.iy ? g.iy[best.k] : 0.5 });
      }
    }
    const picked = [];
    for (const h of [...cands].sort((a, b) => b.v - a.v)) if (picked.every((o) => Math.abs(o.t - h.t) >= 0.9)) picked.push(h);
    picked.sort((a, b) => a.t - b.t);
    const ranked = [...picked].sort((a, b) => b.v - a.v);
    const effects = [];
    for (const h of picked) {
      const strong = ranked.indexOf(h) < 2 || h.v > 0.9;
      if (light) {
        // your own edit: just a crisp hit-stop and a soft flash on the hardest hits
        if (strong) effects.push(fx('smash', h.t - 0.02, 0.3, { intensity: 0.35, x: h.x, y: h.y, hold: 0.08 }), fx('flash', h.t - 0.02, 0.1, { intensity: 0.18 }));
      } else {
        effects.push(fx('smash', h.t - 0.02, strong ? 0.45 : 0.35, { intensity: strong ? 0.8 : 0.5, x: h.x, y: h.y, hold: strong ? 0.08 : 0 }));
        if (strong) effects.push(fx('shake', h.t + 0.08, 0.2, { intensity: 0.18, style: 'chaos' }), fx('flash', h.t - 0.02, 0.1, { intensity: 0.2 }));
      }
      hitTimes.push(h.t);
      hitPts.push({ ...h, strong });
    }
    // the hardest hits also light the characters up: a rim aura in a colour that suits the shot
    const auraColor = (h) => {
      const c = (plan.uncut ? (retimed ? retimed.clips : project.clips) : clips).find((x) => h.t >= x.start && h.t < x.start + x.dur);
      const g = c && getMedia(project, c.mediaId)?.analysis?.grid;
      if (!g || !g.hx) return '#ff8a1f';
      const k = Math.max(0, Math.min(g.hx.length - 1, Math.round((c.srcIn + (h.t - c.start)) * g.rate)));
      const hue = ((Math.atan2(g.hy[k], g.hx[k]) * 180) / Math.PI + 360) % 360;
      return hue > 170 && hue < 280 ? '#4aa8ff' : hue > 280 && hue < 330 ? '#ff4fd8' : '#ff8a1f';
    };
    // (the glowing character aura is offered as an effect, not added automatically: a rim of light
    // flaring round the characters reads as a gimmick next to the clean reference edits)
    for (const p of hitPts) p.color = auraColor(p);
    // the very hardest also gets a 3-frame manga impact frame, like the reference edits; when its
    // shot ends just after the hit, it fades down instead (inverted, washed white, grey, indigo,
    // black) and the next shot cuts in out of the dark
    if (ranked[0] && ranked[0].v > 0.9) {
      const h = ranked[0], sh = (plan.uncut ? (retimed ? retimed.clips : project.clips) : clips).find((c) => h.t >= c.start && h.t < c.start + c.dur);
      const end = sh ? sh.start + sh.dur : Infinity;
      if (end - h.t > 0.3 && end - h.t < 0.6 && !nearDrop(end, 0.3)) effects.push(fx('fadechain', end - 7 / 30, 7 / 30, { intensity: 1 }));
      else if (!S.rec.includes('impact') && !light) effects.push(fx('impact', h.t + 0.1, 0.1, { intensity: 1, mode: S.impactMode || 'mono' }));
    }
    // ...and the one sound: a heavy body punch layered with a low thump for weight, each lined up
    // so its transient (not the file's start) lands on the contact frame, mixed under the song
    const sounds = [];
    if (ranked[0] && ranked[0].v > 0.8) {
      // (pro: the editor's own cinematic hit)
      for (const [id, vol] of S.pro ? [[(proSound('actionHit') || {}).id, 0.42]] : [['blood/big-hardpunch4', 0.5], ['fighting/hard-enhancer-02', 0.32]]) {
        const snd = id && sfxById(id);
        if (snd) sounds.push({ sound: id, start: Math.max(0, ranked[0].t - (snd.attack || 0)), vol });
      }
    }
    const nStrong = picked.filter((h) => ranked.indexOf(h) < 2 || h.v > 0.9).length;
    if (effects.length) add({ id: 'actionhits', icon: '👊', group: 'Impact', title: 'Impact shots', desc: `${plural(picked.length, 'hit')} in the footage hit back where they land: smash zoom and shockwave from the contact point and a shake${nStrong ? `; the ${nStrong === 1 ? 'hardest gets' : `${nStrong} hardest get`} a hit-stop freeze and flash` : ''}${sounds.length ? ', and the hardest a heavy punch sound' : ''}`, effects, sfx: sounds, at: Math.max(0, effects[0].start - 1) });
  }
  {
    // FX boost: the footage's own effects (energy, fire, lightning, sparks) get more vibrant and
    // glow, and flare up on the drop, every landed hit and every other beat of the burst
    // (gentle: the glow stays, flaring only on the drop)
    const pts = [...drops.map((t) => ({ t, k: S.gentle ? 0.6 : 1 })), ...(S.gentle ? [] : hitTimes.map((t) => ({ t, k: 0.75 }))), ...(S.gentle ? [] : burst.filter((_, i) => i % 2 === 0).map((c) => ({ t: c.start, k: 0.5 })))].sort((a, b) => a.t - b.t);
    const effects = pts.filter((b, i) => !i || b.t - pts[i - 1].t > 0.25).map((b) => fx('energy', b.t - 0.02, 0.5, { intensity: b.k }));
    const soft = S.kit === 'soft' || S.gentle;
    add({ id: 'fxboost', icon: '🔥', group: 'Look', title: 'FX boost', desc: `More vibrant colour, and the anime's own energy, fire and sparks glow${effects.length ? `, flaring up on ${plural(effects.length, 'hit')}` : ''}`, look: { vibrance: soft ? 0.12 : 0.22, fxGlow: soft ? 0.3 : 0.55 }, effects, at: 0 });
  }
  {
    const picks = beats.filter((b) => b.lvl === 'high' && b.down && !nearDrop(b.t, 0.3) && !inBurst(b.t));
    if (picks.length) {
      const effects = picks.map((b) => fx('zoom', b.t, Math.min(0.35, bd * 0.8), { intensity: 0.2 }));
      add({ id: 'beatzoom', icon: '⊕', group: 'Impact', title: 'Zoom pulses', desc: `Subtle zoom punch on ${plural(picks.length, 'downbeat')} in the high-energy parts`, effects, at: picks[0].t });
    }
  }

  if (A) {
    const byBar = new Map();
    for (const h of G.hits) {
      const t = tl(h.t);
      if (t < 0.2 || t >= L - 0.3 || h.s < 0.6 || nearDrop(t, 0.5) || inBurst(t)) continue;
      const lvl = levelAt(G.sections, h.t);
      if (lvl === 'low') continue;
      const k = Math.floor(t / (lvl === 'high' ? bar : bar * 2));
      if (!byBar.has(k) || byBar.get(k).s < h.s) byBar.set(k, { t, s: h.s, lvl });
    }
    const hits = [...byBar.values()].sort((a, b) => a.t - b.t);
    if (hits.length) {
      const styles = ['chaos', 'horizontal', 'chaos', 'vertical'];
      add({ id: 'shakes', icon: '≋', group: 'Impact', title: 'Shake on hits', desc: `Camera shake on the hardest hit of ${plural(hits.length, 'bar')}`, effects: hits.map((h, i) => fx('shake', h.t, 0.25, { intensity: 0.22 + h.s * 0.1, style: styles[i % 4] })), at: hits[0].t });
      add({ id: 'twitch', icon: 'ϟ', group: 'Impact', title: 'Twitch on hits', desc: `Jittery jumps + RGB on the hardest hit of ${plural(hits.length, 'bar')}`, effects: hits.map((h) => fx('twitch', h.t, 0.15, { intensity: 0.25 + h.s * 0.12 })), at: hits[0].t });
      const g = hits.filter((h) => h.lvl === 'high').sort((a, b) => b.s - a.s).slice(0, 3).sort((a, b) => a.t - b.t);
      if (g.length) add({ id: 'glitch', icon: '▤', group: 'Impact', title: 'Glitch accents', desc: `Digital glitch on the ${plural(g.length, 'hardest accent')}`, effects: g.map((h) => fx('glitch', h.t, 0.18, { intensity: 0.5 })), at: g[0].t });
    }
  }

  {
    // impact frames: 3-frame high-contrast hits on drops and the very hardest accents
    const strong = (A ? G.hits : []).map((h) => ({ t: tl(h.t), s: h.s })).filter((h) => h.t > 0 && h.t < L && h.s > 0.85 && !nearDrop(h.t, 0.5)).sort((a, b) => b.s - a.s).slice(0, 2);
    const ts = [...drops, ...strong.map((h) => h.t)].sort((a, b) => a - b);
    if (ts.length) add({ id: 'impact', icon: '◼', group: 'Impact', title: 'Impact frames', desc: `${S.impactMode === 'red' ? 'Red/black' : 'Black & white'} manga impact frames on ${plural(ts.length, 'hit')}`, effects: ts.map((t) => fx('impact', t, 0.125, { intensity: 1, mode: S.impactMode || 'mono' })), at: Math.max(0, ts[0] - 0.8) });
  }

  if (plan.ctx.drop != null) {
    const d = plan.ctx.drop;
    const fc = clips.find((c) => Math.abs(c.start + c.dur - d) < 0.08 && c.dur >= 0.3 && !c.voice);
    if (fc) {
      const fs = fc.start + fc.dur * 0.5;
      add({ id: 'freeze', icon: '❄', group: 'Motion', title: 'Freeze before the drop', desc: `The shot freezes at ${fmtTime(fs)} with a push-in and shake, then the drop hits`, mod: 'freeze', effects: [fx('slowzoom', fs, d - fs, { intensity: 1 }), fx('shake', fs, d - fs, { intensity: 0.15, style: 'rotate' }), fx('pulse', fs, 0.25, { intensity: 0.5 })], at: Math.max(0, fc.start - 0.5) });
    }
  }

  {
    const st = drops.filter((d) => d >= bd * 2);
    if (st.length) {
      add({ id: 'strobe', icon: '✺', group: 'Impact', title: 'Strobe build-up', desc: `Eighth-note strobe on the last beat before ${st.length > 1 ? 'each drop' : 'the drop'}`, effects: st.map((d) => fx('strobe', d - bd, bd - 0.03, { intensity: 0.4, rate: Math.round(2 / bd) })), at: Math.max(0, st[0] - bd * 3) });
    }
  }

  // the cuts the Transitions suggestion takes (no second transition goes on the same cut)
  const transitionCuts = [], transitionKinds = [];
  {
    const every = S.transitionEvery || 0;
    const picks = transitionCuts;
    clips.forEach((c, i) => {
      if (i === 0 || c.isDrop) return;
      // pro: the cut hides inside a transition everywhere but the drop itself (its flash is the
      // punch) and the climax's half-beat strobe; the beat-by-beat hits get a quick whip
      if (S.pro) { if (c.role !== 'flurry' && c.role !== 'climax' && clips[i - 1].role !== 'flurry') picks.push(c.start); return; }
      const sectionChange = clips[i - 1].level !== c.level;
      if (sectionChange || (every && c.level !== 'high' && i % every === 0)) picks.push(c.start);
    });
    if (picks.length) {
      const d = S.pro ? clamp(bd * 0.7, 0.26, 0.42) : clamp(bd * 0.8, 0.3, 0.5);
      // (pro: zoom-throughs and whips in turn, a spin now and then; into a hero shot, a zoom-through)
      // (pro: one family, zoom-throughs and whips; a spin read as a gimmick next to the references)
      // (the director's `transitions` notes: `family` for the build and held cuts, `hits` for the
      // beat-by-beat cuts after the drop: "snap" (a three-frame whip), "smear", "tiles", "blurdip",
      // "bwflash" (two drained white frames), "flashin" (the new shot opening overexposed) or "cut";
      // `light` makes a dip to black fade up into a light hit)
      const tn = (plan.notes && plan.notes.transitions) || {};
      const kinds = Array.isArray(tn.family) && tn.family.length ? tn.family : S.gentle ? ['dissolve'] : S.pro ? (S.kit === 'soft' ? ['zoomblur', 'echo'] : ['zoomblur', 'whip']) : S.transitions || ['zoomblur', 'whip'];
      const heroAt = new Set(clips.filter((c) => c.hero).map((c) => Math.round(c.start * 100)));
      const roleAt = new Map(clips.map((c) => [Math.round(c.start * 100), c.role]));
      let hit = 0;
      const effects = picks.map((t, i) => {
        // a hit after the drop: a three-frame whip, the way the references hide every beat cut
        if (S.pro && roleAt.get(Math.round(t * 100)) === 'burst') {
          const bi = clips.findIndex((c) => Math.abs(c.start - t) < 0.01), hk = (tn.by && bi >= 0 && tn.by[String(bi)]) || tn.hits || (S.gentle ? 'whitedissolve' : 'snap'), side = hit++ % 2 ? 'left' : 'right';
          transitionKinds[i] = ['cut', 'bwflash', 'flashin', 'whitedissolve', 'dissolve', 'dipblack'].includes(hk) ? hk : hk === 'softdissolve' ? 'dissolve' : 'snap';
          if (hk === 'cut') return null;
          if (hk === 'smear') return fx('smear', t - 0.063, 0.14, { intensity: 1, direction: side });
          if (hk === 'tiles') return fx('tiles', t - 0.07, 0.14, { intensity: 1, direction: side });
          if (hk === 'blurdip') return fx('blurdip', t - 0.12, 0.3, { intensity: S.gentle ? 0.65 : 0.9, cut: 0.4 });
          if (hk === 'bwflash') return fx('bwflash', t, 2 / 24 + 0.004, { intensity: 1 });
          if (hk === 'flashin') return fx('pulse', t, 0.3, { intensity: 0.85 });
          if (hk === 'whitedissolve') return fx('whitedissolve', t - 0.16, 0.9, { intensity: 0.75 });
          if (hk === 'dissolve') return fx('dissolve', t, 5 / 24, { intensity: 1 });
          if (hk === 'softdissolve') return fx('dissolve', t, 10 / 24, { intensity: 1 });
          if (hk === 'dipblack') return fx('dipblack', t - 0.23, 0.42, { intensity: 1, cut: 0.55, light: Number(tn.light) || 0 });
          return fx('whip', t - 0.05, 0.1, { intensity: 0.55, travel: 0.12, direction: side });
        }
        // (`by`: a transition chosen for one cut, keyed by the shot it opens, as the report numbers them)
        const ci = clips.findIndex((c) => Math.abs(c.start - t) < 0.01), byK = tn.by && ci >= 0 ? tn.by[String(ci)] : null;
        const k = byK || (S.pro && heroAt.has(Math.round(t * 100)) && !tn.family && !S.gentle ? 'zoomblur' : kinds[i % kinds.length]);
        transitionKinds[i] = k;
        if (k === 'cut') return null;
        if (k === 'blurdip') return fx('blurdip', t - 0.136, 0.34, { intensity: S.gentle ? 0.75 : 1, cut: 0.4 });
        if (k === 'dipblack') return fx('dipblack', t - 0.23, 0.42, { intensity: 1, cut: 0.55, light: Number(tn.light) || 0 });
        if (k === 'tiles') return fx('tiles', t - 0.07, 0.14, { intensity: 1, direction: i % 2 ? 'left' : 'right' });
        if (k === 'smear') return fx('smear', t - 0.063, 0.14, { intensity: 1, direction: i % 2 ? 'left' : 'right' });
        if (k === 'whiteout') return fx('whiteout', t - 0.3, 0.295, { intensity: 1 });
        if (k === 'bwflash') return fx('bwflash', t, 2 / 24 + 0.004, { intensity: 1 });
        if (k === 'flashin') return fx('pulse', t, 0.3, { intensity: 0.85 });
        if (k === 'whitedissolve') return fx('whitedissolve', t - 0.16, 0.9, { intensity: 0.75 });
        if (k === 'echo') return fx('echo', t, S.gentle ? 0.42 : d * 1.2, { intensity: S.gentle ? 0.85 : 0.8 });
        // (short: the outgoing frame holds while it fades, so five frames at most; `softdissolve`, ten,
        // where the shot going out is still, as a cold open hands over to the song)
        if (k === 'dissolve') return fx('dissolve', t, 5 / 24, { intensity: 1 });
        if (k === 'softdissolve') return fx('dissolve', t, 10 / 24, { intensity: 1 });
        if (k === 'defocus') return fx('defocus', t, d, { intensity: 0.8, mode: 'in' });
        if (k === 'whip') return fx('whip', t - d / 2, d, { intensity: 0.8, direction: i % 4 < 2 ? 'left' : 'right' });
        if (k === 'spin') return fx('spin', t - d / 2, d, { intensity: 0.8, direction: i % 2 ? 'ccw' : 'cw' });
        // a zoom through the cut: in over half the beat, carried on into the next shot, then settled
        const zd = d / 2 + 0.9 * (d / 2) + 0.35;
        return fx('zoomblur', t - d / 2, zd, { intensity: 0.8, cut: d / 2 / zd });
      });
      const names = { zoomblur: 'zoom-blur', whip: 'whip-pan', spin: 'spin', echo: 'echo dissolve', defocus: 'blur-in', blurdip: 'blur dip', dipblack: 'dip to black', tiles: 'mirror tiles', smear: 'smear', whiteout: 'white-out', cut: 'hard cut' };
      add({ id: 'transitions', icon: '◎', group: 'Transitions', title: 'Transitions', desc: `${[...new Set(kinds)].map((k) => names[k] || k).join(', ')} on ${plural(picks.length, 'cut')}`, effects: effects.filter(Boolean), at: Math.max(0, picks[0] - 0.8) });
    }
  }

  {
    // keep the camera alive: anime holds each drawing for 2–3 frames, so a locked-off
    // shot freezes then jumps. Every shot that isn't a punch gets a slow push or pull.
    const calm = clips.filter((c) => c.role !== 'burst' && c.role !== 'reveal' && !c.isDrop && c.dur >= 0.7);
    const pulseBeats = beats.filter((b) => b.down && b.lvl !== 'low' && !nearDrop(b.t) && Math.round(b.t / bar) % 2 === 0);
    if (pulseBeats.length) add({ id: 'pulses', icon: '☀', group: 'Impact', title: 'Glow pulses', desc: `Soft exposure + saturation pulse on ${plural(pulseBeats.length, 'downbeat')}`, effects: pulseBeats.map((b) => fx('pulse', b.t, Math.min(0.4, bd * 0.8), { intensity: 0.35 })), at: pulseBeats[0].t });
    if (calm.length) {
      const last = calm[calm.length - 1];
      const effects = calm.map((c, i) => {
        const steady = c.role === 'hold' || c.role === 'outro';
        // build shots trade push-in / pull-out; the last shot pulls back as it ends
        const dir = c === last && c.role === 'outro' ? 'out' : steady ? 'in' : i % 2 ? 'out' : 'in';
        return fx('slowzoom', c.start, c.dur, { intensity: steady ? (S.drift ? 0.75 : 0.65) : 0.45, dir });
      });
      add({ id: 'slowzoom', icon: '⤢', group: 'Motion', title: 'Camera drift', desc: `Slow push or pull on ${plural(calm.length, 'shot')} so held anime frames never freeze`, effects, at: calm[0].start });
    }
  }

  {
    // camera director: each shot gets its own camera, the way the reference edits switch styles.
    // Calm shots are locked off (the text reads, and the next move hits harder); moving shots get
    // a follow cam that keeps the character framed; a shot that starts calm holds still, then the
    // camera eases into tracking where the action (or a hit) kicks in, on the beat; the last shot
    // pushes in on the character's face. A drawing that barely moves still gets a slow drift so it
    // never looks frozen. Where each character is comes from their outlines, once those are ready
    // (a follow shot with nobody to follow goes handheld instead).
    if (S.pro && !plan.uncut) {
      // pro: the camera never stops. Every shot moves on one eased curve (a push, a pull, or a drift
      // across, with a little lean), turning direction from shot to shot; a hero shot pushes in slow
      // and deep with a lean; the reveal pulls back off the hit. The hits after the drop keep their
      // punches, and the flurry its hard cuts. (A lean needs a little zoom to keep the picture's
      // corners in frame: every move with one stays at 1.06× or more.)
      const effects = [];
      let n = 0;
      for (const c of clips) {
        if (c.role === 'flurry' || c.dur < 0.25) continue;
        const side = n % 2 ? -1 : 1;
        let P;
        // (measured on the references: each cut opens on a 6–10% zoom that eases out within half a
        // second or so, then drifts; a hit after the drop settles quicker and smaller)
        // (gentle: the same moves, smaller and slower, so a held moment breathes instead of pushing)
        // (a lock shot pushes in and comes to rest as the letter locks, then drifts: group G)
        // (measured on the references: 8-15 px a frame into the lock, at rest on it: a pull from 1.22x that
        // eases out exactly on the lock frame, levelling a lean, then the slow drift)
        // (aimed at the thing itself, not the character's outline: the thing slides into its gap as the
        // pull settles, and the hold drifts on it without the re-aim jolting the frame)
        // (a word laid on a surface pulls from less: its outer letters stay in frame as it arrives)
        if (c.lock) P = { z0: c.lock.plane ? 1.3 : 1.6, z1: 1.0, r0: (c.lock.plane ? 0.025 : 0.04) * side, r1: 0, slide: (c.lock.plane ? 0.06 : 0.13) * side, lockAge: Math.max(0.1, c.lock.at - c.start), drift: 0.01, ...(c.lock.aim ? { aimAt: c.lock.aim } : { noAim: true }) };
        else if (c.camNote === 'still') P = { z0: 1.0, z1: 1.025, r0: 0, r1: 0, ease: 'inout' };
        else if (S.gentle && !c.hero) {
          const kind = c.role === 'reveal' ? 'pull' : c.role === 'outro' ? 'push' : ['push', 'pull', 'drift'][n % 3];
          P = kind === 'push' ? { z0: 1.03, z1: 1.12, r0: 0, r1: 0.006 * side, ease: 'inout' } : kind === 'pull' ? { z0: 1.13, z1: 1.04, r0: 0.006 * side, r1: 0, ease: 'out' } : { z0: 1.08, z1: 1.1, r0: -0.004 * side, r1: 0.004 * side, px: 0.03 * side, ease: 'inout' };
        } else if (c.hero) P = { z0: 1.08, z1: 1.38, r0: 0, r1: 0.035 * side, ease: 'inout' };
        else if (c.role === 'reveal') P = { z0: 1.32, z1: 1.08, r0: 0.03 * side, r1: 0, ease: 'out' };
        // (`camera: "settle"` in the notes: every hit after the drop lands zoomed in and tipped, rolled
        // the way its whip travels, and settles level, the Blue Lock edits' signature)
        else if ((c.role === 'burst' || c.role === 'climax') && plan.notes && plan.notes.camera === 'settle') P = { z0: 1.42, z1: 1.03, r0: 0.19 * side, r1: 0, settle: Math.min(1.2, Math.max(0.35, c.dur)), ease: 'out' };
        else if (c.role === 'burst' || c.role === 'climax') P = n % 2 ? { z0: 1.03, z1: 1.08, r0: 0, r1: 0.006 * side, ease: 'out' } : { z0: 1.08, z1: 1.03, r0: 0.006 * side, r1: 0, ease: 'out' };
        else {
          const kind = ['push', 'pull', 'drift'][n % 3];
          P = kind === 'push' ? { z0: 1.04, z1: 1.2, r0: 0, r1: 0.015 * side, ease: 'out' }
            : kind === 'pull' ? { z0: 1.22, z1: 1.06, r0: 0.015 * side, r1: 0, ease: 'out' }
            : { z0: 1.16, z1: 1.2, r0: -0.01 * side, r1: 0.01 * side, px: 0.05 * side, ease: 'out' };
        }
        effects.push(fx('camera', c.start, c.dur, { mode: 'glide', intensity: 1, auto: true, ...P }));
        n++;
      }
      // into the main drop: the punch-in ladder on the face, over the hero shot's last beat
      const D = drops.find((d) => d > 1.2);
      if (D != null && S.kit !== 'soft' && !S.gentle) effects.push(fx('camera', D - CUT_LEAD - bd, bd, { mode: 'ladder', intensity: 1, steps: [[bd * 0.5, 1.35], [bd - 1 / 30, 2.1]], auto: true }));
      if (effects.length) add({ id: 'camera', icon: '🎥', group: 'Motion', title: 'Camera director', desc: `Pro camera on ${plural(n, 'shot')}: an eased push, pull or drift with a lean on every shot, hero shots pushing in slow and deep, the reveal pulling back off the hit${D != null ? ', a punch-in ladder into the drop' : ''}`, effects, at: 0 });
    }
    const shots = [];
    for (const c of S.pro && !plan.uncut ? [] : plan.uncut ? (retimed ? retimed.clips : project.clips) : clips) {
      if (c.isDrop || c.role === 'burst') continue;
      const m = getMedia(project, c.mediaId), g = m && m.analysis && m.analysis.grid;
      if (!g) continue;
      const span = clipSpan(c), toTl = (s) => c.start + ((s - c.srcIn) * c.dur) / span;
      const cuts = (m.analysis.scenes || []).map((sc) => sc.start).filter((x) => x > c.srcIn + 0.2 && x < c.srcIn + span - 0.2);
      const bounds = [c.srcIn, ...cuts, c.srcIn + span];
      for (let i = 0; i < bounds.length - 1; i++) {
        const start = toTl(bounds[i]), end = toTl(bounds[i + 1]);
        if (end - start < 0.5 || inBurst(start + 0.05)) continue;
        const prof = (a, b) => {
          const k0 = Math.floor(a * g.rate), k1 = Math.max(k0 + 1, Math.ceil(b * g.rate));
          let s = 0, n = 0;
          for (let k = Math.max(0, k0); k < Math.min(g.motion.length, k1); k++) { s += g.motion[k]; n++; }
          return n ? s / n : 0;
        };
        const s0 = bounds[i], s1 = bounds[i + 1], sm = s0 + (s1 - s0) * 0.4;
        shots.push({ start, dur: end - start, all: prof(s0, s1), head: prof(s0, sm), tail: prof(sm, s1), level: c.level || levelAt(G.sections, win.start + start + 0.01), seam: !!c.seam });
      }
    }
    if (shots.length) {
      const intro = drops.find((d) => d > 1) ?? L * 0.25;
      const onBeat = (t, a, b) => { let best = null; for (const x of beats) if (x.t > a && x.t < b && (!best || Math.abs(x.t - t) < Math.abs(best - t))) best = x.t; return best; };
      const count = { lock: 0, follow: 0, switch: 0, push: 0, drift: 0 };
      let locks = 0;
      const effects = shots.map((sh, i) => {
        const end = sh.start + sh.dur;
        const hit = hitTimes.find((t) => t > sh.start + sh.dur * 0.25 && t < end - 0.3);
        const take = (kind, e) => { count[kind]++; locks = kind === 'lock' ? locks + 1 : 0; return e; };
        // the two shots that meet at the loop point both sit at the plain framing there: the first
        // drifts in from it, the last drifts back out to it
        if (sh.seam && i === 0) return take('drift', fx('slowzoom', sh.start, sh.dur, { intensity: 0.4, dir: 'in' }));
        if (sh.seam && i === shots.length - 1) return take('drift', fx('slowzoom', sh.start, sh.dur, { intensity: 0.4, dir: 'out' }));
        if (i === shots.length - 1 && sh.dur >= 0.8) return take('push', fx('camera', sh.start, sh.dur, { mode: 'push', intensity: light ? 0.5 : 0.8, auto: true }));
        // your own edit already has its camera work: hold still and let it play
        if (light) return take('lock', fx('camera', sh.start, sh.dur, { mode: 'lock', auto: true }));
        // still for a beat, then the camera takes off with the action
        const onset = hit ?? (sh.head < 0.35 && sh.tail > Math.max(0.45, sh.head * 1.6) ? onBeat(sh.start + sh.dur * 0.4, sh.start + 0.3, end - 0.35) : null);
        if (onset != null && S.kit !== 'soft') return take('switch', fx('camera', sh.start, sh.dur, { mode: 'follow', intensity: 0.75, from: Math.round(((onset - sh.start) / sh.dur) * 100) / 100, auto: true }));
        if (sh.all >= 0.45 && S.kit !== 'soft') return take('follow', fx('camera', sh.start, sh.dur, { mode: 'follow', intensity: 0.7, auto: true }));
        if (sh.all < 0.2 || S.kit === 'soft') return take('drift', fx('slowzoom', sh.start, sh.dur, { intensity: 0.55, dir: i % 2 ? 'out' : 'in' }));
        // calm shots lock off, but never three in a row after the intro: the third pushes in gently
        if (locks >= 2 && sh.start > intro) return take('push', fx('camera', sh.start, sh.dur, { mode: 'push', intensity: 0.45, auto: true }));
        return take('lock', fx('camera', sh.start, sh.dur, { mode: 'lock', auto: true }));
      });
      // into the main drop: a punch-in ladder on the face (medium, close-up for the last half
      // beat, one frame on the eyes), each step a hard jump like a cut, then the drop slams in
      const D = drops.find((d) => d > 1.2);
      let ladder = false;
      if (D != null && S.kit !== 'soft' && !light) {
        const end = D - CUT_LEAD, from = end - bd;
        const sh = shots.find((x) => from >= x.start - 0.01 && end <= x.start + x.dur + 0.01);
        if (sh) { effects.push(fx('camera', from, bd, { mode: 'ladder', intensity: 1, steps: [[bd * 0.5, 1.35], [bd - 1 / 30, 2.1]], auto: true })); ladder = true; }
      }
      const parts = [count.lock && `locked off on ${plural(count.lock, 'calm shot')}`, count.follow && `follows the character on ${count.follow}`, count.switch && `holds still then tracks the action on ${count.switch}`, count.push && `pushes in on ${count.push}`, count.drift && `slow drift on ${count.drift} near-still ${count.drift === 1 ? 'drawing' : 'drawings'}`].filter(Boolean);
      if (ladder) parts.push('a punch-in ladder on the face into the drop');
      add({ id: 'camera', icon: '🎥', group: 'Motion', title: 'Camera director', desc: `A camera style per shot, like the reference edits: ${parts.join(', ')}`, effects, at: shots[0].start });
    }
  }

  // edits to the song itself (all three reference edits do this instead of piling on sound
  // effects): the bass drops out for the bar before the main drop and the song goes silent for
  // a split second before it slams back; a later drop gets a muffle that opens on it
  {
    // (pro: the arc's own drop, which may not be the first one in the window)
    const rv = S.pro ? clips.find((c) => c.role === 'reveal') : null, main = rv ? rv.start : drops.find((d) => d > bd * 4);
    const effects = [];
    if (main != null) {
      if (S.kit === 'soft' || S.gentle) effects.push(fx('muffle', main - bd * 2.4, bd * 2.4, { intensity: S.gentle ? 0.7 : 0.9 }));
      // (gentle: the verses before it a couple of dB lower so the drop opens up, and the muffle above
      // opening on it. No breath of hard silence: in a soft song 0.45 s of nothing read as the music
      // dropping out (Frieren v3 and v4, straight after her line; Lucy before her reveal))
      if (S.gentle) {
        const v0 = Math.max(0, Number(plan.notes && plan.notes.lead) || 0);
        if (main - bd * 2.4 - v0 > 2) effects.push(fx('songcut', v0, main - bd * 2.4 - v0, { intensity: 0.22, fade: 0.6 }));
      }
      else effects.push(fx('bassout', main - bd * 4, bd * 4 - 0.08, { intensity: 1 }), fx('mute', main - 0.08, 0.08, { intensity: 1 }));
    }
    for (const d of drops.filter((d) => main != null && d > main + bar * 2)) effects.push(fx('muffle', d - bd * 2, bd * 2, { intensity: 0.85 }));
    // a voice line with `under: "bass"`: the song keeps playing under it with its bass pulled out
    // (instead of ducking), and slams back as the line ends, the XP2 edits' mix
    for (const c of clips) if (c.voiceAudio && c.voiceAudio.under === 'bass') effects.push(fx('bassout', c.start + c.voiceAudio.off - 0.05, c.voiceAudio.dur + 0.12, { intensity: 1 }));
    // (`under: "cut"`: the song stops for the line and comes back after it, the dialogue break the
    // romance and Dandadan edits put before their drops)
    for (const c of clips) if (c.voiceAudio && c.voiceAudio.under === 'cut') effects.push(fx('songcut', c.start + c.voiceAudio.off - 0.06, c.voiceAudio.dur + 0.3, { intensity: 1 }));
    if (effects.length) add({ id: 'songedits', icon: '◖', group: 'Sound', title: 'Song edits into the drop', desc: S.kit === 'soft' ? 'The song muffles for two beats and opens up on the drop' : 'Bass pulled out for the bar before the drop, a split second of silence, then it slams back' + (effects.some((e) => e.type === 'muffle') ? '; later drops muffle in' : ''), effects, at: Math.max(0, (main ?? 0) - bd * 5) });
    if (effects.length && S.kit !== 'soft') out[out.length - 1].recommended = true;
  }

  // preview windows (the phonk edits' break-beat move): for the beat before a big cut the next
  // shot already shows through shapes, frosted white and clearing, then it cuts in fully. Used
  // on cuts into a high-energy section and on later drops (the main drop has the punch-in ladder)
  {
    const active = plan.uncut ? (retimed ? retimed.clips : project.clips) : clips;
    const lv = (c) => c.level || levelAt(G.sections, win.start + c.start + 0.05);
    const main = drops.find((d) => d > 1.2);
    const picks = [];
    active.forEach((c, i) => {
      if (i === 0 || c.seam || picks.length >= 2) return;
      const prevC = active[i - 1], at = c.start + CUT_LEAD;
      if (prevC.dur < bd * 1.2 || (main != null && Math.abs(at - main) < 0.15)) return;
      if (nearDrop(at, 0.12) || (lv(prevC) !== 'high' && lv(c) === 'high')) picks.push(c.start);
    });
    // eye glint: when the drop lands on a face close-up, a star of light catches the eyes just
    // after the hit (once the drop's flash has faded: a white star doesn't show in a white frame),
    // tracked from face detection; once more on the closing close-up in a soft edit. Each stays
    // inside its own shot (past the cut it would land on whatever face comes next).
    {
      const glints = [];
      const faceShot = (c) => { const m = project.media.find((x) => x.id === c.mediaId), g = m && m.analysis && m.analysis.grid; return g ? gridMean(g, 'pf', c.srcIn, c.srcIn + clipSpan(c)) : 0; };
      const dropShot = drops.length ? active.find((c) => Math.abs(c.start + CUT_LEAD - drops[0]) < 0.12 || (c.start <= drops[0] && c.start + c.dur > drops[0] + 0.3)) : null;
      const glintIn = (c, t) => { const d = Math.min(0.6, c.start + c.dur - 0.02 - t); if (d >= 0.3) glints.push({ t, d }); };
      if (dropShot && faceShot(dropShot) >= 0.08) glintIn(dropShot, Math.max(dropShot.start, drops[0]) + 0.3);
      if (S.kit === 'soft') { const last = [...active].reverse().find((c) => c.role === 'outro' && faceShot(c) >= 0.1 && c.dur >= 0.9); if (last) glintIn(last, last.start + Math.min(0.5, last.dur * 0.3)); }
      if (glints.length) {
        add({ id: 'glint', icon: '✧', group: 'Impact', title: 'Eye glint', desc: `A star of light catches the eyes on ${plural(glints.length, 'face close-up')} (follows the face)`, effects: glints.map((g) => fx('glint', g.t, g.d, { intensity: 0.85 })), at: Math.max(0, glints[0].t - 1) });
        out[out.length - 1].recommended = !S.gentle;
      }
    }
    // foreground wipe: where a shot of a character (a face or figure filling a fair part of the
    // frame) leads into the next on a calm or building cut, the next shot sweeps in behind them
    // and their silhouette carries the cut (once in an edit; twice in a soft one)
    {
      const wipes = [], used = new Set([...picks, ...transitionCuts].map((t) => Math.round(t * 10)));
      active.forEach((c, i) => {
        if (i === 0 || c.seam || c.isDrop || wipes.length >= (S.kit === 'soft' ? 2 : 1)) return;
        const prevC = active[i - 1], m = project.media.find((x) => x.id === prevC.mediaId), g = m && m.analysis && m.analysis.grid;
        if (!g || prevC.dur < 0.8 || prevC.role === 'burst' || prevC.isDrop || used.has(Math.round(c.start * 10))) return;
        if (nearDrop(c.start + CUT_LEAD, bd * 1.5)) return;
        // a figure the wipe can travel behind: there, but not filling the frame (an extreme close-up
        // leaves no background to swap), and wipes spaced out so the move stays special
        const s1 = prevC.srcIn + clipSpan(prevC), skin = gridMean(g, 'pf', s1 - 0.4, s1), mot = gridMean(g, 'pm', s1 - 0.4, s1);
        if (skin < 0.03 || skin > 0.22 || mot > 0.7) return;
        if (wipes.some((w) => Math.abs(w.t - c.start) < 4)) return;
        wipes.push({ t: c.start, dir: (clipFocal(project, prevC)[1] ?? 0.5) > 0.5 ? 'left' : 'right' });
      });
      if (wipes.length) {
        add({ id: 'fgwipe', icon: '◧', group: 'Transitions', title: 'Foreground wipe', desc: `On ${plural(wipes.length, 'cut')} the next shot sweeps in behind the character, whose silhouette carries the cut`, effects: wipes.map((w) => fx('fgwipe', w.t - 0.3, 0.3, { direction: w.dir, intensity: 1 })), at: Math.max(0, wipes[0].t - 1) });
        out[out.length - 1].recommended = true;
      }
    }
    if (picks.length) {
      add({ id: 'preview', icon: '▦', group: 'Transitions', title: 'Preview windows', desc: `On the beat before ${plural(picks.length, 'big cut')} the next shot shows through frosted windows (boxes, a circle on the face, or slats), then cuts in`, effects: picks.map((t, i) => fx('preview', t - bd, bd, { shape: ['rects', 'circle', 'slats'][i % 3], intensity: 1 })), at: Math.max(0, picks[0] - bd - 1) });
      if (S.kit !== 'soft' && !S.gentle) out[out.length - 1].recommended = true;
    }
  }

  // bass blackouts (the phonk edits' breakdown move): in the bars leading into a drop, wherever
  // the song's bass drops out for a moment, the picture flicks to indigo and then black until
  // the bass hits again
  {
    const mm = project.music && getMedia(project, project.music.mediaId), buf = mm && mm.audio && mm.audio.buffer;
    const effects = [];
    if (buf && S.kit !== 'soft') {
      // only where the edit has had a couple of bars to build (black flicks before anything has
      // started read as a glitch)
      for (const d of drops.filter((x) => x >= bar * 2 + 0.5)) {
        for (const [a, b] of bassGaps(buf, win.start + Math.max(0, d - bar * 2), win.start + d - 0.05)) {
          const s0 = a - win.start;
          if (effects.length < 6 && s0 > 0.3) effects.push(fx('blackout', s0 - 2 / 30, b - a + 2 / 30, { intensity: 1 }));
        }
      }
    }
    if (effects.length) {
      add({ id: 'blackouts', icon: '■', group: 'Impact', title: 'Bass blackouts', desc: `${plural(effects.length, 'blackout')} where the bass drops out before the drop: two indigo frames, then black until it hits again`, effects, at: Math.max(0, effects[0].start - 1) });
      out[out.length - 1].recommended = !S.gentle;
    }
  }

  // song break (a fake-out from the long mix edits): on a big hit around two thirds of the way
  // through, the song cuts out for two beats while a deep rumble carries the gap, then it comes
  // straight back on the beat. Offered, not switched on: it's a storytelling choice.
  {
    const main = drops.find((d) => d > 1.2);
    const h = hitPts.filter((x) => x.t > L * 0.5 && x.t < L * 0.75 && (main == null || Math.abs(x.t - main) > bar)).sort((a, b) => b.v - a.v)[0];
    const rumble = h && pickSound('boom', 0, (x) => x.dur >= bd * 2 && x.dur <= 6);
    if (h) {
      const b0 = beats.find((x) => x.t >= h.t - 0.05);
      const s0 = b0 ? b0.t : h.t, dur = bd * 2;
      add({ id: 'songbreak', icon: '⊘', group: 'Sound', title: 'Song break on a big hit', desc: `The song cuts out for two beats at ${fmtTime(s0)}${rumble ? ' while a deep rumble carries the gap' : ''}, then slams back on the beat`, effects: [fx('songcut', s0, dur, { intensity: 1 }), fx('flash', s0 - 0.02, 0.25, { intensity: 0.5 })], sfx: rumble ? [{ sound: rumble.id, start: Math.max(0, s0 - (rumble.attack || 0)), vol: 0.7 }] : [], at: Math.max(0, s0 - 1) });
    }
  }

  // VFX overlays from the library, each picked for its moment: an anime hit spark on every landed
  // hit (its brightest frame on the contact frame, in the hit's colour for the hardest ones), an
  // energy or lightning layer behind the characters on the main drop, a film burn across section
  // changes, and a soft light leak over the calm opening
  {
    const effects = [], used = [];
    const hueOf = (hex) => { const n = parseInt(hex.slice(1), 16), r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255, mx = Math.max(r, g, b), mn = Math.min(r, g, b); if (mx === mn) return null; const d = mx - mn; const h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; return (h * 60 + 360) % 360; };
    // hand-drawn sprites read as part of the anime; glowing orbs read as pasted-on light
    const near = (want) => (a) => (want == null || a.hue == null ? 0 : -Math.min(Math.abs(a.hue - want), 360 - Math.abs(a.hue - want))) - used.filter((u) => u === a.id).length * 90 + (a.glow === false || /^sinestesia\//.test(a.id) ? 60 : 0);
    // the shots as cut, so an overlay never outlives its shot: it fades out just before the cut
    const shotsNow = plan.uncut ? (retimed ? retimed.clips : project.clips) : clips;
    const shotEnd = (t) => { const c = shotsNow.find((x) => t >= x.start - 1e-3 && t < x.start + x.dur); return c ? c.start + c.dur : L; };
    const place = (a, t, extra) => {
      used.push(a.id);
      const sp = extra.speed || 1, start = t - (a.peak || 0) / (a.fps || 12) / sp, natural = a.still ? 0.5 : a.frames / (a.fps || 12) / sp;
      const dur = Math.max(0.1, Math.min(natural, shotEnd(t) - 0.01 - start));
      return fx('vfx', start, dur, { asset: a.id, ...extra, fade: dur < natural ? 0.06 : extra.fade ?? 0.03 });
    };
    // Hit sparks aren't placed automatically: where a blow visibly lands can't be found reliably
    // from motion (a swing that hits nothing on screen still surges), and a still sprite can't
    // follow a moving fist or hammer, so an automatic spark too often sits somewhere that makes
    // no sense. They're in the VFX library to place by hand; hits keep the push, hit-stop and flash.
    const AUTO_HIT_SPARKS = false;
    const topHits = [...hitPts].sort((a, b) => b.v - a.v).slice(0, 2);
    (light || !AUTO_HIT_SPARKS ? [] : hitPts.filter((h) => topHits.includes(h))).forEach((h, i) => {
      const want = h.color ? hueOf(h.color) : null;
      // a quick clean spark on the contact: no blood sprays, smoke, explosions or fire over a punch
      const ok = (x) => !x.still && x.place === 'point' && !(x.tags || []).some((t) => ['blood', 'smoke', 'explosion', 'fire', 'fireball'].includes(t));
      const a = pickVfx(h.strong ? 'hit' : 'spark', i, ok, near(want)) || pickVfx('hit', i, ok, near(want));
      // played quick (a crisp flash of a spark, not a lingering cloud), checked against the
      // characters once their outlines are ready (hit: true; see refineOverlays)
      if (a) effects.push(place(a, h.t, { x: h.x, y: h.y, size: h.strong ? 0.48 : 0.4, intensity: h.strong ? 0.8 : 0.7, speed: 1.5, rot: (i * 47) % 60 - 30, flip: i % 2 === 1, tint: h.color || '#ffffff', tintAmt: a.hue == null && h.strong ? 0.55 : 0, fade: 0, hit: true }));
    });
    const main = drops.find((d) => d > 1);
    if (main != null && S.kit !== 'soft') {
      // in the drop shot's own colour
      const sh = (plan.uncut ? (retimed ? retimed.clips : project.clips) : clips).find((c) => main + 0.05 >= c.start && main + 0.05 < c.start + c.dur);
      const g = sh && getMedia(project, sh.mediaId)?.analysis?.grid;
      let want = null, bright = 0;
      if (g && g.hx) {
        const k = Math.max(0, Math.min(g.hx.length - 1, Math.round((sh.srcIn + (main + 0.05 - sh.start)) * g.rate)));
        want = ((Math.atan2(g.hy[k], g.hx[k]) * 180) / Math.PI + 360) % 360;
        // the shot's brightness over the overlay's first half second
        if (g.lum) { let s = 0, n = 0; for (let q = k; q < Math.min(g.lum.length, k + Math.ceil(g.rate * 0.5)); q++) { s += g.lum[q]; n++; } bright = n ? s / n : 0; }
      }
      const full = (x) => x.place === 'full';
      // a screen-blended overlay vanishes into a bright shot (a sunlit face filling the frame) and
      // only lifts its blacks there; the drop's flash and push carry it instead
      const a = bright < 0.55 && (pickVfx('lightning', 0, full, near(want)) || pickVfx('energy', 0, full, near(want)) || pickVfx('spark', 0, full, near(want)) || pickVfx('particles', 0, full, near(want)));
      if (a) { const d = Math.min(1.1, a.loop ? 1 : a.frames / (a.fps || 12), shotEnd(main + 0.05) - 0.01 - main); if (d > 0.25) effects.push(fx('vfx', main, d, { asset: a.id, size: 0.7, intensity: 0.75, behind: 'behind', fade: 0.1 })); }
    }
    let tr = 0;
    // section changes in the cut that's actually used (your own shots, re-timed, when it's kept)
    const active = plan.uncut ? (retimed ? retimed.clips : project.clips) : clips;
    const lv = (c) => c.level || levelAt(G.sections, win.start + c.start + 0.05);
    active.forEach((c, i) => {
      if (light || i === 0 || c.isDrop || lv(active[i - 1]) === lv(c) || nearDrop(c.start, 0.5)) return;
      // soft styles drift a light leak across; action styles trade a film burn, a light leak and a glitch burst
      const kind = S.kit === 'soft' ? 'lightleak' : ['filmburn', 'lightleak', 'glitch'][tr % 3];
      const a = pickVfx(kind, tr++, (x) => x.place === 'full') || pickVfx('lightleak', tr, (x) => x.place === 'full');
      if (a) { const d = Math.min(0.6, a.loop ? 0.55 : a.frames / (a.fps || 12)); effects.push(fx('vfx', c.start - d / 2, d, { asset: a.id, size: 0.7, intensity: S.kit === 'soft' ? 0.4 : 0.55, fade: d * 0.4 })); }
    });
    // soft styles open with a faint light leak that drifts through and is gone in about a
    // second (a long one over the whole opening reads as a yellow filter)
    const leak = S.kit === 'soft' && pickVfx('lightleak', 3, (x) => x.place === 'full');
    if (leak) effects.push(fx('vfx', 0.1, 1.2, { asset: leak.id, size: 0.8, intensity: 0.22, fade: 0.45, speed: 0.7 }));
    if (effects.length) add({ id: 'vfx', icon: '✨', group: 'Impact', title: 'VFX overlays', desc: `${plural(effects.length, 'overlay')} from your VFX library, each picked for its moment: sparks or energy behind the characters on the drop, film burns across section changes${S.kit === 'soft' ? ', a soft light leak on the opening' : ''}`, effects, at: effects[0].start });
    if (effects.length) out[out.length - 1].recommended = true;
  }

  // countdown bookend (from the long mix edits): an LED timer opens the edit, white and held with
  // a beep, turns red and races down on the first downbeat with a boom; at the end the last
  // seconds tick off on a red card. Offered, not switched on: the end card replaces the seamless loop.
  {
    const first = beats.find((b) => b.down && b.t > 0.5);
    if (first && L > 8) {
      const beep = pickSound('click', 0) || pickSound('pop', 0), boom = pickSound('boom', 1, (x) => x.dur <= 4);
      const intro = Math.min(first.t + bd * 2, 2.2), tail = Math.min(1.1, bd * 2.5);
      const sfx = [beep && { sound: beep.id, start: 0.05, vol: 0.45 }, boom && { sound: boom.id, start: Math.max(0, first.t - (boom.attack || 0)), vol: 0.6 }].filter(Boolean);
      add({
        id: 'countdown', icon: '⏲', group: 'Text', title: 'Countdown bookend',
        desc: 'An LED timer opens the edit (white with a beep, then red and racing down on the first downbeat) and the last seconds tick off on a red card at the end. Replaces the seamless loop',
        texts: [
          { text: 'COUNTDOWN', style: 'countdown', start: 0, dur: first.t, from: 300, to: 300, color: '#ffffff', card: 'rgba(0,0,0,0.82)', y: 0.5, size: 0.3 },
          { text: 'COUNTDOWN', style: 'countdown', start: first.t, dur: intro - first.t, from: 300, to: 247, color: '#ff2a2a', card: 'rgba(0,0,0,0.55)', y: 0.5, size: 0.3 },
          { text: 'COUNTDOWN', style: 'countdown', start: L - tail, dur: tail, from: 13, to: 0, color: '#0a0a0a', card: '#e8141c', y: 0.5, size: 0.3 },
        ],
        sfx, at: 0,
      });
    }
  }

  // seamless loop: on autoplay the end flows straight back into the start. A zoom-blur transition
  // straddles the loop point (the last beat blurs into the video's own first frame; the first beat
  // comes out of that blur), the song doesn't fade, and nothing fades to black
  // (the director's `outro`: "whitefade" ends on a white frame fading to black over 16 frames with
  // the song fading under it, "fade" fades picture and song to black over a beat and a half, "cut"
  // stops dead on the last hit; otherwise the seamless loop)
  const outro = plan.notes && plan.notes.outro;
  if (outro === 'whitefade' || outro === 'fade') {
    // (black and silent for the last few frames, so the end is a clean black, not a dim picture)
    // (`outroLen` in the notes: the fall's own length, a short one so the last word and face play out first)
    const ol = Number(plan.notes && plan.notes.outroLen), fd = ol > 0.1 ? Math.min(2, ol) : outro === 'whitefade' ? 0.7 : clamp(bd * 1.5, 0.6, 1.2), tail = 0.15;
    const effects = [fx('fadeout', L - fd - tail, fd + tail + 0.2, { intensity: 1, len: fd }), fx('songcut', L - fd - tail - 0.05, fd + tail + 0.25, { intensity: 1, ramp: true, len: fd + 0.05 })];
    // (two frames of true white, then it decays as the fall to black runs on its 16-17 frames)
    if (outro === 'whitefade') effects.unshift(fx('flash', L - fd - tail - 0.02, 8 / 24, { intensity: 0.96, hold: 0.25 }));
    add({ id: 'outro', icon: '◣', group: 'Structure', title: outro === 'whitefade' ? 'White-flash fade out' : 'Fade out', desc: outro === 'whitefade' ? 'The last hit flashes white and the picture falls to black over 16 frames, the song fading under it' : 'Picture and song fade to black together over the last beat and a half', effects, at: Math.max(0, L - 2) });
    out[out.length - 1].recommended = true;
  } else if (outro === 'card') {
    // (`outro: "card"`: the last `outroLen` seconds (1.4) are the sign-off card, the project watermark
    // in the middle of black, its last o and halo dropping in on the final beat; the song plays out)
    const ol = clamp(Number(plan.notes && plan.notes.outroLen) || 1.4, 0.8, 3), wm = project.watermark && project.watermark.src;
    if (wm) add({ id: 'endcard', icon: '◉', group: 'Structure', title: 'Sign-off card', desc: 'The project watermark fades up on black, with its right edge landing on the final beat', texts: [{ id: uid(), style: 'endcard', text: 'Watermark', mark: wm, split: 0.862, width: 0.42, start: L - ol, dur: ol + 0.05, lockLt: clamp(bd * 0.85, 0.45, 0.9), x: 0.5, y: 0.5, size: 0.1, anim: 'none' }], at: Math.max(0, L - ol - 0.5) });
  } else if (outro !== 'cut') {
    add({ id: 'loop', icon: '∞', group: 'Structure', title: 'Seamless loop', desc: 'The end zoom-blurs into the first frame and the start comes out of it, so autoplay replays without a visible restart; no fades', loop: { dur: clamp(bd, 0.3, 0.55) }, at: Math.max(0, L - 1.5) });
    out[out.length - 1].recommended = true;
  }

  const firstDrop = drops.find((d) => d > 1.5);
  if (firstDrop != null) {
    add({ id: 'letterbox', icon: '▭', group: 'Look', title: 'Cinema bars intro', desc: `Cinematic bars until ${fmtTime(firstDrop)}, then they snap away on the drop`, effects: [fx('letterbox', 0, firstDrop, { intensity: 1 })], at: 0 });
    add({ id: 'bw', icon: '◧', group: 'Look', title: 'B&W until the drop', desc: `Black & white intro — color slams in at ${fmtTime(firstDrop)}`, effects: [fx('bw', 0, firstDrop, { intensity: 1 })], at: 0 });
  } else if (S.kit === 'soft') {
    add({ id: 'letterbox', icon: '▭', group: 'Look', title: 'Cinema bars', desc: 'Cinematic bars for the whole edit', effects: [fx('letterbox', 0, L, { intensity: 0.8 })], at: 0 });
  }

  {
    if (S.matchLook) {
      add({ id: 'grade', icon: '🎨', group: 'Look', title: 'Color: matched to reference', desc: 'Brightness, contrast, saturation, shadow/highlight tint and dominant color measured from your reference edit', look: S.matchLook, at: 0 });
    } else {
      let look = S.look;
      if (picked(plan) === 'hype' && A && A.features.bassiness > 0.56 && A.features.brightness < 1600) look = 'crimson';
      // pro: one bold palette for the whole edit, from the colour the footage itself leans to (or
      // the director's "palette" note)
      if (S.pro) look = (plan.notes && LOOKS[plan.notes.palette] && plan.notes.palette) || paletteFor(project, clips) || look;
      const pre = LOOKS[look];
      // (pro: pushed close to one colour, as the references are; a look without a duotone of its
      // own takes one from its colour)
      // and darker, as the references' hype edits sit (median brightness 70–100 of 255, deep blacks),
      // with the opposite hue kept as the accent that glows against it
      // (`push` in the notes, 0..1, sets how hard: 0.55 by default; an emotional edit whose flowers and
      // skies should keep their own colours takes less, and the darkening scales with it)
      const pk = plan.notes && Number.isFinite(Number(plan.notes.push)) ? Math.max(0, Math.min(1, Number(plan.notes.push))) : 0.55, pf = pk / 0.55;
      // (the darkening is for footage that starts bright: it takes footage of average brightness 0.42
      // or more down to where the references sit (0.27-0.39 for the hype ones), and eases off to none
      // at 0.26, footage already there, so a dark anime isn't crushed to black (Solo Leveling's
      // dungeons came out at 0.16, under all 27 references); the contrast push eases off with it)
      let ls = 0, ld = 0;
      for (const c of clips) {
        const m = getMedia(project, c.mediaId), g = m && m.analysis && m.analysis.grid;
        if (g && g.pl) { ls += gridMean(g, 'pl', c.srcIn, c.srcIn + clipSpan(c)) * c.dur; ld += c.dur; }
      }
      const dk = ld ? clamp((ls / ld - 0.26) / 0.16, 0, 1) : 1;
      const push = S.pro && look !== 'none' && look !== 'mono' && pk > 0 ? { duo: pre.duo || [1, 3, 5].map((i) => parseInt(pre.sw[1].slice(i, i + 2), 16) / 255), duoAmt: Math.max(pre.duoAmt || 0, pk),
        accent: 0.65, exposure: (pre.exposure || 0) - 0.48 * Math.min(1, pf) * dk, contrast: Math.max(pre.contrast || 1, 1 + 0.22 * Math.min(1, pf) * (0.4 + 0.6 * dk)), shadows: (pre.shadows || [0, 0, 0]).map((v) => v - 0.012 * Math.min(1, pf) * dk),
        // (gentle: darker through the mids with the white point kept, and skin, blush and pinks
        // keeping their own colour: a grey veil over an emotional scene reads as milky, not graded)
        softGrade: S.gentle ? 1 : 0 } : null;
      add({ id: 'grade', icon: '🎨', group: 'Look', title: `Color: ${pre.label}`, desc: `${pre.label} grade picked for the ${STYLES[plan.styleKey].label.toLowerCase()} style` + (push ? ', pushed close to one colour' : ''), lookPreset: look, ...(push ? { look: push } : {}), at: 0 });
    }
    const f = S.finish;
    const extras = [f.sharpen && 'anime sharpen', f.grain && 'film grain', f.vhs && 'VHS lines', f.leaks && 'light leaks'].filter(Boolean);
    // the cinematic finish of the sharpest reference edits: deep blacks and low midtones, local
    // contrast that makes the line art pop, rich colour below the highlights
    const soft = S.kit === 'soft';
    add({ id: 'finish', icon: '✧', group: 'Look', title: 'Cinematic finish', desc: `Deep blacks, clarity and rich colour like the sharpest reference edits, shots leveled so no cut jumps in brightness, anime sharpen, a touch of bloom on highlights, ${f.vignette > 0.4 ? 'heavy' : 'soft'} vignette${extras.length ? ', ' + extras.join(', ') : ''}`, look: { glowThreshold: 0.68, sharpen: 0, grain: 0, vhs: 0, leaks: 0, depth: soft ? 0.25 : 0.45, clarity: soft ? 0.25 : 0.4, rich: soft ? 0.2 : 0.35, level: 1, ...f,
      // (a lock-word edit: no light leaks or vignette tinting the letterbox, each shot's own colours kept)
      ...(lockEdit ? { leaks: 0, vignette: Math.min(f.vignette || 0, 0.12), rich: 0.2 } : {}),
      // (gentle: soft, as a slow edit is; its close-ups held for seconds show every sharpening halo)
      // (and the line art left as drawn: no sharpening, light local contrast)
      ...(S.gentle ? { sharpen: 0, clarity: 0.12, grain: Math.max(f.grain || 0, 0.04) } : {}) }, at: 0 });
    add({ id: 'motionblur', icon: '≫', group: 'Motion', title: 'Motion blur', desc: 'Blur only on the fast part of each speed ramp, so normal-speed shots stay sharp', look: { motionBlur: S.motionBlur || 0.4 }, at: 0 });
  }

  {
    const { w, h } = formatSize(project);
    const Ao = w / h;
    const mismatch = clips.some((c) => { const m = getMedia(project, c.mediaId); return m && Math.abs(m.w / m.h - Ao) / Ao > 0.08; });
    if (S.layout) {
      const names = { 'framed-1:1': 'Framed 1:1', 'framed-4:5': 'Framed 4:5', 'framed-16:9': 'Framed 16:9' };
      add({ id: 'matchlayout', icon: '▣', group: 'Layout', title: `${names[S.layout]} like the reference`, desc: 'The reference frames its clips in a window with black bands', layout: S.layout, at: 0 });
    }
    if (mismatch) {
      add({ id: 'reframe', icon: '⛶', group: 'Structure', title: `Smart ${project.format} reframe`, desc: `Crop follows the action in ${plural(clips.length, 'clip')} instead of a fixed center crop`, mod: 'reframe', at: 0 });
      if (Ao < 1) {
        add({ id: 'framed', icon: '▣', group: 'Layout', title: 'Framed 1:1 window', desc: 'Clips sit in a centered square with black bands (the dark / serious edit look)', layout: 'framed-1:1', at: 0 });
        add({ id: 'rotate', icon: '⟳', group: 'Layout', title: 'Rotate 90° to fill', desc: 'Landscape clips turned sideways to fill the whole vertical screen', layout: 'rotate', at: 0 });
        add({ id: 'blurfill', icon: '▥', group: 'Layout', title: 'Blurred background', desc: 'Whole clip visible, with a blurred copy filling the frame behind it', layout: 'blur', at: 0 });
      }
    }
  }

  if (levelAt(G.sections, win.start + 0.1) !== 'high') add({ id: 'fadein', icon: '◢', group: 'Transitions', title: 'Fade in', desc: 'Fade up from black at the start', effects: [fx('fadein', 0, Math.min(0.8, bd * 2))], at: 0 });
  add({ id: 'fadeout', icon: '◣', group: 'Transitions', title: 'Fade out', desc: 'Fade to black over the last beats', effects: [fx('fadeout', Math.max(0, L - Math.min(1.4, bd * 3)), Math.min(1.4, bd * 3))], at: Math.max(0, L - 2) });
  // fades, an intro in bars or in black and white would all break the seamless loop (on by
  // default), so they're offered but not switched on
  for (const s of out) if (['fadein', 'fadeout', 'letterbox', 'bw'].includes(s.id)) s.recommended = false;

  // sound design from your SFX library: whoosh into each drop + an impact on it, whooshes on
  // transitions. No punch sounds on hits: over a song they read as fake and distracting.
  {
    const list = [];
    let wi = 0, ii = 0;
    const whoosh = (t, vol, lead = 0.85) => {
      const s = pickSound('whoosh', wi++, (x) => x.dur >= 0.25 && x.dur <= 1.2);
      if (s) list.push({ sound: s.id, start: Math.max(0, t - s.dur * lead), vol });
    };
    if (S.pro) {
      // pro sound design (what the references layer under the song): a whoosh through every hidden
      // cut, its rush landing on the cut; a riser over the bars into the drop, a sub-boom and a deep
      // impact on it; an impact on the reveal; a reverse swell into each hero shot
      // (a long dark whoosh through each zoom, a quick one on each whip or spin, taking turns, each
      // at its loudest right on its cut)
      // (the quick whips on the hits get a softer one every other beat: a whoosh on every beat over a
      // loud song turns to noise)
      let zi = 0, qi = 0, si = 0;
      // (gentle: only the zoom-throughs carry a soft whoosh; the soft cuts and the hits stay quiet)
      transitionCuts.forEach((t, i) => {
        const k = transitionKinds[i];
        if (k === 'cut' || k === 'dipblack' || k === 'bwflash' || k === 'flashin' || k === 'whitedissolve' || k === 'echo' || k === 'dissolve') return; // (a hard cut, a dip, a flash or a dissolve carries no whoosh)
        if (S.gentle && k !== 'zoomblur') return;
        if (k === 'snap' && si++ % 2) return;
        const s = k === 'zoomblur' ? proSound('zoom', zi++) : proSound('quick', qi++);
        if (s) list.push({ sound: s.id, start: Math.max(0, t - s.peak), vol: S.gentle ? 0.18 : k === 'snap' ? 0.24 : 0.34 });
      });
      const rv0 = clips.find((c) => c.role === 'reveal'), main = rv0 ? rv0.start : drops.find((d) => d > 1.5);
      if (main != null) {
        // a buildup peaking on the drop over the editor's riser (louder when it's alone), the sub-boom
        // and a deep hit on its transient
        // (gentle: a soft riser and a low swell of a boom, no whip build-up or hit)
        // (gentle: none of it; a slowed ballad lands its drop on the music alone)
        const build = S.gentle ? null : proSound('buildup'), riser = S.gentle ? null : sfxById('synth/riser'), boom = S.gentle ? null : sfxById('synth/boom'), hit = S.gentle ? null : proSound('dropHit');
        if (build) list.push({ sound: build.id, start: Math.max(0, main - 0.04 - build.peak), vol: 0.42 });
        if (riser) list.push({ sound: riser.id, start: Math.max(0, main - 0.06 - riser.peak), vol: S.gentle ? 0.16 : build ? 0.18 : 0.34 });
        if (boom) list.push({ sound: boom.id, start: Math.max(0, main - 0.005), vol: S.gentle ? 0.32 : 0.65 });
        if (hit) list.push({ sound: hit.id, start: Math.max(0, main - hit.attack), vol: 0.6 });
      }
      const rev = clips.find((c) => c.role === 'reveal'), hit2 = S.gentle ? null : proSound('hit');
      if (rev && hit2) list.push({ sound: hit2.id, start: Math.max(0, rev.start - hit2.attack), vol: 0.4 });
      const swell = proSound('swell');
      for (const c of clips) if (c.hero && swell && c.start >= swell.peak * 0.6) list.push({ sound: swell.id, start: Math.max(0, c.start - swell.peak), vol: 0.32 });
    }
    for (const d of S.pro ? [] : drops) {
      whoosh(d, 0.55);
      // a deep thump, not a gory or cartoon hit, landing on its transient
      if (S.kit !== 'soft') { const s = pickSound('impact', ii++, (x) => /hard-enhancer/.test(x.id)) || pickSound('impact', ii, (x) => x.dur <= 2.5); if (s) list.push({ sound: s.id, start: Math.max(0, d - (s.attack || 0)), vol: 0.6 }); }
    }
    if (!S.pro) clips.forEach((c, i) => { if (i > 0 && !c.isDrop && clips[i - 1].level !== c.level) whoosh(c.start, 0.4, 0.6); });
    // a riser that peaks right on the main drop
    const main = S.pro ? null : drops.find((d) => d > 2);
    // (one that builds all the way to its end, so it hands straight over to the drop)
    const riser = main != null && ((sfxManifest() || { sounds: [] }).sounds
      .filter((x) => x.tags.includes('riser') && x.dur >= 1.5 && x.dur <= 6 && x.peak <= main && !/horror|scary|creep/i.test(x.name))
      .sort((a, b) => b.peak / b.dur - a.peak / a.dur)[0]);
    // (peaking just before the split second of silence the song edits leave before the drop)
    if (riser) list.push({ sound: riser.id, start: main - 0.1 - riser.peak, vol: 0.32 });
    // (the director's own sounds, `sfx: [{ t, sound, vol, from }]`: ambience under a held shot, a chime;
    // `from` seconds into the file, the end of a long riser)
    // (`sounds: "notes"`: the director places every sound by hand, the planner's own left out)
    if (plan.notes && plan.notes.sounds === 'notes') list.length = 0;
    for (const x of (plan.notes && Array.isArray(plan.notes.sfx) ? plan.notes.sfx : [])) if (x && x.sound && x.t != null) list.push({ sound: String(x.sound), start: Math.max(0, Number(x.t)), vol: Number(x.vol) || 0.25, ...(Number(x.from) > 0 ? { from: Number(x.from) } : {}) });
    if (list.length) add({ id: 'sfx', icon: '🔊', group: 'Impact', title: 'Sound effects', desc: S.pro ? `Pro sound design, ${plural(list.length, 'sound')}: a whoosh through every hidden cut, riser + sub-boom + impact on the drop, an impact on the reveal, a swell into each hero shot` : `${plural(list.length, 'sound')} from the sound library: impacts on drops and whooshes on transitions`, sfx: list.sort((a, b) => a.start - b.start), at: Math.max(0, (drops[0] ?? 1) - 1) });
  }

  // pro: a giant word behind the characters (the references' set dressing: a name or the song's key
  // word filling the frame behind everyone), from the director's `backdrop` notes (`[{ word, shot }]`,
  // or false for none) or else the cover title's last word, on the drop's own shot
  if (S.pro && !plan.uncut) {
    const bn = plan.notes && plan.notes.backdrop, title = plan.notes && plan.notes.cover && plan.notes.cover.title;
    const rev = clips.find((c) => c.role === 'reveal');
    const list = Array.isArray(bn) ? bn : bn === false ? [] : title && rev ? [{ word: String(title).trim().split(/\s+/).pop(), shot: clips.indexOf(rev) }] : [];
    const lk = (plan.notes && LOOKS[plan.notes.palette] && plan.notes.palette) || paletteFor(project, clips) || S.look, sw = (LOOKS[lk] && LOOKS[lk].sw && LOOKS[lk].sw[1]) || '#ffffff';
    const tone = '#' + [1, 3, 5].map((i) => Math.round(parseInt(sw.slice(i, i + 2), 16) * 0.75 + 255 * 0.25).toString(16).padStart(2, '0')).join('');
    // (the vertical copy's frame is filled by the character, so its word can't go behind: it sits in
    // the band above the face instead, over the hair, a little see-through)
    const texts = list.map((b) => {
      // (a shot number, or a role: "reveal" for the drop's own shot)
      const c = typeof b.shot === 'string' && !Number.isFinite(Number(b.shot)) ? clips.find((x) => x.role === b.shot) : clips[Number(b.shot)];
      if (!c || !b.word) return null;
      // (as the XP2 edits set theirs: drawn half again as tall as its face, filled top to bottom
      // from near-white through the palette's tone to its deep shade, a little see-through)
      const deep = '#' + [1, 3, 5].map((i) => Math.round(parseInt(sw.slice(i, i + 2), 16) * 0.32).toString(16).padStart(2, '0')).join('');
      const gradient = b.gradient === false ? null : Array.isArray(b.gradient) ? b.gradient : b.color ? null : ['#f4f1ff', tone, deep];
      // (it ends on its shot's last frame: a frame of it over the next shot reads as a glitch; `at`
      // lands it later in the shot, on a spoken word; `split`
      // parts it around the face, "HIM" left of it and "MEL" right, so no letter hides behind the head;
      // in the vertical copy it sits over the hair, below the apps' top bar)
      const split = b.split ? { gap: Number(b.split.gap ?? b.split) > 0 && Number(b.split.gap ?? b.split) < 1 ? Number(b.split.gap ?? b.split) : 0.36, cx: Number(b.split.cx ?? 0.5) } : null;
      return { ...(b.body ? { body: { letter: Number(b.body.letter), scale: Number(b.body.scale) || 1, behind: !!b.body.behind, keys: (b.body.keys || [[0, b.body.x, b.body.top, b.body.bottom, b.body.gap || 0]]).map((k) => k.map(Number)) }, stretch: Number(b.stretch) || 1.15 } : {}), ...(b.font ? { face: String(b.font) } : {}), ...(b.ink === 'dark' || b.ink === 'light' ? { ink: b.ink } : {}), ...(b.keep ? { keep: true } : {}), ...(b.front ? { front: true } : {}), ...(b.letters && typeof b.letters === 'object' ? { letterStyles: b.letters } : {}), text: String(b.word).toUpperCase(), ...(() => { const a = Number.isFinite(Number(b.at)) ? Math.min(c.start + c.dur - 0.36, Math.max(c.start, Number(b.at))) : c.start; return { start: a, dur: Math.max(0.35, c.start + c.dur - 0.001 - a) }; })(), style: 'giant', tall: { y: Number(b.tallY ?? 0.24), maxH: 0.2, fit: 0.84, behind: false, alpha: 0.92, split: null, ghost: false }, size: 0.3, x: 0.5, y: Number(b.y ?? 0.5), maxH: Number(b.maxH) || 1, fit: Number(b.fit) || 0.97, stretch: Number(b.stretch) || 1.75, gradient, behind: true, backdrop: true, alpha: Number(b.alpha) || 0.9, anim: 'none', color: b.color || tone, split, ghost: !!b.ghost };
    }).filter(Boolean);
    if (texts.length) add({ id: 'backdrop', icon: 'A', group: 'Text', title: 'Word behind the characters', desc: `A giant ${texts.map((t) => `"${t.text}"`).join(', ')} filling the frame behind the characters`, texts, at: Math.max(0, texts[0].start - 0.5) });
  }
  // the lock words (group G): the word in each lock shot, its letters set round the thing on the
  // lock frame and arriving one by one on the half-beats before it, in the shot's own face,
  // colour and material; `carry: 1` brings the letters in on the shot before, held still across the cut
  {
    const lw = plan.notes && Array.isArray(plan.notes.lockwords) ? plan.notes.lockwords : [];
    const hb = bd / 2;
    const texts = lw.map((w) => {
      const c = clips[Number(w && w.shot)];
      const plane = w.plane && Array.isArray(w.plane.keys) && w.plane.keys.length ? { keys: w.plane.keys.map((k) => k.map(Number)) } : null;
      if (!c || !c.lock || (!plane && (!Array.isArray(w.box) || w.box.length < 4))) return null;
      const word = String(w.word || 'LOVE').toUpperCase(), li = plane && w.letter == null ? -1 : clamp(Number(w.letter) || 0, 0, word.length - 1);
      const prev = Number(w.carry) > 0 ? clips[clips.indexOf(c) - 1] : null;
      const start = prev ? prev.start : c.start, lockLt = c.lock.at - start;
      const others = [...word].map((_, i) => i).filter((i) => i !== li);
      // (a dissolve into this shot: the letters start arriving once it has cleared)
      const DIS = { softdissolve: 10 / 24, dissolve: 5 / 24, whitedissolve: 0.6 };
      const byT = (plan.notes && plan.notes.transitions && plan.notes.transitions.by) || {}, ci = clips.indexOf(c);
      // (out of it nothing is needed: a dissolve fades from a held copy of the last frame, its word included)
      const dIn = DIS[byT[String(ci)]] || 0, dOut = 0;
      const first = Math.max(0.12, dIn + 0.06, Number(w.arriveFrom ?? 0.12)), gap = Math.min(hb, Math.max(0.08, (lockLt - first - hb * 0.5) / Math.max(1, others.length)));
      const arriveAt = {};
      // (a word with a thing in it is whole when the thing locks; a whole word laid on a surface lands its
      // last letter on the downbeat itself)
      const land = li < 0 ? lockLt : lockLt - hb * 0.5;
      others.forEach((i, k) => { arriveAt[i] = Math.max(first, land - (others.length - 1 - k) * gap - 0.24); });
      return { id: uid(), style: 'lockword', text: word, letter: li < 0 ? null : li, box: Array.isArray(w.box) ? w.box.map(Number) : [0.5, 0.5, 0.1, 0.1], ...(plane ? { plane, fill: Number(w.fill) || 0.94 } : {}), ...(Array.isArray(w.slot) ? { slot: w.slot.map(Number) } : {}), ...(w.cap != null ? { cap: Number(w.cap) } : {}), ...(w.base != null ? { base: Number(w.base) } : {}),
        // (to the shot's last frame: a dissolve out fades from that frame, the word on it)
        start, dur: c.start + c.dur - 0.002 - start + dOut, ...(dOut ? { fadeOut: dOut } : {}), lockLt, arrive: w.arrive || 'fade', arriveAt, face: w.font || 'Bodoni Moda', italic: !!w.italic, weight: Number(w.weight) || 400,
        color: w.color || '#ffffff', ...(w.glowColor ? { glowColor: String(w.glowColor) } : {}), material: w.material || 'flat', behind: !!w.behind, scale: Number(w.scale) || 1, ...(w.valign ? { valign: String(w.valign) } : {}), space: w.space != null ? Number(w.space) : 0.07, roll: Number(w.roll) || 0,
        alpha: Number(w.alpha) || 1, clipId: prev ? c.id : null, lockShot: clips.indexOf(c), x: 0.5, y: 0.5, size: 0.1, anim: 'none' };
    }).filter(Boolean);
    if (texts.length) add({ id: 'lockwords', icon: 'Ⓛ', group: 'Text', title: 'Letter locks', desc: `${plural(texts.length, 'shot')} with a word whose letter is a thing in the picture, locked on the downbeat`, texts, at: Math.max(0, texts[0].start - 0.5) });
  }


  {
    const name = (project.media.find((m) => m.kind === 'video')?.name || 'edit').replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').slice(0, 24);
    if (drops.length) {
      add({ id: 'title', icon: 'T', group: 'Text', title: 'Title card on the drop', desc: 'Big kinetic title slamming in on the drop: click it on the Text track to type a move or character name', texts: [{ text: 'TITLE', start: drops[0] + 0.04, dur: bd * 2 - 0.08, style: 'kinetic', size: 0.2, y: 0.5, color: '#ffffff', font: 'Anton', weight: 400, anim: 'slam' }], at: Math.max(0, drops[0] - 1) });
    } else {
      const end = Math.min(2.5, L);
      add({ id: 'title', icon: 'T', group: 'Text', title: 'Title card', desc: `"${name.toUpperCase()}" popping in over the intro (edit the text after)`, texts: [{ text: name.toUpperCase(), start: 0.15, dur: Math.max(0.8, end - 0.15), style: 'impact', size: 0.13, y: 0.5, color: '#ffffff', anim: 'pop' }], at: 0 });
    }
  }

  if (voice) {
    // over the spoken line only the camera moves: no flashes, overlays, titles or whooshes (a riser
    // may build from where the line ends into the drop)
    const calm = ['camera', 'slowzoom', 'letterbox', 'bw', 'bassout', 'muffle'];
    const lineEnd = voice.out - voice.s0; // timeline time the clip's sound has faded by
    for (const sg of out) {
      if (sg.id === 'voiceintro' || sg.id === 'voicesubs') continue;
      const had = (sg.effects || []).length + (sg.texts || []).length + (sg.sfx || []).length;
      if (sg.effects) sg.effects = sg.effects.filter((e) => calm.includes(e.type) || (['mute', 'songcut'].includes(e.type) && e.start >= lineEnd) || e.start >= voice.E - 0.05 || e.start + e.dur <= 0.02);
      if (sg.texts) sg.texts = sg.texts.filter((t) => t.start >= voice.E - 0.05);
      if (sg.sfx) sg.sfx = sg.sfx.filter((x) => x.start >= lineEnd);
      // a suggestion left with nothing to do isn't offered as on
      const left = (sg.effects || []).length + (sg.texts || []).length + (sg.sfx || []).length;
      if (had && !left && !sg.clips && !sg.mod && !sg.look && !sg.lookPreset && !sg.loop) sg.recommended = false;
    }
  }

  const order = ['Structure', 'Layout', 'Motion', 'Impact', 'Transitions', 'Look', 'Text'];
  // (and in a lock-word edit, none of the hit effects or song edits, even the ones the arc would insist on)
  if (lockEdit) for (const x of out) if (LOCK_OFF.includes(x.id)) x.recommended = false;
  return out.sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group));
}

const picked = (plan) => plan.styleKey;

// The colour an edit's shots lean to, as one of the one-colour looks: each shot's hue weighted by
// its saturation and length, and the quarter of the colour wheel holding most of that weight (an
// average would cancel out an edit that cuts between warm and cold shots, or land between them on a
// colour neither has). null when the footage is too muted, or split too evenly, to say.
function paletteFor(project, clips) {
  const shots = [];
  for (const c of clips) {
    const m = getMedia(project, c.mediaId), g = m && m.analysis && m.analysis.grid;
    if (!g || !g.phx) continue;
    const span = clipSpan(c), x = gridMean(g, 'phx', c.srcIn, c.srcIn + span), y = gridMean(g, 'phy', c.srcIn, c.srcIn + span);
    shots.push({ h: (Math.atan2(y, x) * 180) / Math.PI, w: Math.hypot(x, y) * c.dur, d: c.dur });
  }
  const all = shots.reduce((s, q) => s + q.w, 0), dur = shots.reduce((s, q) => s + q.d, 0);
  if (!dur || all / dur < 0.04) return null;
  let best = null;
  for (let c0 = 0; c0 < 360; c0 += 5) {
    let x = 0, y = 0, w = 0;
    for (const q of shots) {
      const dh = ((q.h - c0 + 540) % 360) - 180;
      if (Math.abs(dh) <= 45) { x += Math.cos((q.h * Math.PI) / 180) * q.w; y += Math.sin((q.h * Math.PI) / 180) * q.w; w += q.w; }
    }
    if (!best || w > best.w) best = { w, h: ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360 };
  }
  if (best.w < all * 0.45) return null;
  const h = best.h;
  return h < 15 || h >= 345 ? 'blood' : h < 50 ? 'amber' : h < 75 ? 'sunset' : h < 165 ? 'jade' : h < 215 ? 'ice' : h < 265 ? 'cold' : 'violet';
}

// (and no one-colour grade: each lock shot keeps its own colours and its letters take theirs from the
// thing, as in all nine references; no eye glint over a lock either)
const LOCK_OFF = ['actionhits', 'fxboost', 'beatzoom', 'pulses', 'speedlines', 'burst', 'drops', 'songedits', 'freeze', 'velocity', 'letterbox', 'flash', 'grade', 'glint', 'preview', 'vfx'];

// ---------- apply / remove ----------
const deep = (o) => JSON.parse(JSON.stringify(o));

export function applySuggestion(project, s) {
  const auto = project.auto;
  if (auto.applied.includes(s.id)) return;
  auto.applied.push(s.id);
  if (s.clips) {
    if (!auto.saved.clips) auto.saved.clips = deep(project.clips);
    project.clips = deep(s.clips);
    reapplyClipMods(project);
  }
  if (s.mod === 'velocity') { applyVelocity(project); if (auto.applied.includes('freeze')) applyFreeze(project); }
  if (s.mod === 'reframe') applyReframe(project);
  if (s.mod === 'freeze') applyFreeze(project);
  if (s.mod === 'voice') { project.voice = deep(s.voice); applyVoice(project); }
  if (s.layout) {
    auto.saved['layout:' + s.id] = project.layout || 'fill';
    project.layout = s.layout;
  }
  if (s.lookPreset) {
    auto.saved['look:' + s.id] = deep(project.look);
    const pre = LOOKS[s.lookPreset];
    for (const k of Object.keys(GRADE_DEFAULT)) project.look[k] = deep(pre[k] ?? GRADE_DEFAULT[k]);
    project.look.preset = s.lookPreset;
  }
  if (s.look) {
    // (on top of a preset in the same suggestion, switching it off still restores the look before both)
    if (!s.lookPreset) auto.saved['look:' + s.id] = deep(project.look);
    Object.assign(project.look, deep(s.look));
  }
  if (s.effects) for (const e of s.effects) project.effects.push({ ...deep(e), id: uid('fx'), src: s.id });
  if (s.texts) for (const t of s.texts) project.texts.push({ ...deep(t), id: uid('tx'), src: s.id });
  if (s.loop) project.loop = deep(s.loop);
  if (s.sfx) { project.sfx = project.sfx || []; for (const x of s.sfx) project.sfx.push({ ...deep(x), id: uid('sx'), src: s.id }); }
}

export function removeSuggestion(project, s) {
  const auto = project.auto;
  if (!auto.applied.includes(s.id)) return;
  auto.applied = auto.applied.filter((x) => x !== s.id);
  if (s.clips && auto.saved.clips) {
    project.clips = auto.saved.clips;
    delete auto.saved.clips;
    reapplyClipMods(project);
  }
  if (s.mod === 'freeze') removeFreeze(project);
  if (s.mod === 'velocity') { removeVelocity(project); if (auto.applied.includes('freeze')) applyFreeze(project); }
  if (s.mod === 'reframe') for (const c of project.clips) c.pan = null;
  if (s.mod === 'voice') { delete project.voice; applyVoice(project); }
  if (s.layout) {
    if (project.layout === s.layout) project.layout = auto.saved['layout:' + s.id] || 'fill';
    delete auto.saved['layout:' + s.id];
  }
  if ((s.lookPreset || s.look) && auto.saved['look:' + s.id]) {
    const prev = auto.saved['look:' + s.id];
    const keys = s.look ? Object.keys(s.look) : ['preset', ...Object.keys(GRADE_DEFAULT)];
    for (const k of keys) project.look[k] = prev[k];
    delete auto.saved['look:' + s.id];
  }
  if (s.effects) project.effects = project.effects.filter((e) => e.src !== s.id);
  if (s.texts) project.texts = project.texts.filter((e) => e.src !== s.id);
  if (s.sfx) project.sfx = (project.sfx || []).filter((e) => e.src !== s.id);
  if (s.loop) delete project.loop;
}

// the voice intro's clip plays its own sound only while the voice intro is on
function applyVoice(project) {
  const on = project.auto.applied.includes('voiceintro');
  for (const c of project.clips) if (c.voice) c.volume = on ? 1 : 0;
}

export function reapplyClipMods(project) {
  const a = project.auto.applied;
  applyVoice(project);
  if (a.includes('velocity')) applyVelocity(project);
  if (a.includes('freeze')) applyFreeze(project);
  if (a.includes('reframe')) applyReframe(project);
  applyFocus(project);
}

// Where the subject sits in each clip (source x, 0..1): zooms and light bursts aim there.
export function applyFocus(project) {
  for (const c of project.clips) {
    const m = getMedia(project, c.mediaId);
    const g = m && m.analysis && m.analysis.grid;
    if (g && g.sal) c.focus = bestCropCenter(salProfile(g, c.srcIn, c.srcIn + clipSpan(c)), 0.35).c;
  }
}

// Freeze the second half of the clip that leads into the first drop.
export function applyFreeze(project) {
  const d = project.auto.ctx && project.auto.ctx.drop;
  if (d == null) return;
  const c = project.clips.find((x) => Math.abs(x.start + x.dur - d) < 0.08 && x.dur >= 0.3 && !x.voice && !x.lock);
  if (!c) return;
  const prev = project.auto.saved.freeze;
  if (!prev || prev.id !== c.id) project.auto.saved.freeze = { id: c.id, srcIn: c.srcIn, speedKeys: c.speedKeys };
  c.speedKeys = deep(SPEED_CURVES.freeze);
}

function removeFreeze(project) {
  const f = project.auto.saved.freeze;
  if (!f) return;
  const c = project.clips.find((x) => x.id === f.id);
  if (c) { c.srcIn = f.srcIn; c.speedKeys = f.speedKeys; }
  delete project.auto.saved.freeze;
}

function fitKeys(project, c, keys) {
  const m = getMedia(project, c.mediaId);
  const [a, b] = c.scene || [0, m ? m.duration : c.srcIn + c.dur * 4];
  const span = c.dur * avgSpeedOfKeys(keys);
  if (c.srcIn + span > b) {
    if (b - span >= a) c.srcIn = b - span;
    else {
      const f = (b - a) / span;
      keys = keys.map(([u, s]) => [u, s * f]);
      c.srcIn = a;
    }
  }
  c.speedKeys = keys;
}

// Ramps read best on shots that actually move; keep every third eligible clip at
// normal speed so the edit has room to breathe.
// Re-time an existing edit to a new song. The edit is one uncut clip whose own cuts (found by the
// scan) mark its shots. Every cut moves to a beat or half-beat near where it was (dynamic
// programming over the candidates), keeping each shot's speed change gentle (0.8–1.25×; a shot that
// must get much shorter is trimmed instead). The shots, their order and the total length stay.
function retimeToBeats(project, G, win) {
  if (project.clips.length !== 1) return null;
  const c0 = project.clips[0], m = getMedia(project, c0.mediaId);
  const scenes = m && m.analysis && m.analysis.scenes;
  if (!scenes || scenes.length < 3) return null;
  const L = c0.dur;
  const cuts = scenes.map((s) => s.start - c0.srcIn).filter((t) => t > 0.2 && t < L - 0.2);
  if (cuts.length < 2) return null;
  const bt = G.beats.map((b) => b - win.start).filter((b) => b > -1 && b < L + 1);
  const grid = [];
  bt.forEach((b, i) => { grid.push({ t: b, half: false }); if (bt[i + 1] != null) grid.push({ t: (b + bt[i + 1]) / 2, half: true }); });
  const pts = [0, ...cuts, L];
  // candidates per cut: grid points within 0.4 s of the original cut
  const cand = cuts.map((c) => grid.filter((g) => Math.abs(g.t - c) <= 0.45 && g.t > 0.15 && g.t < L - 0.15));
  const speedCost = (span, d) => {
    if (d < 0.2) return Infinity;
    const sp = span / d;
    // shots play at normal speed and are trimmed to fit (any speed change breaks the anime's
    // drawn cadence into stutter); a shot that's too short is stretched as little as possible
    if (sp < 0.88) return Infinity;
    return sp < 1 ? Math.abs(Math.log(sp)) * 1.6 : (sp - 1) * 0.35;
  };
  // DP over cuts
  let prev = [{ t: 0, cost: 0, back: null }];
  const layers = [];
  for (let k = 0; k < cuts.length; k++) {
    const span = pts[k + 1] - pts[k], layer = [];
    for (const g of cand[k]) {
      let best = null;
      for (const p of prev) {
        const sc = speedCost(span, g.t - p.t);
        if (!isFinite(sc)) continue;
        const cost = p.cost + sc + Math.abs(g.t - cuts[k]) * 2 + (g.half ? 0.06 : 0);
        if (!best || cost < best.cost) best = { t: g.t, cost, back: p };
      }
      if (best) layer.push(best);
    }
    if (!layer.length) return null;
    layers.push(layer);
    prev = layer;
  }
  let end = null;
  for (const p of prev) {
    const sc = speedCost(L - cuts[cuts.length - 1], L - p.t);
    if (isFinite(sc) && (!end || p.cost + sc < end.cost)) end = { cost: p.cost + sc, node: p };
  }
  if (!end) return null;
  const targets = [];
  for (let n = end.node; n && n.back; n = n.back) targets.unshift(n.t);
  const T = [0, ...targets.map((t) => t - CUT_LEAD), L];
  const clips = [];
  let moved = 0;
  for (let i = 0; i < T.length - 1; i++) {
    const a = pts[i], b = pts[i + 1], d = T[i + 1] - T[i];
    const sp = Math.min(1, (b - a) / d);
    clips.push({
      id: uid('c'), mediaId: c0.mediaId, start: T[i], dur: d, srcIn: c0.srcIn + a,
      speedKeys: Math.abs(sp - 1) > 0.01 ? [[0, sp], [1, sp]] : null, pan: null,
      scene: [c0.srcIn + a, c0.srcIn + b], focus: c0.focus ?? 0.5,
    });
    if (i > 0) moved += Math.abs(T[i] - pts[i]);
  }
  return { clips, moved: moved / Math.max(1, T.length - 2) };
}

function rampEligible(c) {
  if (c.seam) return false; // the shots that meet at the loop point stay at normal speed
  if (c.lock) return false; // a lock word's shot is timed to its lock frame
  // a ramp's slow part holds each drawing longer still: on threes or held art that's a stutter
  if (c.cadence && c.cadence.rate < 10) return false;
  if (c.role && c.role !== 'build') return false; // holds stay steady, burst hits stay punchy
  return c.level && c.level !== 'low' && c.dur >= 0.35 && (c.motion == null || c.motion >= 0.3);
}

// Once each shot's drawing cadence is known: shots drawn on threes (or held) lose a speed ramp
// they were given, back to how they were cut; shots drawn on ones (with in-betweens available at
// export) get real slow motion in the ramp's calm part, the fast-slow-fast of the reference
// velocity edits (on twos and threes the slow part stays at normal speed: slowing held drawings
// stutters). True when anything changed.
export function cadenceGuard(project, { fluid = true } = {}) {
  const sv = project.auto.saved.velocity || {}, fz = project.auto.saved.freeze;
  let changed = false;
  for (const c of project.clips) {
    // a lock word's shot (group G) not drawn on ones: its drawings play at their own speed and stop
    // dead on the lock drawing, the camera doing the slowing (an eased or slowed approach on twos holds
    // its drawings unevenly: the kiss shot's stutter); with too little of its scene for the run-up
    // it holds its first drawing for the difference instead of slowing them all
    if (c.lock && c.cadence && c.cadence.rate < 18 && !c.lock.cad) {
      relockAtSpeed(project, c);
      c.lock.cad = c.cadence.label;
      changed = true;
    }
    // (a lock shot keeps its own timing: the lock frame on the downbeat; slowing it would move the lock)
    if (c.lock) continue;
    if (!c.cadence || !sv[c.id]) continue;
    // the freeze before the drop sits on top of any ramp there: it holds one drawing, right on any
    // cadence, and stays as it is
    if (fz && fz.id === c.id && project.auto.applied.includes('freeze')) continue;
    if (c.cadence.rate < 10) {
      c.srcIn = sv[c.id].srcIn; c.speedKeys = sv[c.id].speedKeys;
      delete sv[c.id];
      changed = true;
    } else if (fluid && c.cadence.rate >= 18 && !c.slowmo && c.speedKeys) {
      const keys = c.speedKeys.map(([u, sp]) => [u, Math.abs(sp - 1) < 1e-6 ? SLOWMO : sp]);
      if (keys.some(([, sp], i) => sp !== c.speedKeys[i][1])) { fitKeys(project, c, keys); c.slowmo = true; changed = true; }
    }
  }
  return changed;
}
const SLOWMO = 0.55;

function relockAtSpeed(project, c) {
  const m = getMedia(project, c.mediaId), L = c.lock, lead = L.at - c.start;
  const scs = (m && m.analysis && m.analysis.scenes) || [], sc = scs.find((x) => L.src >= x.start - 0.02 && L.src < x.end);
  const room = Math.max(0, sc ? L.src - sc.start - 0.02 : L.src);
  const hold = 0.001, run = Math.min(lead, room), wait = lead - run;
  const uW = wait / c.dur, uL = lead / c.dur, e = 1e-4;
  c.speedKeys = wait > 0.02 ? [[0, hold], [uW, hold], [uW + e, 1], [uL - e, 1], [uL, hold], [1, hold]] : [[0, 1], [uL - e, 1], [uL, hold], [1, hold]];
  c.srcIn = 0;
  c.srcIn = Math.max(0, L.src - srcTimeAt(c, lead));
  Object.assign(L, { rate: 1, slowed: null, held: wait > 0.02 ? +wait.toFixed(2) : null });
}

export function applyVelocity(project) {
  const bd = (project.auto.ctx && project.auto.ctx.beatDur) || 0.5;
  const saved = (project.auto.saved.velocity = {});
  const long = ['swell', 'bullet', 'swell', 'hero'], short = ['hit', 'flashin', 'hit'];
  let n = 0;
  for (const c of project.clips) {
    if (!rampEligible(c)) continue;
    if (n++ % 3 === 2 && !c.isDrop) continue;
    // the clip as it was before any speed change: under a freeze, the freeze's own saved original
    // (otherwise switching Velocity off would bring a removed freeze back)
    const fz = project.auto.saved.freeze;
    saved[c.id] = fz && fz.id === c.id ? { srcIn: fz.srcIn, speedKeys: fz.speedKeys } : { srcIn: c.srcIn, speedKeys: c.speedKeys };
    const name = c.dur / bd >= 1.6 ? long[n % long.length] : short[n % short.length];
    c.slowmo = false; // (real slow motion goes on once the shot's cadence is known)
    fitKeys(project, c, deep(SPEED_CURVES[name]));
  }
}

function removeVelocity(project) {
  const saved = project.auto.saved.velocity || {};
  for (const c of project.clips) {
    const s = saved[c.id];
    if (s) { c.srcIn = s.srcIn; c.speedKeys = s.speedKeys; }
  }
  delete project.auto.saved.velocity;
}

// Crop each clip around its subject (detail + motion + colour profile), held
// steady unless the subject clearly moves across the frame during the clip.
export function applyReframe(project) {
  for (const c of project.clips) {
    const m = getMedia(project, c.mediaId);
    const w = cropWidth(project, m);
    if (!m || !m.analysis || w >= 0.98 || project.layout === 'rotate') { c.pan = null; continue; }
    c.pan = reframePan(m, c, w);
  }
}

export function reframePan(m, c, w) {
  const span = clipSpan(c), g = m.analysis.grid;
  const whole = bestCropCenter(salProfile(g, c.srcIn, c.srcIn + span), w).c;
  const a = bestCropCenter(salProfile(g, c.srcIn, c.srcIn + span * 0.45), w).c;
  const b = bestCropCenter(salProfile(g, c.srcIn + span * 0.55, c.srcIn + span), w).c;
  if (Math.abs(b - a) < 0.12) return [whole, whole];
  const half = clamp((b - a) / 2, -0.15, 0.15);
  return [whole - half, whole + half];
}
