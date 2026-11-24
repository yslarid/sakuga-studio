// Sakuga Studio — app wiring: media import, analysis pipeline, AI suggestions,
// panels, inspector, keyboard shortcuts and export.
import {
  uid, clamp, createProject, FORMATS, LAYOUTS, formatSize, getMedia, History, fmtTime, relayout, pictureBox,
  timelineDuration, timelineMusic, clipIndexAt, srcTimeAt, speedFromKeys, avgSpeedOfKeys, clipSpan,
} from './state.js';
import { FX, FX_CATEGORIES, defaultParams, LOOKS, applyLookPreset } from './effects.js';
import { decodeAudio, analyzeMusic, audioContext, peaksOf } from './analysis/audio.js';
import { matchFullSong, alignedSlice, bandwidth } from './analysis/fullsong.js';
import { loadVideoMeta, makeThumb, analyzeVideo, salProfile, bestCropCenter, gridMean } from './analysis/video.js';
import { analyzeReference, styleFromReference } from './analysis/reference.js';
import { loadSfxManifest, sfxManifest, sfxById, loadSfx, previewSfx, preloadProjectSfx } from './sfx.js';
import { loadVfxManifest, vfxManifest, vfxAsset, preloadProjectVfx } from './vfx.js';
import { transcribeSong, transcribeDialogue, finishDialogue, phrases, sentenceLines, alignLyrics, alignWordsToAudio, unlagWords, vocalPhrases, vocalRuns, foldLookalikes } from './lyrics.js';
import {
  STYLES, LENGTHS, buildPlan, buildSuggestions, baseClips, applySuggestion, removeSuggestion,
  applyReframe, reapplyClipMods, SPEED_CURVES, reframePan, cropWidth, cadenceGuard, autoColorMatch,
} from './engine/autoedit.js';
import { extractPose, scorePosePair, computeAlignTransform } from './engine/matchcut.js';
import { Renderer, frameParams } from './render/renderer.js';
import { makeCovers, coverTitle } from './export/cover.js';
import { TextLayer, TEXT_STYLES, TEXT_ANIMS, TEXT_FONTS, KINETIC_FONTS, KINETIC_COLORS, fontStack, loadScriptFonts } from './render/text.js';
import { loadCaptionStyles, loadUiFont } from './render/fonts.js';
import { interpolationModelPath } from './render/interp.js';
import { Player, prepareVoiceStems } from './player.js';
import { Timeline } from './ui/timeline.js';
import { GraphEditor } from './ui/graph-editor.js';
import { CanvasGizmo } from './ui/canvas-gizmo.js';
import { renderQAPanel, updateQABadge } from './ui/qa-panel.js';
import { exportVideo, exportSupported } from './export/exporter.js';
import { probeFps, openFrameSource } from './export/frame-reader.js';
import { segmentTimes, segmentFrames, maskAt, maskNear, maskStats } from './analysis/segment.js';
import { detectFaces, facesAt } from './analysis/faces.js';
import { makeGuideMedia } from './guide.js';
import { cacheGet, cachePut, fingerprint } from './cache.js';
import { keyLogo, savedWatermark, saveWatermark, WATERMARK_DEFAULT } from './watermark.js';

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- app ----------
const listeners = {};
const app = {
  project: { ...createProject(), fluid: Boolean(interpolationModelPath), watermark: savedWatermark() },
  sel: null,
  snap: true,
  opts: { style: 'auto', length: 'auto', order: 'story', autoApply: true },
  analysis: { state: 'idle', steps: [], error: null },
  plan: null,
  suggestions: [],
  autoApplied: false,
  on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); },
  emit(ev, d) { (listeners[ev] || []).forEach((fn) => fn(d)); },
  select(sel) {
    this.sel = sel;
    if (sel) showTab('right', 'inspector');
    this.timeline.render();
    renderInspector();
    if (this.gizmo) this.gizmo.render();
    if (this.graphEditor && this.graphEditor.isOpen()) {
      if (sel && (sel.kind === 'clip' || sel.kind === 'fx')) this.graphEditor.setTarget({ type: sel.kind, id: sel.id });
      else this.graphEditor.render();
    }
  },
  changed(opts = {}) {
    sizePreview();
    $('#formatSel').value = this.project.format;
    if (this.project.texts.length) loadCaptionStyles();
    this.player.invalidate();
    this.timeline.render();
    if (opts.inspector !== false) renderInspector();
    if (this.gizmo) this.gizmo.render();
    if (this.graphEditor && this.graphEditor.isOpen()) this.graphEditor.render();
    renderAI();
    updateEmpty();
    updateTransport();
    updateQABadge(this);
    const qaBtn = document.querySelector('.tabs[data-group="right"] button[data-tab="qa"]');
    if (qaBtn && qaBtn.classList.contains('active')) renderQAPanel(this, $('#qaPanel'));
    preloadProjectSfx(this.project).then(() => this.player.invalidate());
    preloadProjectVfx(this.project).then(() => this.player.invalidate());
    const ls = document.getElementById('layoutSel');
    if (ls && ls.value !== (this.project.layout || 'fill')) ls.value = this.project.layout || 'fill';
  },
};
window.sakuga = app;
app.importFiles = (files) => importFiles(files);

app.history = new History(() => app.project, () => {
  if (app.sel && !findSel(app.sel)) app.sel = null;
  if (app.plan) app.suggestions = buildSuggestions(app.project, app.plan);
  app.changed();
  renderLook();
});

// ---------- setup ----------
const canvas = $('#preview');
try {
  app.renderer = new Renderer(canvas);
} catch (e) {
  document.body.innerHTML = `<div style="padding:40px;font:15px Inter,sans-serif;color:#eee">Sakuga Studio needs WebGL2 (use a recent Chrome, Edge or Safari).<br><br><code>${esc(e.message)}</code></div>`;
  throw e;
}
app.textLayer = new TextLayer();
app.player = new Player(app);
app.timeline = new Timeline(app);
app.qaIssues = [];
app.openQA = () => { showTab('right', 'qa'); renderQAPanel(app, $('#qaPanel')); };
app.graphEditor = new GraphEditor(app, $('#graphDrawer'));
app.gizmo = new CanvasGizmo(app, $('#canvasGizmo'), canvas);
if ($('#btnCurves')) $('#btnCurves').onclick = () => app.graphEditor.toggle();
if ($('#btnQA')) $('#btnQA').onclick = () => app.openQA();

function fillSelect(el, entries, value) {
  el.innerHTML = entries.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('');
  el.value = value;
}
fillSelect($('#styleSel'), Object.entries(STYLES).map(([k, s]) => [k, s.label]), 'auto');
fillSelect($('#lengthSel'), Object.entries(LENGTHS), 'auto');
fillSelect($('#formatSel'), Object.entries(FORMATS).map(([k, f]) => [k, f.label]), 'orig');
fillSelect($('#layoutSel'), Object.entries(LAYOUTS), 'fill');
$('#layoutSel').onchange = (e) => {
  const p = app.project;
  app.history.push();
  // a manual pick replaces whichever layout suggestion was on
  const layoutIds = app.suggestions.filter((s) => s.layout).map((s) => s.id);
  p.auto.applied = p.auto.applied.filter((id) => !layoutIds.includes(id));
  for (const id of layoutIds) delete p.auto.saved['layout:' + id];
  p.layout = e.target.value;
  app.changed();
};

$('#styleSel').onchange = (e) => { app.opts.style = e.target.value; regenerate({ restyle: true }); };
$('#lengthSel').onchange = (e) => { app.opts.length = e.target.value; regenerate(); };
$('#proToggle').onchange = (e) => { app.opts.pro = e.target.checked; regenerate({ restyle: true }); };
$('#formatSel').onchange = (e) => {
  app.history.push();
  app.project.format = e.target.value;
  if (app.project.auto.applied.includes('reframe')) applyReframe(app.project);
  if (app.plan) app.suggestions = buildSuggestions(app.project, app.plan);
  app.changed();
};
$('#undoBtn').onclick = () => app.history.undo();
$('#redoBtn').onclick = () => app.history.redo();
$('#exportBtn').onclick = openExport;
$('#snapChk').onchange = (e) => { app.snap = e.target.checked; };
$('#splitBtn').onclick = splitAtPlayhead;
$('#deleteBtn').onclick = deleteSelection;

document.querySelectorAll('.tabs').forEach((nav) => {
  nav.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-tab]');
    if (b) showTab(nav.dataset.group, b.dataset.tab);
  });
});

function showTab(group, tab) {
  const nav = document.querySelector(`.tabs[data-group="${group}"]`);
  if (tab === 'text') loadCaptionStyles();
  nav.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  const panel = nav.parentElement;
  panel.querySelectorAll('.pane').forEach((p) => p.classList.toggle('active', p.dataset.pane === tab));
  if (group === 'right' && tab === 'qa') renderQAPanel(app, $('#qaPanel'));
}

// ---------- preview sizing ----------
const wrap = $('#previewWrap');
function sizePreview() {
  const { w, h } = formatSize(app.project);
  const W = wrap.clientWidth - 32, H = wrap.clientHeight - 32;
  if (W <= 0 || H <= 0) return;
  const s = Math.min(W / w, H / h);
  const cw = Math.max(1, Math.floor(w * s)), ch = Math.max(1, Math.floor(h * s));
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const rw = Math.min(w, Math.round(cw * dpr)), rh = Math.round((rw * h) / w);
  if (canvas.style.width === cw + 'px' && canvas.style.height === ch + 'px' &&
      canvas.width === rw && canvas.height === rh) return;
  canvas.style.width = cw + 'px';
  canvas.style.height = ch + 'px';
  app.renderer.setSize(rw, rh);
  app.textLayer.setSize(rw, rh);
  if (app.gizmo) app.gizmo.resize();
}
new ResizeObserver(() => { sizePreview(); app.player.invalidate(); }).observe(wrap);

// ---------- transport ----------
const playBtn = $('#playBtn');
playBtn.onclick = () => app.player.toggle();
$('#toStart').onclick = () => app.player.seek(0);
$('#toEnd').onclick = () => app.player.seek(timelineDuration(app.project));
$('#prevBeat').onclick = () => jumpBeat(-1);
$('#nextBeat').onclick = () => jumpBeat(1);

function jumpBeat(dir) {
  const tm = timelineMusic(app.project);
  const t = app.player.t;
  if (!tm || !tm.beats.length) { app.player.seek(t + dir * 0.5); return; }
  const b = dir > 0 ? tm.beats.find((x) => x > t + 0.01) : [...tm.beats].reverse().find((x) => x < t - 0.01);
  if (b != null) app.player.seek(b);
}

app.on('time', () => {
  app.timeline.updatePlayhead();
  updateTransport();
  if (app.gizmo) app.gizmo.render();
  if (app.graphEditor && app.graphEditor.isOpen()) app.graphEditor.render();
});
app.on('play', () => {
  playBtn.textContent = app.player.playing ? '❚❚' : '▶';
  playBtn.classList.toggle('playing', app.player.playing);
});

let lastTc = '';
function updateTransport() {
  const t = app.player.t, d = timelineDuration(app.project);
  const tc = `${fmtTime(t)} / ${fmtTime(d)}`;
  if (tc !== lastTc) { $('#timecode').textContent = tc; lastTc = tc; }
  const tm = timelineMusic(app.project);
  const bi = $('#beatInfo');
  if (tm && tm.beats.length) {
    let n = 0;
    for (const b of tm.beats) if (b <= t + 0.01) n++;
    const bar = Math.max(1, Math.ceil(n / 4)), beat = ((n - 1) % 4 + 4) % 4 + 1;
    const html = `<b>${Math.round(tm.A.bpm)} BPM</b> · bar ${bar} · beat ${n ? beat : '–'}`;
    if (bi._h !== html) { bi.innerHTML = html; bi._h = html; }
  } else if (bi._h !== '') { bi.innerHTML = ''; bi._h = ''; }
}

function updateEmpty() {
  $('#emptyState').classList.toggle('hidden', app.project.media.length > 0);
}

// ---------- import ----------
const fileInput = $('#fileInput');
$('#dropzone').onclick = () => fileInput.click();
$('#emptyAdd').onclick = () => fileInput.click();

const exampleButton = $('#openExample');
exampleButton.onclick = async () => {
  exampleButton.disabled = true;
  exampleButton.textContent = 'Opening…';
  try {
    const files = await Promise.all(['Afterlight.mp4', 'Pulse-120.wav'].map(async (name) => {
      const response = await fetch('examples/' + name);
      if (!response.ok) throw new Error('Could not load ' + name);
      const blob = await response.blob();
      return new File([blob], name, { type: blob.type });
    }));
    if (app.project.media.length === 0) await importFiles(files);
  } catch (err) {
    toast('Could not open the example. ' + err.message, true);
  } finally {
    exampleButton.disabled = false;
    exampleButton.textContent = 'Open example';
  }
};
fileInput.onchange = () => { importFiles([...fileInput.files]); fileInput.value = ''; };

for (const el of [$('#dropzone'), wrap, document.body]) {
  el.addEventListener('dragover', (e) => { e.preventDefault(); (el === document.body ? wrap : el).classList.add('over'); });
  el.addEventListener('dragleave', () => { (el === document.body ? wrap : el).classList.remove('over'); });
  el.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    $('#dropzone').classList.remove('over'); wrap.classList.remove('over');
    importFiles([...e.dataTransfer.files]);
  });
}

const AUDIO_EXT = /\.(mp3|wav|m4a|aac|flac|ogg|opus)$/i;
const VIDEO_EXT = /\.(mp4|m4v|mov|webm|mkv|avi)$/i;
const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp|avif)$/i;

async function importFiles(files) {
  const added = [];
  for (const file of files) {
    const isAudio = file.type.startsWith('audio/') || AUDIO_EXT.test(file.name);
    const isVideo = file.type.startsWith('video/') || VIDEO_EXT.test(file.name);
    const isImage = file.type.startsWith('image/') || IMAGE_EXT.test(file.name);
    if (!isAudio && !isVideo && !isImage) { toast(`Skipped ${file.name} (not audio/video/image)`, true); continue; }
    const kind = isAudio ? 'audio' : isImage ? 'image' : 'video';
    const media = { id: uid('m'), name: file.name, kind, type: kind, file, url: URL.createObjectURL(file), duration: isImage ? 5 : 0, w: 0, h: 0, status: 'loading', analysis: null, audio: null, knownCuts: file.knownCuts || null, dialogueSrc: file.dialogue || null, hd: file.hd || null, beatsSrc: file.beats || null };
    app.project.media.push(media);
    added.push(media);
  }
  if (!added.length) return;
  renderMedia();
  updateEmpty();
  for (const m of added) {
    try {
      if (m.kind === 'video') {
        const v = await loadVideoMeta(m.url);
        m.duration = v.duration; m.w = v.videoWidth; m.h = v.videoHeight;
        if (!m.w) throw new Error('no video track');
        m.thumb = await makeThumb(v, Math.min(1, v.duration / 3));
        m.fps = await probeFps(m.file);
        v.removeAttribute('src'); v.load();
      } else if (m.kind === 'image') {
        const img = new Image();
        img.src = m.url;
        await new Promise((res, rej) => { img.onload = res; img.onerror = rej; });
        m.w = img.naturalWidth; m.h = img.naturalHeight;
        m.thumb = m.url;
      } else {
        await decodeAudio(m);
        m.duration = m.audio.buffer.duration;
      }
      m.fp = app.opts.noCache ? null : await fingerprint(m.file);
      if (m.kind === 'video' && m.fp) {
        // character outlines and faces found in an earlier session
        const [masks, faces] = await Promise.all([cacheGet(m.fp, 'masks'), cacheGet(m.fp, 'faces')]);
        if (masks && masks.w) m.masks = masks;
        if (faces) m.faces = faces;
      }
      m.status = 'ready';
    } catch (e) {
      console.warn(`[import] ${m.name}:`, e);
      m.status = 'error';
      m.error = m.kind === 'video' ? "This browser can't play this video format" : m.kind === 'image' ? "This image couldn't be loaded" : "This audio file couldn't be decoded";
      toast(`${m.name}: ${m.error}`, true);
    }
    renderMedia();
  }
  const p = app.project;
  const song = added.find((m) => m.kind === 'audio' && m.status === 'ready');
  if (song && (!p.music || p.music.auto)) setMusic(song, false);
  if (!p.clips.length && p.media.some((m) => m.kind === 'video' && m.status === 'ready')) {
    p.clips = baseClips(p, null);
    relayout(p.clips);
  }
  app.changed();
  if (added.some((m) => m.kind === 'video' || m.kind === 'audio')) runAnalysis();
}

// Royalty-free songs bundled with the app (Kevin MacLeod, CC BY 4.0). Edits are
// built on a song's beats and drop, so footage without a song gets one of these.
const BUILTIN_TRACKS = [
  { id: 'volatile', file: 'music/volatile-reaction.mp3', title: 'Volatile Reaction', vibe: 'Hard-hitting, big drop · 155 BPM' },
  { id: 'premises', file: 'music/exit-the-premises.mp3', title: 'Exit the Premises', vibe: 'Driving and steady · 129 BPM' },
];
const creditFor = (t) => `Music: "${t.title}" by Kevin MacLeod (incompetech.com), CC BY 4.0`;

async function loadBuiltin(track) {
  const p = app.project;
  let m = p.media.find((x) => x.builtin === track.id);
  if (!m) {
    const r = await fetch(track.file);
    if (!r.ok) throw new Error('Could not load ' + track.title);
    const file = new File([await r.blob()], track.file.split('/').pop(), { type: 'audio/mpeg' });
    m = { id: uid('m'), name: `${track.title} — Kevin MacLeod`, kind: 'audio', file, url: URL.createObjectURL(file), duration: 0, w: 0, h: 0, status: 'loading', analysis: null, audio: null, builtin: track.id };
    p.media.push(m);
    await decodeAudio(m);
    m.duration = m.audio.buffer.duration;
    m.status = 'ready';
  }
  return m;
}

// Action footage (lots of cuts) gets the hard-hitting track, calmer footage the steady one.
function pickBuiltin(videos) {
  const dur = videos.reduce((s, m) => s + m.duration, 0) || 1;
  const cuts = videos.reduce((s, m) => s + (m.analysis ? m.analysis.scenes.length : 0), 0);
  return (cuts / dur) * 60 >= 18 ? BUILTIN_TRACKS[0] : BUILTIN_TRACKS[1];
}

async function useBuiltin(track, push = true) {
  const m = await loadBuiltin(track);
  setMusic(m, push);
  app.project.music.auto = true;
  renderMedia();
  return m;
}

// A song you'll add on Instagram: a tempo guide replaces any earlier guide and becomes the
// soundtrack. Like a built-in song, a real song you drop in later takes over from it.
function useGuide(o) {
  const p = app.project;
  app.history.push();
  for (const old of p.media.filter((m) => m.guide)) app.player.dropMedia(old.id);
  p.media = p.media.filter((m) => !m.guide);
  const m = makeGuideMedia(o, uid('m'));
  p.media.push(m);
  setMusic(m, false);
  p.music.auto = true;
  app.opts.guide = { title: m.guide.title, bpm: m.guide.bpm, introBars: m.guide.introBars };
  renderMedia();
  if (p.media.some((x) => x.kind === 'video' && x.analysis)) regenerate();
  return m;
}
app.useGuide = useGuide;

function setMusic(media, push = true) {
  if (push) app.history.push();
  app.project.music = { mediaId: media.id, offset: 0, volume: 1, fadeIn: 0, fadeOut: 0.6 };
  setTimeout(loadSavedLyrics, 0);
  setTimeout(() => restoreFullSong(media), 0);
}

// Full-quality song: a clip saved from an app is re-encoded and cut off around 16-18 kHz. A full
// download of the song, added here, is matched to the clip (where in the song the clip sits) and
// its samples play and export in the clip's place, level-matched: the beats, the lyrics' timing
// and the cuts stay exactly where they are. Remembered for the clip (this browser's cache), and
// for a studio build passed as `--song-full`.
async function useFullSong(file, { quiet = false, processed = false } = {}) {
  const p = app.project, m = p.music && getMedia(p, p.music.mediaId);
  if (!m || !m.audio || !m.audio.buffer) { if (!quiet) toast('Load the song first', true); return { ok: false, why: 'no song' }; }
  const clip = m.audio.clipBuffer || m.audio.buffer;
  let full;
  try { full = await audioContext().decodeAudioData(await file.arrayBuffer()); } catch (e) { if (!quiet) toast(`${file.name} couldn't be decoded`, true); return { ok: false, why: 'decode' }; }
  const r = await matchFullSong(clip, full);
  // (the same recording lines up at 0.8 and over; a remaster or radio edit a little under)
  if (r.score < 0.55 || r.covered < 0.95) {
    const why = r.covered < 0.95 ? 'the clip runs past the end of that file' : `it doesn't match the clip (${Math.round(r.score * 100)}%): a different version, a sped-up or slowed sound, or another song`;
    if (!quiet) toast(`${file.name}: ${why}`, true);
    return { ok: false, why, score: r.score };
  }
  const [bwClip, bwFull] = await Promise.all([bandwidth(clip), bandwidth(full)]);
  // (a download labelled 320 kbps can be a copy of a worse one: if its sound reaches no higher than
  // the clip's, it isn't the better file, and swapping it in would only add a second encoding)
  // (a finished copy of the clip itself, tools/songfx.py, is the same sound reworked: no wider band to ask of it)
  if (!processed && bwClip && bwFull && bwFull < bwClip + 300) {
    const why = `it's the same recording, but no better than the clip: its sound stops at ${(bwFull / 1000).toFixed(1)} kHz against the clip's ${(bwClip / 1000).toFixed(1)} (re-encoded from a lower-quality copy). A store download (iTunes, Amazon, Bandcamp, Qobuz) reaches 19-20 kHz`;
    if (!quiet) toast(`${file.name}: ${why}`, true);
    return { ok: false, why, score: r.score, bandwidth: bwFull, clipBandwidth: bwClip };
  }
  m.audio.clipBuffer = clip;
  m.audio.buffer = alignedSlice(full, r.offset, clip.duration, r.gain);
  m.audio.peaks = peaksOf(m.audio.buffer);
  m.audio.full = { name: file.name, offset: r.offset, score: r.score, gain: r.gain, bandwidth: bwFull, clipBandwidth: bwClip };
  cachePut(m.fp, 'fullsong', { name: file.name, type: file.type, blob: file });
  renderMedia();
  app.changed();
  const at = `${Math.floor(r.offset / 60)}:${(r.offset % 60).toFixed(1).padStart(4, '0')}`;
  if (!quiet) toast(`Full-quality song in: ${file.name}, matched at ${at} into it (${Math.round(r.score * 100)}% match${bwClip && bwFull ? `, sound up to ${(bwFull / 1000).toFixed(1)} kHz instead of ${(bwClip / 1000).toFixed(1)}` : ''})`);
  return { ok: true, ...m.audio.full };
}

// back to the clip's own sound
function dropFullSong() {
  const p = app.project, m = p.music && getMedia(p, p.music.mediaId);
  if (!m || !m.audio || !m.audio.clipBuffer) return;
  m.audio.buffer = m.audio.clipBuffer;
  m.audio.peaks = peaksOf(m.audio.buffer);
  m.audio.full = null;
  cachePut(m.fp, 'fullsong', { none: true });
  renderMedia();
  app.changed();
}

async function restoreFullSong(media) {
  // (a studio build plays the song its job names, never one this browser remembers from before)
  if (new URLSearchParams(location.search).has('studio')) return;
  if (!media || media.guide || (media.audio && media.audio.full)) return;
  for (let i = 0; i < 40 && !(media.audio && media.audio.buffer); i++) await new Promise((r) => setTimeout(r, 250));
  if (!media.audio || !media.audio.buffer) return;
  const saved = await cacheGet(media.fp, 'fullsong');
  if (!saved || saved.none || !saved.blob) return;
  const p = app.project;
  if (!p.music || p.music.mediaId !== media.id) return;
  const r = await useFullSong(new File([saved.blob], saved.name || 'full song', { type: saved.type || '' }), { quiet: true });
  if (r.ok) toast(`Playing the full-quality ${saved.name} in this clip's place`);
}

function removeMedia(id) {
  const p = app.project;
  app.history.push();
  // losing a clip that carried the soundtrack picks a new song; removing a built-in song is deliberate
  const removed = getMedia(p, id);
  const lostSong = p.music && p.music.mediaId === id && !(removed && removed.builtin);
  if (removed?.kind === 'video' && !p.media.some(m => m.kind === 'video' && m.id !== id)) {
    // Remove generated tracks while their source and saved clip layout still exist.
    for (const suggestion of [...app.suggestions].reverse()) removeSuggestion(p, suggestion);
    ++analysisRun;
    app.analysis = { state: 'idle', steps: [], error: null };
    app.plan = null;
    app.suggestions = [];
    app.autoApplied = false;
  }
  p.media = p.media.filter((m) => m.id !== id);
  p.clips = p.clips.filter((c) => c.mediaId !== id);
  p.overlays = (p.overlays || []).filter((o) => o.mediaId !== id);
  relayout(p.clips);
  if (p.music && p.music.mediaId === id) p.music = null;
  app.player.dropMedia(id);
  if (lostSong && p.media.some(m => m.kind === 'video')) {
    app.changed();
    runAnalysis();
  } else if (app.plan) {
    regenerate();
  } else {
    app.changed();
  }
  renderMedia();
}

// ---------- analysis pipeline ----------
let analysisRun = 0;
async function runAnalysis() {
  const run = ++analysisRun;
  const p = app.project;
  const A = app.analysis;
  A.state = 'running';
  A.error = null;
  const steps = (A.steps = []);
  const step = (id, label) => { const s = { id, label, state: 'pending', p: 0 }; steps.push(s); return s; };

  const videos = p.media.filter((m) => m.kind === 'video' && m.status === 'ready');
  let musicMedia = p.music && getMedia(p, p.music.mediaId);
  const vSteps = videos.filter((m) => !m.analysis).map((m) => ({ m, s: step('v' + m.id, `Scanning ${m.name} for scenes & motion`) }));
  // what the characters say (for a voice intro), in footage up to 10 minutes that has sound
  // (or written down before the build, tools/transcribe.py, at any length)
  const dSteps = videos.filter((m) => !m.dialogue && (m.duration <= 600 || m.dialogueSrc)).map((m) => ({ m, s: step('d' + m.id, `Listening for dialogue in ${m.name}`) }));
  const songStep = step('song', 'Finding beats, drops & energy');
  const buildStep = step('build', 'Building edit suggestions');
  renderAI();

  try {
    for (const { m, s } of vSteps) {
      s.state = 'active'; renderAI();
      m.status = 'analyzing'; renderMedia();
      // a run that starts while another is still scanning this file waits for that scan
      m._scan = m._scan || (async () => {
        const cached = await cacheGet(m.fp, 'video');
        const a = cached || await analyzeVideo(m, (x) => { s.p = x; m.progress = x; renderAISteps(); renderMediaProgress(m); });
        if (!cached) cachePut(m.fp, 'video', a);
        return a;
      })();
      try { m.analysis = withKnownCuts(await m._scan, m.knownCuts); } finally { m._scan = null; }
      m.status = 'ready';
      s.state = 'done';
      s.label = `${m.name}: ${m.analysis.scenes.length} scenes`;
      renderMedia(); renderAI();
      if (run !== analysisRun) return;
    }

    for (const { m, s } of dSteps) {
      s.state = 'active'; renderAI();
      try {
        m._listen = m._listen || (async () => {
          const kind = m.dialogueSrc ? 'dialogue-mlx' : 'dialogue', cached = await cacheGet(m.fp, kind);
          if (!m.audio) await decodeAudio(m);
          const say = (x) => { s.label = `${m.name}: ${x}`; renderAISteps(); };
          const d = cached || (m.dialogueSrc ? await finishDialogue(m.dialogueSrc, m.audio.buffer, say) : await transcribeDialogue(m.audio.buffer, say));
          if (!cached) cachePut(m.fp, kind, d);
          return d;
        })();
        try { m.dialogue = await m._listen; } finally { m._listen = null; }
        s.label = m.dialogue.length ? `${m.name}: ${m.dialogue.length} spoken line${m.dialogue.length > 1 ? 's' : ''}` : `${m.name}: no dialogue`;
      } catch (e) {
        // no sound track, or the speech model couldn't load: the edit just won't open on a line
        console.warn('[dialogue]', e);
        m.dialogue = [];
        s.label = `${m.name}: no dialogue`;
      }
      s.state = 'done'; renderAI();
      if (run !== analysisRun) return;
    }

    // soundtrack: your song (or tempo guide), otherwise a built-in track that suits the footage
    songStep.state = 'active'; renderAI();
    musicMedia = p.music && getMedia(p, p.music.mediaId);
    if (!musicMedia && videos.length) {
      const track = pickBuiltin(videos);
      try {
        musicMedia = await useBuiltin(track, false);
        toast(`No song added, so using "${track.title}" (Kevin MacLeod, CC BY). Drop your own song any time.`);
      } catch (e) { console.warn(e); musicMedia = null; }
    }
    if (musicMedia && musicMedia.audio && !musicMedia.audio.analysis) {
      const cached = await cacheGet(musicMedia.fp, 'music');
      if (cached) musicMedia.audio.analysis = cached;
      else { await analyzeMusic(musicMedia, (x) => { songStep.p = x; renderAISteps(); }); cachePut(musicMedia.fp, 'music', musicMedia.audio.analysis); }
      // (beats and bars tracked before the build by Beat This!, which hears a ballad's real pulse where
      // an onset tracker can lock onto two triplets as a beat; the drops and sections stay the editor's)
      const bt = musicMedia.beatsSrc, nb = app.opts && app.opts.notes && app.opts.notes.beats;
      if (bt && bt.beats.length > 8 && nb !== 'editor') musicMedia.audio.analysis = withTrackedBeats(musicMedia.audio.analysis, bt, nb === 'double');
    }
    // where the sung lines start, so a new line can start on a new shot: the caption lines
    // themselves (your lyrics' lines, timed, once the song has been through once; else the heard
    // sentences), or before any of that, the voice coming back after a breath
    await loadPhrases(musicMedia);
    songStep.state = musicMedia ? 'done' : 'skipped';
    songStep.label = musicMedia ? `Beats & drops found (${Math.round(musicMedia.audio.analysis.bpm)} BPM)` : 'No soundtrack — using a 120 BPM grid';
    renderAI();
    if (run !== analysisRun) return;

    buildStep.state = 'active'; renderAI();
    regenerate({ fresh: true });
    buildStep.state = 'done';
    A.state = 'ready';
    if (app.opts.autoApply && !app.autoApplied) {
      app.autoApplied = true;
      autoEdit(true);
      scheduleCadence();
      toast('Auto-edit applied — toggle any suggestion to change it');
    }
  } catch (e) {
    console.error(e);
    A.state = 'error';
    A.error = e.message || String(e);
    const s = steps.find((x) => x.state === 'active');
    if (s) s.state = 'error';
  }
  renderAI();
  renderMedia();
}

// Where the sung lines start, so a new line can start on a new shot: the caption lines themselves
// (your lyrics' lines, timed, once the song has been through once; else the heard sentences), or
// before any of that, the voice coming back after a breath. Kept with the song they belong to.
// True when they changed.
async function loadPhrases(musicMedia) {
  const before = JSON.stringify(app.opts.phrases || null);
  app.opts.phrases = null; app.opts.phrasesFor = null;
  if (!musicMedia || !musicMedia.audio || !musicMedia.audio.analysis || musicMedia.guide) return before !== 'null';
  const w = await cacheGet(musicMedia.fp, 'words'), raw = $('#autoLyricsPaste').value.trim();
  const T = app.lyricsTimed, key = raw ? timedKey(raw) : null;
  const lt = raw ? (T && T.mediaId === musicMedia.id && T.key === key ? T.words : await cacheGet(musicMedia.fp, 'lyrtimes', key)) : null;
  let ph = lt && lt.length ? lyricLines(lt, true).map((q) => q.start) : w && w.length ? lyricLines(w, false).map((q) => q.start) : await cacheGet(musicMedia.fp, 'phrases');
  if (!ph) { try { ph = await vocalPhrases(musicMedia.audio.buffer); cachePut(musicMedia.fp, 'phrases', ph); } catch (e) { ph = null; } }
  app.opts.phrases = ph || null;
  app.opts.phrasesFor = ph ? musicMedia.id : null;
  return JSON.stringify(app.opts.phrases) !== before;
}

// A source joined from separate clips knows where each clip starts: every join is a cut, even where
// the picture barely changes across it (two dark shots in one palette, which the cut detector reads
// as one long scene). Scenes are split there; the analysis itself (and its cache) is unchanged.
function withKnownCuts(a, cuts) {
  if (!a || !cuts || !cuts.length) return a;
  const scenes = [];
  for (const sc of a.scenes) {
    let start = sc.start;
    for (const c of cuts) if (c > start + 0.3 && c < sc.end - 0.3) { scenes.push({ start, end: c - 0.02 }); start = c; }
    scenes.push({ start, end: sc.end });
  }
  return scenes.length === a.scenes.length ? a : { ...a, scenes, cuts: [...new Set([...(a.cuts || []), ...cuts])].sort((x, y) => x - y) };
}

function regenerate(o = {}) {
  const p = app.project;
  const ready = p.media.some((m) => m.kind === 'video' && m.analysis);
  if (!ready) { app.changed(); return; }
  const wasApplied = [...p.auto.applied];
  if (!o.fresh || wasApplied.length) app.history.push();
  for (const id of [...wasApplied].reverse()) {
    const s = app.suggestions.find((x) => x.id === id);
    if (s) removeSuggestion(p, s);
  }
  p.auto.applied = [];
  // word-cut pacing only applies to the song it was transcribed from
  if (app.opts.cutTimes && (!app.lyrics || !p.music || p.music.mediaId !== app.lyrics.mediaId)) { app.opts.cutTimes = null; app.opts.cutKey = null; }
  // (and so do the line starts the cuts re-phase on)
  if (app.opts.phrases && (!p.music || p.music.mediaId !== app.opts.phrasesFor)) { app.opts.phrases = null; app.opts.phrasesFor = null; }
  app.plan = buildPlan(p, app.opts);
  app.plan.uncut = !app.opts.autoApply; // footage kept as it is (e.g. an edit made elsewhere)
  p.auto.ctx = app.plan.ctx;
  if (p.music) p.music.offset = app.plan.win.start;
  p.clips = baseClips(p, app.plan.L);
  app.suggestions = buildSuggestions(p, app.plan);
  // a new style brings its own recommended set; otherwise keep what was on
  const keep = o.restyle && wasApplied.length ? app.suggestions.filter((s) => s.recommended).map((s) => s.id) : wasApplied;
  for (const id of keep) {
    const s = app.suggestions.find((x) => x.id === id);
    if (s) applySuggestion(p, s);
  }
  p.auto.applied = app.suggestions.filter((s) => p.auto.applied.includes(s.id)).map((s) => s.id);
  // where key words sat behind characters was worked out on the old shots
  app.depth.clear();
  if (app.lyrics) placeAutoLyrics(false);
  if (p.auto.applied.length) ensureFxMasks();
  // (voice lines play their isolated voice once it's worked out; the preview uses the raw line until then)
  if (p.clips.some((c) => c.voiceAudio)) prepareVoiceStems(p).then(() => app.changed()).catch((e) => console.warn('[voices]', e));
  if (app.player.t > timelineDuration(p)) app.player.seek(0);
  app.timeline.setZoom(0);
  app.changed();
  renderLook();
  scheduleCadence();
}

// Each shot's drawing cadence, read from the frames (quick once known): a ramp on a shot drawn on
// threes comes off, and the captions and outlines follow the shots as they now play. Restarted
// whenever the shots change (a rebuild, the auto edit, a suggestion with its own cuts); runs one
// at a time, always on the shots as they are by then.
function scheduleCadence() {
  const p = app.project;
  const prev = app.cadencePromise || Promise.resolve();
  app.cadencePromise = prev.then(async () => {
    for (let k = 0; k < 4; k++) {
      const clips = p.clips;
      await analyzeCadence(p, clips);
      if (p.clips !== clips) continue; // the shots changed meanwhile: read the new ones
      if (cadenceGuard(p, { fluid: p.fluid !== false })) {
        app.depth.clear();
        // captions are laid out again around the new pictures, unless they've been edited by hand
        // (or by director notes) since they were placed: those edits aren't thrown away unasked
        if (app.lyrics && !app.captionEdits) placeAutoLyrics(false);
        if (p.auto.applied.length) ensureFxMasks();
        app.player.invalidate();
        app.changed();
      }
      return;
    }
  }).catch((e) => console.warn('[cadence] unavailable:', e));
  return app.cadencePromise;
}

// The editor's music analysis with its beat grid swapped for tracked beats and bars: the beat length
// from their median spacing, and the bar phase (four beats a bar) that lands on most tracked downbeats.
// (`beats: "double"` in the notes: the beat halved, for a rap or trap track the tracker hears at its
// half-time pulse when the edit should move on the double-time hats)
function withTrackedBeats(A, bt, double = false) {
  const beats = double ? bt.beats.flatMap((b, i, a) => (i + 1 < a.length ? [b, (b + a[i + 1]) / 2] : [b])) : bt.beats.slice(), ibi = beats.slice(1).map((b, i) => b - beats[i]).sort((a, b) => a - b), beatDur = ibi[ibi.length >> 1] || A.beatDur;
  let downPhase = 0, best = -1;
  for (let ph = 0; ph < 4; ph++) {
    let n = 0;
    for (let i = ph; i < beats.length; i += 4) if (bt.downbeats.some((d) => Math.abs(d - beats[i]) < beatDur * 0.25)) n++;
    if (n > best) { best = n; downPhase = ph; }
  }
  return { ...A, beats, beatDur, bpm: 60 / beatDur, downPhase, tracked: 'beat_this' };
}

// Drawing cadence: how many times a second each shot's picture really changes. Anime is drawn on
// ones (24 a second), twos (12) or threes (8), and holds; a 24 fps file says none of that. Read
// frame by frame at 64×36 from the source: a frame counts as a new drawing when it differs from
// the last by more than compression noise. Kept per source stretch, so a rebuild is instant.
const cadenceMemo = new Map();
const cadCanvas = document.createElement('canvas');
cadCanvas.width = 64; cadCanvas.height = 36;
const cadCtx = cadCanvas.getContext('2d', { willReadFrequently: true });
async function analyzeCadence(p, clips) {
  const sources = new Map();
  try {
    for (const c of clips) {
      const m = getMedia(p, c.mediaId);
      if (!m || m.kind !== 'video' || !m.fps || !(m.file || m.url)) continue;
      const span = Math.min(clipSpan(c), 3), key = `${m.fp || m.id}|${c.srcIn.toFixed(2)}|${span.toFixed(2)}`;
      if (!cadenceMemo.has(key)) {
        let src = sources.get(m.id);
        if (!src) { src = await openFrameSource(m); sources.set(m.id, src); }
        const n = Math.max(2, Math.floor(span * m.fps));
        let prev = null, changes = 0, pairs = 0;
        for (let k = 0; k < n; k++) {
          const fr = await src.frameAt(c.srcIn + (k + 0.5) / m.fps);
          if (!fr) continue;
          cadCtx.drawImage(fr, 0, 0, 64, 36);
          const d = cadCtx.getImageData(0, 0, 64, 36).data, lum = new Uint8Array(64 * 36);
          for (let i = 0; i < lum.length; i++) lum[i] = (d[i * 4] * 54 + d[i * 4 + 1] * 183 + d[i * 4 + 2] * 19) >> 8;
          if (prev) { let sum = 0; for (let i = 0; i < lum.length; i++) sum += Math.abs(lum[i] - prev[i]); pairs++; if (sum / lum.length > 1.5) changes++; }
          prev = lum;
        }
        const rate = pairs ? (changes / pairs) * m.fps : m.fps;
        cadenceMemo.set(key, { rate: +rate.toFixed(1), label: rate >= 18 ? 'ones' : rate >= 9 ? 'twos' : rate >= 5.5 ? 'threes' : 'held' });
      }
      c.cadence = cadenceMemo.get(key);
    }
  } finally { for (const s of sources.values()) s.close(); }
}

// ---------- match a reference edit ----------
const refInput = document.createElement('input');
refInput.type = 'file';
refInput.accept = 'video/*,.mov,.mp4,.webm';
refInput.hidden = true;
document.body.appendChild(refInput);
refInput.onchange = () => { if (refInput.files[0]) matchReference(refInput.files[0]); refInput.value = ''; };

function footageStats() {
  let l = 0, sa = 0, n = 0;
  for (const m of app.project.media) {
    const g = m.kind === 'video' && m.analysis && m.analysis.grid;
    if (!g) continue;
    for (let i = 0; i < g.lum.length; i++) { l += g.lum[i]; sa += g.sat ? g.sat[i] : 0.35; n++; }
  }
  const hv = app.project.media.find((m) => m.kind === 'video' && m.analysis && m.analysis.hue);
  return n ? { lum: l / n, sat: sa / n, hue: hv ? hv.analysis.hue : null } : { lum: 0.4, sat: 0.35, hue: null };
}

async function matchReference(file) {
  if (!app.plan) { toast('Add your footage first, then match a reference', true); return; }
  app.refBusy = 0;
  renderAI();
  try {
    app.referenceFile = file;
    const R = await analyzeReference(file, (x) => { app.refBusy = x; const b = document.getElementById('refProg'); if (b) b.style.width = Math.round(x * 100) + '%'; });
    app.reference = R;
    STYLES.match = styleFromReference(R, footageStats());
    const sel = $('#styleSel');
    let opt = sel.querySelector('option[value="match"]');
    if (!opt) { opt = document.createElement('option'); opt.value = 'match'; sel.appendChild(opt); }
    opt.textContent = '🎯 ' + STYLES.match.label;
    sel.value = 'match';
    app.opts.style = 'match';
    app.refBusy = null;
    regenerate({ restyle: true });
    toast(`Matched ${R.name}: ${R.shotMedian.toFixed(1)}s shots, ${R.flashRate < 0.15 ? 'no flashes' : 'flashes on hits'}, ${Math.round(R.duration)}s long`);
  } catch (e) {
    app.refBusy = null;
    toast('Could not read that reference: ' + e.message, true);
    renderAI();
  }
}

// Use the reference edit's own soundtrack for timing (e.g. a viral sound you'll
// pick again on Instagram).
async function useReferenceSong() {
  const f = app.referenceFile, p = app.project;
  if (!f) return;
  try {
    const m = { id: uid('m'), name: `Song from ${f.name}`, kind: 'audio', file: f, url: URL.createObjectURL(f), duration: 0, w: 0, h: 0, status: 'loading', analysis: null, audio: null };
    p.media.push(m);
    await decodeAudio(m);
    m.duration = m.audio.buffer.duration;
    m.status = 'ready';
    setMusic(m);
    renderMedia();
    toast('Cutting to the reference\'s song. Untick "Include the song" when exporting to add it on Instagram.');
    runAnalysis();
  } catch (e) { toast('That reference has no usable audio', true); }
}

function refSummary() {
  if (app.refBusy != null) return `<div class="ref-card"><b>🎯 Measuring the reference…</b><div class="bar" style="margin-top:6px"><i id="refProg" style="width:${Math.round(app.refBusy * 100)}%"></i></div></div>`;
  const R = app.reference;
  if (!R || app.opts.style !== 'match') return `<button class="btn small" id="refBtn" style="width:100%;margin-top:8px" title="Drop in an edit you like: the tool copies its pacing, color, flashes, layout and length">🎯 Match an edit you like…</button>`;
  const sw = STYLES.match.matchLook.duo.map((v) => Math.round(v * 255)).join(',');
  return `<div class="ref-card"><div style="display:flex;justify-content:space-between;align-items:center"><b>🎯 Matching ${esc(R.name.slice(0, 28))}</b><button class="link-btn" id="refClear">Stop matching</button></div>
    <div class="sd" style="margin-top:4px"><span class="ref-sw" style="background:rgb(${sw})"></span>${R.shotMedian.toFixed(1)}s shots · ${R.flashRate < 0.15 ? 'no flashes' : R.flashRate.toFixed(1) + ' flashes/s'} · ${Math.round(R.duration)}s · ${R.framed < 0.9 ? 'framed window' : 'full screen'}</div>
    <div style="display:flex;gap:12px;margin-top:4px"><button class="link-btn" id="refSong" title="Cut to the reference's own song. You can leave it out of the export and add it on Instagram.">♪ Use its song</button><button class="link-btn" id="refBtn">Use a different reference</button></div></div>`;
}

function autoEdit(skipHistory) {
  const p = app.project;
  if (!app.suggestions.length) return;
  if (!skipHistory) app.history.push();
  for (const s of app.suggestions) {
    const on = p.auto.applied.includes(s.id);
    if (s.recommended && !on) applySuggestion(p, s);
  }
  sortApplied();
  app.player.seek(0);
  app.changed();
  renderLook();
  ensureFxMasks();
  // fresh shots have no cadence read yet: read it, and take ramps off drawings on threes
  scheduleCadence();
}

function clearAuto() {
  const p = app.project;
  app.history.push();
  for (const id of [...p.auto.applied].reverse()) {
    const s = app.suggestions.find((x) => x.id === id);
    if (s) removeSuggestion(p, s);
  }
  p.auto.applied = [];
  app.changed();
  renderLook();
}

function toggleSuggestion(id, on) {
  const p = app.project, s = app.suggestions.find((x) => x.id === id);
  if (!s) return;
  app.history.push();
  if (on && s.layout) {
    for (const o of app.suggestions) if (o.layout && o.id !== s.id && p.auto.applied.includes(o.id)) removeSuggestion(p, o);
  }
  if (on) applySuggestion(p, s); else removeSuggestion(p, s);
  sortApplied();
  // camera aim, overlay checks and subtitle spots are worked out from the shots: redo them whenever
  // the shots or the effects that need them change
  if (s.clips || s.mod || ((id === 'fxboost' || id === 'camera' || id === 'vfx' || id === 'voicesubs' || id === 'glint') && on)) ensureFxMasks();
  if (s.clips || s.mod) scheduleCadence();
  if (s.clips) app.timeline.setZoom(0);
  app.changed();
  if (s.look || s.lookPreset) renderLook();
}

function sortApplied() {
  const order = app.suggestions.map((s) => s.id);
  app.project.auto.applied.sort((a, b) => order.indexOf(a) - order.indexOf(b));
}

// ---------- AI panel ----------
function renderAI() {
  const el = $('#aiPanel');
  const p = app.project, A = app.analysis;
  const hasVideo = p.media.some((m) => m.kind === 'video');
  let html = '';
  if (!hasVideo) {
    html = `<div class="ai-hero"><h3>Automatic anime edits</h3><p>Drop your unedited footage and a song. Sakuga detects the BPM, drops and energy of the track, scans your clips for scene cuts and motion, then builds a beat-synced edit with flashes, shakes, velocity ramps and color — and applies it for you.</p><button class="btn primary" id="aiAdd">Add footage &amp; song</button></div>
    <div class="sugg-group">What it can do</div>
    ${['✂ Cut to the beat, fastest motion on the drop', '⚡ Velocity ramps (Montage, Hero, Bullet…) + motion blur', '💥 Flash, shake, twitch, warp & impact frames', '❄ Freeze frame right before the drop', '◎ Zoom-blur, whip, spin & echo transitions', '🎨 Duotone looks, glow, sharpen, VHS, light leaks', '▣ Fill, framed, blur-fill or rotated 90° layouts', '𝐓 Word-by-word lyric captions on the beat'].map((t) => `<div class="sugg"><div class="si">${t.split(' ')[0]}</div><div class="sd" style="margin:6px 0 0">${esc(t.slice(t.indexOf(' ') + 1))}</div><div></div></div>`).join('')}`;
    el.innerHTML = html;
    $('#aiAdd').onclick = () => fileInput.click();
    return;
  }
  if (A.state === 'running' || A.state === 'error') {
    html += `<div class="ai-hero"><h3>${A.state === 'error' ? 'Analysis hit a problem' : 'Analyzing your media…'}</h3><p>${A.state === 'error' ? esc(A.error) : 'Listening to the song and watching your footage. Keep this tab in front — scanning pauses in background tabs.'}</p><div class="steps" id="aiSteps">${stepsHtml()}</div>${A.state === 'error' ? '<div class="ai-actions"><button class="btn small" id="aiRetry">Retry</button></div>' : ''}</div>`;
  }
  if (app.plan && A.state !== 'running') {
    const applied = p.auto.applied;
    const rec = app.suggestions.filter((s) => s.recommended);
    const allOn = rec.every((s) => applied.includes(s.id));
    const S = STYLES[app.plan.styleKey];
    html += `<div class="ai-hero"><h3>${applied.length ? 'Your edit is ready' : 'Suggestions ready'}</h3>
      ${songNote()}
      <p><b style="color:var(--text)">${esc(S.label)}</b> style${app.opts.style === 'auto' ? ` (auto-picked: ${esc(app.plan.why)})` : ''}. ${app.plan.clips.length} cuts over ${fmtTime(app.plan.L)}${p.music ? `, starting ${fmtTime(app.plan.win.start)} into the song` : ''}.</p>
      <button class="btn primary" id="aiAuto" ${allOn ? 'disabled' : ''}>${allOn ? '✓ All recommended edits applied' : `Auto-edit — apply ${rec.filter((s) => !applied.includes(s.id)).length} recommended`}</button>
      <div class="ai-actions">
        <button class="btn small" id="aiRegen" title="Rebuild with the current style, length and order">↻ Regenerate</button>
        <button class="btn small" id="aiClear" ${applied.length ? '' : 'disabled'}>Clear all</button>
        <select class="btn small" id="aiOrder" title="How footage is picked"><option value="story">Story order</option><option value="best">Best moments</option></select>
      </div>${refSummary()}</div>`;
    let group = '';
    for (const s of app.suggestions) {
      if (s.group !== group) { group = s.group; html += `<div class="sugg-group">${esc(group)}</div>`; }
      const on = applied.includes(s.id);
      html += `<div class="sugg ${on ? 'on' : ''}" data-id="${s.id}">
        <div class="si">${esc(s.icon)}</div>
        <div><div class="st">${esc(s.title)}${s.recommended ? '<span class="rec">rec</span>' : ''}</div><div class="sd">${esc(s.desc)}</div></div>
        <div class="side"><label class="switch"><input type="checkbox" ${on ? 'checked' : ''} data-toggle="${s.id}"><i></i></label><button class="jump" data-jump="${s.at}">▶ ${fmtTime(s.at)}</button></div>
      </div>`;
    }
  } else if (A.state === 'idle' && hasVideo) {
    html += `<div class="empty-note">Waiting for media…</div>`;
  }
  el.innerHTML = html;
  const q = (s) => el.querySelector(s);
  if (q('#aiRetry')) q('#aiRetry').onclick = runAnalysis;
  if (q('#aiAuto')) q('#aiAuto').onclick = () => autoEdit();
  if (q('#aiRegen')) q('#aiRegen').onclick = () => regenerate();
  if (q('#aiClear')) q('#aiClear').onclick = clearAuto;
  if (q('#refBtn')) q('#refBtn').onclick = () => refInput.click();
  if (q('#refSong')) q('#refSong').onclick = useReferenceSong;
  if (q('#refClear')) q('#refClear').onclick = () => { $('#styleSel').value = 'auto'; app.opts.style = 'auto'; regenerate({ restyle: true }); };
  if (q('#aiOrder')) { q('#aiOrder').value = app.opts.order; q('#aiOrder').onchange = (e) => { app.opts.order = e.target.value; regenerate(); }; }
  el.querySelectorAll('[data-toggle]').forEach((i) => { i.onchange = () => toggleSuggestion(i.dataset.toggle, i.checked); });
  el.querySelectorAll('[data-jump]').forEach((b) => { b.onclick = () => { app.player.seek(+b.dataset.jump); app.player.play(); }; });
}

function songNote() {
  const p = app.project;
  const m = p.music && getMedia(p, p.music.mediaId);
  if (!m) return `<p style="color:#fbbf24">No song: the edit is silent and has no drop. Drop a song in, or pick a built-in one in Media.</p>`;
  if (m.builtin) return `<p>Built on <b style="color:var(--text)">${esc(m.name)}</b> (built-in, CC BY). Drop your own song to replace it.</p>`;
  if (m.kind === 'video') return `<p style="color:#fbbf24">Built on the clip's own audio. For a real edit, drop a song in or pick a built-in one in Media.</p>`;
  return '';
}

function stepsHtml() {
  return app.analysis.steps.map((s) => `<div class="step ${s.state}"><span class="dot"></span><span>${esc(s.label)}</span><span class="pct">${s.state === 'active' && s.p ? Math.round(s.p * 100) + '%' : ''}</span>${s.state === 'active' ? `<div class="bar"><i style="width:${Math.round(s.p * 100)}%"></i></div>` : ''}</div>`).join('');
}

function renderAISteps() {
  const el = $('#aiSteps');
  if (el) el.innerHTML = stepsHtml();
}

// ---------- media panel ----------
function addOverlayFromMedia(m) {
  const p = app.project;
  p.overlays = p.overlays || [];
  app.history.push();
  const ov = {
    id: uid('ov'),
    mediaId: m.id,
    start: app.player.t,
    dur: Math.min(m.kind === 'image' ? 4 : (m.duration || 4), 4),
    srcIn: 0,
    speed: 1,
    x: 0.5,
    y: 0.5,
    scale: 1,
    rot: 0,
    opacity: 1,
    blend: 'screen',
    lumaKey: false,
    behind: false,
  };
  p.overlays.push(ov);
  app.select({ kind: 'ovl', id: ov.id });
  app.changed();
}

function renderMedia() {
  const p = app.project;
  const el = $('#mediaList');
  el.innerHTML = p.media.filter((m) => !m.builtin || (p.music && p.music.mediaId === m.id)).map((m) => {
    const isMusic = p.music && p.music.mediaId === m.id;
    const chips = [];
    if (m.status === 'loading') chips.push('<span class="chip busy">Loading…</span>');
    if (m.status === 'analyzing') chips.push(`<span class="chip busy" data-prog="${m.id}">Scanning ${Math.round((m.progress || 0) * 100)}%</span>`);
    if (m.status === 'error') chips.push(`<span class="chip err">${esc(m.error || 'Error')}</span>`);
    if (m.analysis) chips.push(`<span class="chip ok">${m.analysis.scenes.length} scenes</span>`);
    if (m.masks && m.masks.frames && m.masks.frames.size) chips.push('<span class="chip ok">🎭 matte</span>');
    if (isMusic) chips.push(`<span class="chip music">♪ Soundtrack${m.audio && m.audio.analysis ? ' · ' + Math.round(m.audio.analysis.bpm) + ' BPM' : ''}</span>`);
    const canMusic = !isMusic && m.status === 'ready' && (m.kind === 'audio' || m.kind === 'video');
    const canOvl = m.status === 'ready' && (m.kind === 'video' || m.kind === 'image');
    const subTxt = m.kind === 'video' ? (m.w ? `${m.w}×${m.h}` : 'video') : m.kind === 'image' ? (m.w ? `${m.w}×${m.h} image` : 'image') : m.guide ? 'tempo guide · plays here, never exported' : 'audio';
    return `<div class="media-item">
      <div class="thumb" style="${m.thumb ? `background-image:url(${m.thumb})` : ''}">${m.kind === 'audio' ? '♪' : ''}<span class="dur">${fmtTime(m.duration, false)}</span></div>
      <div class="meta"><div class="name" title="${esc(m.name)}">${esc(m.name)}</div>
        <div class="sub">${subTxt}</div>
        <div class="row">${chips.join('')}</div>
        <div class="row">${canOvl ? `<button class="link-btn" data-ovl="${m.id}" title="Add as layer on OVL track">+ OVL</button>` : ''}${canMusic ? `<button class="link-btn" data-music="${m.id}">Use as soundtrack</button>` : ''}${isMusic && !m.guide ? `<button class="link-btn" data-lyrics>${hasLyrics() ? 'Lyrics ✓' : 'Add lyrics'}</button>` : ''}${isMusic && !m.guide && m.audio ? (m.audio.full ? `<button class="link-btn" data-fullsong-off title="Matched at ${m.audio.full.offset.toFixed(1)} s into ${esc(m.audio.full.name)} (${Math.round(m.audio.full.score * 100)}% match)">Full quality ✓ · use the clip</button>` : `<button class="link-btn" data-fullsong title="Add a full download of this song: it's matched to the clip and plays and exports in its place, at its quality">Full-quality song…</button>`) : ''}<button class="link-btn" data-remove="${m.id}">Remove</button></div>
      </div></div>`;
  }).join('');
  el.querySelectorAll('[data-ovl]').forEach((b) => { b.onclick = () => { const m = getMedia(p, b.dataset.ovl); if (m) addOverlayFromMedia(m); }; });
  el.querySelectorAll('[data-remove]').forEach((b) => { b.onclick = () => removeMedia(b.dataset.remove); });
  el.querySelectorAll('[data-lyrics]').forEach((b) => { b.onclick = openLyrics; });
  el.querySelectorAll('[data-fullsong]').forEach((b) => {
    b.onclick = () => {
      const inp = document.createElement('input');
      inp.type = 'file'; inp.accept = 'audio/*,.m4a,.mp3,.flac,.wav,.aac,.ogg,.opus,.aiff';
      inp.onchange = async () => { const f = inp.files && inp.files[0]; if (!f) return; b.textContent = 'Matching…'; b.disabled = true; await useFullSong(f); renderMedia(); };
      inp.click();
    };
  });
  el.querySelectorAll('[data-fullsong-off]').forEach((b) => { b.onclick = dropFullSong; });
  if (p.media.some((m) => m.kind === 'video')) renderSongs();
  el.querySelectorAll('[data-music]').forEach((b) => {
    b.onclick = async () => {
      const m = getMedia(p, b.dataset.music);
      try {
        if (!m.audio) await decodeAudio(m);
        setMusic(m);
        renderMedia();
        if (!m.audio.analysis) runAnalysis(); else { await loadPhrases(m); regenerate(); }
      } catch (e) { toast(`${m.name} has no usable audio track`, true); }
    };
  });
}

function renderSongs() {
  const p = app.project;
  const cur = p.music && getMedia(p, p.music.mediaId);
  const html = `<div class="section-title">Built-in songs</div>
    <p class="hint" style="margin-bottom:8px">Royalty-free tracks by Kevin MacLeod (CC BY — credit him if you post). Your own song always works better for your vibe.</p>
    ${BUILTIN_TRACKS.map((t) => {
      const on = cur && cur.builtin === t.id;
      return `<div class="media-item"><div class="thumb">♪</div><div class="meta"><div class="name">${esc(t.title)}</div><div class="sub">${esc(t.vibe)}</div>
        <div class="row">${on ? '<span class="chip music">♪ In use</span>' : `<button class="link-btn" data-builtin="${t.id}">Use this song</button>`}</div></div></div>`;
    }).join('')}
    <div class="section-title" style="margin-top:14px">Song you'll add on Instagram</div>
    <p class="hint" style="margin-bottom:8px">No file needed. Enter the song's BPM (look it up on songbpm.com) and the edit is cut to its beat, with a click track standing in for the song. Then add the real song on Instagram.</p>
    <div class="field"><label>Song</label><input type="text" id="gTitle" placeholder="Song name" value="${esc((app.opts.guide && app.opts.guide.title) || '')}"></div>
    <div class="field-row">
      <div class="field"><label>BPM</label><input type="number" id="gBpm" min="50" max="220" step="0.1" value="${(app.opts.guide && app.opts.guide.bpm) || 120}"></div>
      <div class="field"><label>Big moment after</label><select id="gBars">${[1, 2, 3, 4].map((b) => `<option value="${b}" ${((app.opts.guide && app.opts.guide.introBars) || 2) === b ? 'selected' : ''}>${b} bar${b > 1 ? 's' : ''}</option>`).join('')}</select></div>
    </div>
    <div class="ai-actions"><button class="btn small primary" id="gUse">${cur && cur.guide ? 'Update tempo guide' : 'Build the edit on this tempo'}</button></div>`;
  let el = document.getElementById('songList');
  if (!el) {
    el = document.createElement('div');
    el.id = 'songList';
    el.className = 'media-list';
    $('#mediaList').after(el);
  }
  el.innerHTML = html;
  $('#gUse').onclick = () => {
    const bpm = parseFloat($('#gBpm').value);
    if (!(bpm >= 50 && bpm <= 220)) { toast('Enter a BPM between 50 and 220', true); return; }
    const m = useGuide({ title: $('#gTitle').value.trim(), bpm, introBars: +$('#gBars').value });
    toast(`Edit cut to ${m.guide.bpm} BPM. The big moment lands at ${fmtTime(m.guide.drop)}`);
  };
  el.querySelectorAll('[data-builtin]').forEach((b) => {
    b.onclick = async () => {
      const t = BUILTIN_TRACKS.find((x) => x.id === b.dataset.builtin);
      try {
        const m = await useBuiltin(t);
        if (!m.audio.analysis) runAnalysis(); else { await loadPhrases(m); regenerate(); }
      } catch (e) { toast(e.message, true); }
    };
  });
}

function renderMediaProgress(m) {
  const c = document.querySelector(`[data-prog="${m.id}"]`);
  if (c) c.textContent = `Scanning ${Math.round((m.progress || 0) * 100)}%`;
}

// ---------- effects / text / look panels ----------
const FX_KEYS = { flash: 'F', zoom: 'Z', shake: 'X', glitch: 'G', rgb: 'R', impact: 'I', twitch: 'T' };
let fxFilter = { q: '', cat: 'all' };
(() => {
  const grid = $('#fxGrid');
  if (!grid || !grid.parentElement) return;
  const bar = document.createElement('div');
  bar.innerHTML = `<div class="field" style="margin-bottom:6px"><input type="text" id="fxSearch" placeholder="Search effects… (whip, parallax, clone, lut)"></div><div id="fxCats" class="fx-cats"></div>`;
  grid.parentElement.insertBefore(bar, grid);
})();
function renderFxPalette() {
  const catsEl = $('#fxCats');
  if (catsEl) {
    const entries = [['all', 'All'], ...Object.entries(FX_CATEGORIES).map(([k, c]) => [k, c.label])];
    catsEl.innerHTML = entries.map(([k, l]) => `<button class="fx-cat-pill${fxFilter.cat === k ? ' active' : ''}" data-cat="${k}">${esc(l)}</button>`).join('');
    catsEl.querySelectorAll('[data-cat]').forEach((b) => { b.onclick = () => { fxFilter.cat = b.dataset.cat; renderFxPalette(); }; });
  }
  const q = (fxFilter.q || '').trim().toLowerCase();
  const allow = fxFilter.cat === 'all' ? null : new Set((FX_CATEGORIES[fxFilter.cat] || {}).types || []);
  $('#fxGrid').innerHTML = Object.entries(FX)
    .filter(([k, d]) => (!allow || allow.has(k)) && (!q || k.includes(q) || (d.label || '').toLowerCase().includes(q)))
    .map(([k, d]) => `<button class="tile" data-fx="${k}"><span class="ti" style="background:${d.color}">${d.icon}</span><span class="tn">${d.label}</span><span class="tk">${FX_KEYS[k] ? 'Key ' + FX_KEYS[k] : d.sustained ? 'Sustained' : d.dur + 's'}</span></button>`)
    .join('') || '<div class="empty-note">No matching effects.</div>';
}
if ($('#fxSearch')) $('#fxSearch').oninput = (e) => { fxFilter.q = e.target.value; renderFxPalette(); };
renderFxPalette();
$('#fxGrid').onclick = (e) => { const b = e.target.closest('[data-fx]'); if (b) addEffect(b.dataset.fx, app.player.t, true); };

$('#textGrid').innerHTML = Object.entries(TEXT_STYLES).map(([k, s]) => `<button class="tile" data-ts="${k}"><span class="sample" style="font-family:'${s.font}';font-weight:${s.weight};${s.stroke ? `-webkit-text-stroke:1px ${s.stroke};` : ''}${s.glow ? `text-shadow:0 0 10px ${s.glow};` : ''}">${k === 'jp' ? '最強' : 'Aa'}</span><span class="tn">${s.label}</span></button>`).join('');
$('#textGrid').onclick = (e) => { const b = e.target.closest('[data-ts]'); if (b) addText(b.dataset.ts); };

// ---------- sounds tab ----------
let sfxFilter = { q: '', tag: 'all' };
const SFX_TAGS = [['all', 'All'], ['whoosh', 'Whoosh'], ['swish', 'Swish'], ['transition', 'Transitions'], ['riser', 'Risers'], ['reverse', 'Reverse'], ['boom', 'Booms'], ['hit', 'Hits'], ['impact', 'Impacts'], ['slash', 'Slash'], ['clash', 'Clash'], ['explosion', 'Explosions'], ['magic', 'Magic'], ['charge', 'Charge'], ['energy', 'Energy'], ['lightning', 'Lightning'], ['fire', 'Fire'], ['wind', 'Wind'], ['glitch', 'Glitch'], ['shine', 'Shine'], ['pop', 'Pops'], ['click', 'Clicks'], ['shutter', 'Shutter'], ['crowd', 'Crowd'], ['voice', 'Voice'], ['body', 'Body'], ['step', 'Footsteps'], ['monster', 'Monster']];

function renderSounds() {
  const man = sfxManifest();
  const list = $('#sfxList');
  if (!man) { list.innerHTML = '<div class="empty-note">No sound packs found in sfx/.</div>'; return; }
  const have = new Set(man.sounds.flatMap((s) => s.tags));
  $('#sfxTags').innerHTML = SFX_TAGS.filter(([k]) => k === 'all' || have.has(k)).map(([k, l]) => `<button data-tag="${k}" class="${sfxFilter.tag === k ? 'on' : ''}">${l}</button>`).join('');
  $('#sfxTags').querySelectorAll('[data-tag]').forEach((b) => { b.onclick = () => { sfxFilter.tag = b.dataset.tag; renderSounds(); }; });
  const q = sfxFilter.q.toLowerCase();
  const items = man.sounds.filter((s) => (sfxFilter.tag === 'all' || s.tags.includes(sfxFilter.tag)) && (!q || s.name.toLowerCase().includes(q) || s.tags.some((t) => t.includes(q)) || s.cat.toLowerCase().includes(q)));
  list.innerHTML = items.slice(0, 800).map((s) => `<div class="sfx-row"><button class="play" data-play="${esc(s.id)}" title="Preview">▶</button><span class="nm" title="${esc(s.name)}">${esc(s.name)}</span><span class="du">${s.dur.toFixed(1)}s</span><button class="add" data-add="${esc(s.id)}" title="Add at the playhead (snaps to the beat)">+ Add</button></div>`).join('') || '<div class="empty-note">No sounds match.</div>';
  list.querySelectorAll('[data-play]').forEach((b) => { b.onclick = () => previewSfx(b.dataset.play); });
  list.querySelectorAll('[data-add]').forEach((b) => { b.onclick = () => addSfx(b.dataset.add, app.player.t); });
  const pk = man.packs || [];
  $('#sfxCredit').textContent = pk.length ? `${man.sounds.length} sounds, including synthesized effects and ${pk.map((x) => x.name).join(', ')}.` : 'Includes sounds synthesized in the editor.';
}
$('#sfxSearch').oninput = (e) => { sfxFilter.q = e.target.value; renderSounds(); };

function addSfx(id, t) {
  const p = app.project;
  if (!p.clips.length) { toast('Add footage first', true); return; }
  const tm = timelineMusic(p);
  if (app.snap && tm && tm.beats.length) {
    let best = null;
    for (const b of tm.beats) if (best == null || Math.abs(b - t) < Math.abs(best - t)) best = b;
    if (best != null && Math.abs(best - t) < 0.13) t = best;
  }
  app.history.push();
  p.sfx = p.sfx || [];
  // the sound's hit (its transient), not the start of the file, lands on the playhead / beat
  const x = { id: uid('sx'), sound: id, start: Math.max(0, t - ((sfxById(id) || {}).attack || 0)), vol: 0.7, src: 'manual' };
  p.sfx.push(x);
  loadSfx(id).then(() => { previewSfx(id); app.player.invalidate(); });
  app.select({ kind: 'sfx', id: x.id });
  app.changed();
}

function addEffect(type, t, select) {
  const p = app.project;
  if (!p.clips.length) return;
  const tm = timelineMusic(p);
  if (app.snap && tm && tm.beats.length) {
    let best = null;
    for (const b of tm.beats) if (!best || Math.abs(b - t) < Math.abs(best - t)) best = b;
    if (best != null && Math.abs(best - t) < 0.13) t = best;
  }
  const def = FX[type];
  let dur = def.dur;
  if (def.sustained) {
    const i = clipIndexAt(p.clips, t);
    if (i >= 0) { const c = p.clips[i]; dur = Math.max(0.5, c.start + c.dur - t); }
  }
  app.history.push();
  const e = { id: uid('fx'), type, start: Math.max(0, t), dur, params: defaultParams(type), src: 'manual' };
  p.effects.push(e);
  if (select) app.sel = { kind: 'fx', id: e.id };
  app.changed({ inspector: !!select });
  if (select) showTab('right', 'inspector');
  return e;
}

$('#lyricsStyle').innerHTML = ['minimal', 'outline', 'serif', 'impact', 'neon', 'subtitle'].map((k) => `<option value="${k}">${esc(TEXT_STYLES[k].label)}</option>`).join('');
$('#lyricsPlace').onclick = placeLyrics;
$('#lyricsClear').onclick = () => {
  if (!app.project.texts.some((t) => t.lyric)) return;
  app.history.push();
  app.project.texts = app.project.texts.filter((t) => !t.lyric);
  app.changed();
};

// Word-by-word (or line-by-bar) captions snapped to the beat grid, like viral lyric edits.
// ---------- auto-lyrics ----------
$('#autoLyricsStyle').innerHTML = ['minimal', 'serif', 'impact', 'outline', 'neon', 'subtitle'].map((k) => `<option value="${k}">${esc(TEXT_STYLES[k].label)}</option>`).join('');
$('#autoLyricsMode').onchange = (e) => { $('#autoLyricsStyle').disabled = e.target.value === 'kinetic'; if (app.lyrics) { app.history.push(); placeAutoLyrics(true); } };
$('#autoLyricsStyle').disabled = true;
$('#autoLyricsStyle').onchange = () => { if (app.lyrics) { app.history.push(); placeAutoLyrics(true); } };
$('#autoLyricsCuts').onchange = () => { if (app.lyrics) placeAutoLyrics(true); };
$('#autoLyricsDepth').onchange = () => { if (app.lyrics) { app.history.push(); placeAutoLyrics(true); } };
$('#autoLyricsGo').onclick = runAutoLyrics;
$('#autoLyricsFix').onclick = async () => {
  if (!app.lyrics) { toast('Transcribe the song first, then paste its lyrics', true); return; }
  if (!$('#autoLyricsPaste').value.trim()) { toast('Paste the lyrics into the box first', true); return; }
  await timeLyrics();
  app.history.push();
  placeAutoLyrics(true);
};
const lyrStatus = (t) => { $('#autoLyricsStatus').textContent = t; showLyricsFor(); };

// Save pasted lyrics under the song name in this browser.
const songKey = () => { const m = app.project.music && getMedia(app.project, app.project.music.mediaId); return m && !m.guide ? m.name.replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') : null; };
const songTitle = () => { const m = app.project.music && getMedia(app.project, app.project.music.mediaId); return m ? m.name.replace(/\.[^.]+$/, '') : ''; };
const LYR = 'sakuga-lyrics:';
let lyricsSaveT = 0, lyricsOwner = null;
app.lyricsFrom = null; // the song a match was found under, when it wasn't this one
function saveLyrics(k, text) {
  try { if (text.trim()) localStorage.setItem(LYR + k, text); else localStorage.removeItem(LYR + k); } catch (e) { /* storage off */ }
}
async function savedLyrics(k) {
  try { return foldLookalikes(localStorage.getItem(LYR + k) || ''); } catch (e) { return ''; }
}
// every song's saved lyrics, as [{ song, text }]
async function lyricsLibrary() {
  const all = new Map();
  try { for (let i = 0; i < localStorage.length; i++) { const key = localStorage.key(i); if (key.startsWith(LYR)) all.set(key.slice(LYR.length), localStorage.getItem(key)); } } catch (e) { /* storage off */ }
  return [...all].filter(([, t]) => t && t.trim()).map(([song, text]) => ({ song, text }));
}
// For a song with nothing saved under its name: the saved lyrics it actually sings, the closest
// match winning. Only on clear evidence: a good share of what was heard matches word for word, with
// a run of consecutive words in the lyrics' own order (another song shares common words, "I",
// "you", "love", but not whole phrases in a row).
async function findLyricsFor(words) {
  let best = null;
  const need = Math.min(6, Math.max(3, Math.round(words.length * 0.2)));
  for (const x of await lyricsLibrary()) {
    const fit = alignLyrics(words, x.text);
    if (!fit) continue;
    let exact = 0, run = 0, longest = 0;
    for (const w of fit) { if (w.exact) { exact++; longest = Math.max(longest, ++run); } else run = 0; }
    if (exact < words.length * 0.25 || longest < need) continue;
    if (!best || exact > best.exact) best = { ...x, exact, longest };
  }
  return best;
}
// lyrics found under another name are kept under this song's name too: instant next time
function adoptLyrics(k, found) {
  $('#autoLyricsPaste').value = foldLookalikes(found.text);
  lyricsOwner = k;
  app.lyricsFrom = found.song;
  saveLyrics(k, found.text);
  lyrStatus(`Found your lyrics saved for “${found.song}”: they match this song.`);
}
$('#autoLyricsPaste').addEventListener('input', () => {
  const k = songKey();
  if (!k) return;
  lyricsOwner = k;
  app.lyricsFrom = null;
  clearTimeout(lyricsSaveT);
  // (look-alike letters from another alphabet are put right as they're pasted)
  const box = $('#autoLyricsPaste'), folded = foldLookalikes(box.value);
  if (folded !== box.value) { const at = box.selectionStart; box.value = folded; box.selectionStart = box.selectionEnd = at; }
  const text = box.value;
  lyricsSaveT = setTimeout(() => {
    saveLyrics(k, text);
    lyrStatus(text.trim() ? `Saved for “${songTitle()}”: they fill in by themselves whenever this song is loaded.` : '');
  }, 600);
});
// (a declaration, and guarded: the media list can render before this part of the file has run)
function hasLyrics() {
  try { return !!songKey() && lyricsOwner === songKey() && !!$('#autoLyricsPaste').value.trim(); } catch (e) { return false; }
}
// which song the box is for, and the Lyrics button on the soundtrack
function showLyricsFor() {
  const k = songKey();
  $('#lyricsFor').textContent = k ? `For “${songTitle()}”. Paste them once: they're saved for this song and any clip of it.` : 'Load a song, then paste its lyrics here once.';
  const b = document.querySelector('#mediaList [data-lyrics]');
  if (b) b.textContent = hasLyrics() ? 'Lyrics ✓' : 'Add lyrics';
}
function openLyrics() {
  showTab('left', 'text');
  const box = $('#lyricsBox');
  $('#autoLyricsPaste').focus({ preventScroll: true });
  box.closest('.pane').scrollTop = 0; // the box is the first thing on the tab
  box.classList.remove('flash');
  void box.offsetWidth;
  box.classList.add('flash');
}
app.openLyrics = openLyrics;
async function loadSavedLyrics() {
  const k = songKey(), box = $('#autoLyricsPaste');
  showLyricsFor();
  if (!k) return;
  // a new song starts with a clean box (lyrics typed before any song was loaded go to the first one)
  if (lyricsOwner && lyricsOwner !== k) { box.value = ''; app.lyricsFrom = null; lyrStatus(''); }
  if (box.value.trim()) {
    if (!lyricsOwner) { lyricsOwner = k; saveLyrics(k, box.value); }
    return;
  }
  lyricsOwner = k;
  const text = await savedLyrics(k);
  if (songKey() !== k || box.value.trim()) return; // another song came in meanwhile, or you typed
  if (text) { box.value = text; lyrStatus(`Your saved lyrics for “${songTitle()}” are in.`); return; }
  // nothing under this name: words heard before (cached for this exact file) find a match now;
  // otherwise it's looked for once the song is transcribed
  const m = getMedia(app.project, app.project.music.mediaId), words = m && m.fp && (await cacheGet(m.fp, 'words'));
  const found = words && (await findLyricsFor(words));
  if (found && songKey() === k && !box.value.trim()) adoptLyrics(k, found);
}
app.loadSavedLyrics = loadSavedLyrics;

async function runAutoLyrics() {
  const p = app.project;
  const m = p.music && getMedia(p, p.music.mediaId);
  if (!m || !m.audio || !app.plan) { toast('Add footage and a song first', true); return; }
  app.lyricsError = null; app.instrumental = false;
  // (Cyrillic lyrics: the faces that lend the caption fonts their letters load first)
  await loadScriptFonts($('#autoLyricsPaste').value);
  const btn = $('#autoLyricsGo');
  btn.disabled = true;
  try {
    // transcribe the whole song once (word times are kept in song time)
    let words = await cacheGet(m.fp, 'words');
    if (!words) {
      words = await transcribeSong(m.audio.buffer, 0, m.audio.buffer.duration, lyrStatus);
      if (!words.length) {
        // nothing sung at all: an instrumental (see below)
        app.instrumental = !$('#autoLyricsPaste').value.trim();
        if (app.instrumental) { app.lyrics = null; p.texts = p.texts.filter((t) => !t.lyric); app.lyricsInfo = { instrumental: true, words: 0 }; app.changed(); }
        lyrStatus('No vocals found in this song: an instrumental, so no lyric captions.');
        return;
      }
      // every word onto the moment it's sung (Whisper's own times run a quarter second late)
      // (a fallback isn't kept: the timing model gets another go next time)
      try { words = await alignWordsToAudio(m.audio.buffer, words, lyrStatus); cachePut(m.fp, 'words', words); } catch (e) { console.warn('[lyrics] timing model unavailable:', e); words = unlagWords(words); }
    }
    // nothing in the box: your saved lyrics for this song under another name, if it sings them
    const k = songKey();
    if (k && !$('#autoLyricsPaste').value.trim()) { const found = await findLyricsFor(words); if (found) adoptLyrics(k, found); }
    // An instrumental: no lyrics given and hardly a word heard (a vocal chop, or the speech model
    // finding words in the music). It gets no lyric captions rather than a few wrong ones.
    const sung = words.filter((w) => /[\p{L}]/u.test(w.text)).length;
    app.instrumental = !$('#autoLyricsPaste').value.trim() && (sung < 8 || sung / m.audio.buffer.duration < 0.1);
    if (app.instrumental) {
      app.lyrics = null;
      p.texts = p.texts.filter((t) => !t.lyric);
      app.lyricsInfo = { instrumental: true, words: 0 };
      lyrStatus('An instrumental (no sung words to caption): no lyric captions.');
      app.changed();
      return;
    }
    app.lyrics = { mediaId: m.id, words };
    await timeLyrics();
    app.depth.clear();
    app.history.push();
    placeAutoLyrics(true);
  } catch (e) {
    console.error(e);
    app.lyricsError = String(e.message || e);
    lyrStatus('Could not transcribe: ' + app.lyricsError);
  } finally { btn.disabled = false; }
}

// Strong words go on screen with only their first and last letters, the rest starred, the way the
// user wants them written (N****S, S**T, F**K; the b-word, the c-word and the f-slur the same; the
// same words can be whispered in the song, tools/songfx.py --censor); milder language is written out.
const STARRED = [/^(n)[i1!](gg(?:a|ah|as|az|uh|er|ers|ahs)(?:'s)?)$/i, /^((?:mother)?f)u(ck[\w']*)$/i, /^((?:bull|horse)?sh)i(t[\w']*)$/i,
  /^(b)i(tch[\w']*)$/i, /^(c)u(nts?)$/i, /^(f)[a@](gs?|gg[o0]ts?)$/i];
function starWord(text) {
  const m = String(text).match(/^([^\p{L}\d]*)(.*?)([^\p{L}\d']*)$/u);
  if (!m) return text;
  // (the first and last letters kept, every one between starred: N****S, S**T, F**K, the user's
  // style since 2 Nov 2026)
  for (const re of STARRED) {
    if (!re.test(m[2])) continue;
    const w = m[2], last = w.search(/[\p{L}\d][^\p{L}\d]*$/u);
    return m[1] + w[0] + w.slice(1, last).replace(/[\p{L}\d]/gu, '*') + w.slice(last) + m[3];
  }
  return text;
}

// Captions start entering this long before their word is sung, and are fully up when it is.
const WORD_LEAD = 0.05;
// giant words take these in turn (the soft, printed colours of the reference lyric edits) until
// giantLayout gives them the edit's own palette
const GIANT_COLORS = ['#f4efe6', '#c9b8ff', '#9fe6d2', '#ff5a5f', '#ffd9a0', '#ff9ec7', '#a9c6ff'];
// small words that never fill the frame on their own
const MINOR_WORDS = new Set(['a', 'an', 'the', 'to', 'of', 'in', 'on', 'at', 'by', 'for', 'from', 'and', 'or', 'but', 'so', 'is', 'am', 'are', 'was', 'were', 'be', 'been', 'it', 'its', "it's", 'i', "i'm", 'me', 'my', 'we', 'us', 'our', 'you', 'your', "you're", 'he', 'she', 'they', 'them', 'their', 'his', 'her', 'him', 'that', 'this', 'these', 'those', 'with', 'as', 'if', 'up', 'do', 'did', 'does', "don't", 'got', 'get', 'just', 'like', 'all', 'no', 'not', 'yeah', 'oh', 'what', 'when', 'then', 'than', 'there', 'here', 'have', 'has', 'had', 'will', 'would', 'could', 'should', 'into', 'onto', 'about', 'some', 'only', 'gonna', "gon'", 'wanna', 'gotta']);

// Turn the transcribed words into captions for the current song window.
// `rebuild` re-cuts the edit on the words when "Cut on every word" is on.
function placeAutoLyrics(rebuild) {
  const p = app.project, L = app.lyrics;
  if (!L) return;
  if (!p.music || p.music.mediaId !== L.mediaId) {
    // the song changed (or went): its captions go with it
    if (p.texts.some((t) => t.lyric)) p.texts = p.texts.filter((t) => !t.lyric);
    return;
  }
  const mode = $('#autoLyricsMode').value;
  const wantCuts = mode === 'kinetic' && $('#autoLyricsCuts').checked;
  const cutKey = wantCuts ? 'words' : null;
  if (rebuild && (app.opts.cutKey || null) !== cutKey) {
    app.opts.cutKey = cutKey;
    app.opts.cutTimes = wantCuts ? lyricWords().words.map((w) => w.start) : null;
    regenerate(); // calls back into placeAutoLyrics(false)
    return;
  }
  const off = p.music.offset, end = timelineDuration(p);
  // under a voice intro the song is only a muffled bed: the lyrics start once it opens up
  const from = (p.voice && p.voice.end) || 0;
  const inWin = (w) => w.start - off >= from - 0.05 && w.start - off < end - 0.15;
  p.texts = p.texts.filter((t) => !t.lyric);
  app.captionEdits = false;
  const fixed = lyricWords();
  // (the strongest words starred, see STARRED)
  // (a cold open's lead, `lead` in the notes, has no singing in it: a word the timing pulled into
  // the bed before the song comes in starts with the song instead)
  const lead = Number(app.plan && app.plan.notes && app.plan.notes.lead) || 0;
  const words = fixed.words.filter(inWin).map((w) => { const t = starWord(w.text); const w2 = t === w.text ? w : { ...w, text: t }; return lead && w2.start < lead + 0.06 && w2.start > lead - 1.5 ? { ...w2, start: lead + 0.06, end: Math.max(w2.end, lead + 0.2), clamped: true } : w2; });
  // (a word the timing never heard, left far ahead of the heard word after it in the same line, was
  // pulled onto something else, an intro or a breath: it's sung just before that next word)
  for (let i = 0; i < words.length - 1; i++) {
    const w = words[i], nx = words[i + 1];
    // (a word the timing put before a cold open's song even comes in was misheard just the same)
    if ((!w.heard || w.clamped) && nx.heard && !nx.clamped && (w.line == null || w.line === nx.line) && nx.start - w.start > 0.9) words[i] = { ...w, start: nx.start - 0.42, end: nx.start - 0.04 };
  }
  app.lyricsInfo = { pasted: fixed.pasted, given: !!$('#autoLyricsPaste').value.trim(), from: app.lyricsFrom, note: fixed.note, words: words.length };
  const style = $('#autoLyricsStyle').value;
  const add = (text, a, b, extra) => p.texts.push({ id: uid('tx'), text, start: Math.max(0, a - off), dur: Math.max(0.15, Math.min(b, end + off) - a), style, size: TEXT_STYLES[style].size ?? 0.1, y: 0.5, color: '#ffffff', anim: 'fade', src: 'manual', lyric: true, ...extra });
  if (mode === 'build') {
    // styled after the romance and Blue Lock references: lines sit on the footage itself. Once the
    // characters are found, each line picks a spot around them (never on them, close to them, not
    // where the last lines were); until then, beside the action, alternating high and low.
    // voice lines woven into the edit (see placeVoices) join the lyric lines, in their speaker's colour;
    // any lyric line they'd land on gives way
    const voiceQs = p.clips.filter((c) => c.voiceLine && c.voiceLine.text).map((c) => {
      const v = c.voiceLine, ws = voiceWords(v, off);
      return { text: ws.map((w) => w.text).join(' '), start: ws[0].start, end: v.t1 + off, n: ws.length, ws, voice: v };
    }).filter((q) => q.ws.length);
    // (a lyric line gives way only to a voice line it really overlaps: a voice's tail touching a
    // line's first word costs nothing, dropping the whole line costs its words)
    const lls = lyricLines(words, fixed.pasted), keep = lls.filter((q) => !voiceQs.some((v) => Math.min(q.end, v.end) - Math.max(q.start, v.start) > 0.35));
    // (counted for the report: the words of a line that gave way aren't captioned at all)
    app.lyricsInfo.gaveWay = lls.filter((q) => !keep.includes(q)).map((q) => ({ at: +(q.start - off).toFixed(2), words: q.ws.length }));
    // (`text: { voice: "word" }` in the notes: a voice line shows one word at a time on the speaker's
    // face instead of building as a line, as the XP2 edits caption theirs)
    const tnotes = (app.plan && app.plan.notes && app.plan.notes.text) || {};
    if (tnotes.voice === 'word') {
      for (const q of voiceQs) placeVoiceWords(p, q, off);
      // (a line's last word holds a moment past its voice, but never into the next line's first
      // word: "SO" came up over "EXTRACTION.")
      const vw = p.texts.filter((t) => t.voice).sort((a, b) => a.start - b.start);
      for (let i = 0; i + 1 < vw.length; i++) if (vw[i].start + vw[i].dur > vw[i + 1].start - 0.02) vw[i].dur = Math.max(0.12, vw[i + 1].start - 0.02 - vw[i].start);
    }
    const ph = [...keep, ...(tnotes.voice === 'word' ? [] : voiceQs)].sort((a, b) => a.start - b.start);
    const depthOn = $('#autoLyricsDepth').checked;
    // settles once the characters are found and the key words placed (the studio runner waits on it)
    app.depthPromise = new Promise((res) => setTimeout(() => findCharacters(ph, depthOn).finally(res), 0));
    const recent = [];
    const { w: fw, h: fh } = formatSize(p);
    const box = pictureBox(p);
    const bh = (box.bottom - box.top) * fh;
    // small enough to leave the scene readable: about 6% of the picture's height
    const base = Math.min(0.058 * bh, 0.036 * fw) / fw;
    const tm = timelineMusic(p);
    // the accent goes on the longest-held real word: first words often come back stretched
    // and short filler words ("so", "and") don't carry a line, so later, longer words win
    const weight = (w, i) => (w.end - w.start) * (1 + 0.15 * i);
    // (never a function word: "and" doesn't carry a line; with nothing else, the last word does)
    const pickHot = (ws) => {
      const bare = (w) => w.text.replace(/[^\p{L}']/gu, '').toLowerCase();
      const real = ws.map((w, i) => ({ w, i })).filter(({ w, i }) => i > 0 && w.text.replace(/[^\p{L}]/gu, '').length >= 4 && !MINOR_WORDS.has(bare(w)));
      const content = ws.map((w, i) => ({ w, i })).filter(({ w, i }) => i > 0 && !MINOR_WORDS.has(bare(w)));
      const pool = real.length ? real : content.length ? content : [{ w: ws[ws.length - 1], i: ws.length - 1 }];
      return pool.reduce((a, b) => (weight(b.w, b.i) >= weight(a.w, a.i) ? b : a)).w;
    };
    let short = 0;
    ph.forEach((q, i) => {
      const hot = q.ws.length > 1 ? pickHot(q.ws) : q.ws[0];
      let b = Math.min(ph[i + 1] ? ph[i + 1].start - 0.02 : q.end + 0.8, q.end + 0.8);
      // a line that would run on a moment past a cut ends with the cut, once its last word has had
      // its time: the next shot opens clean instead of with the line still sitting over it (over
      // its subject, often a face, since the spot was picked for the shot before)
      const lw = q.ws[q.ws.length - 1];
      const cut = p.clips.map((c) => c.start + off).find((c) => c > Math.max(q.start + 0.6, lw.start + 0.35, (lw.end ?? lw.start) + 0.05) && c < b && b - c <= 0.4);
      if (cut != null) b = cut;
      // the last word stays up long enough to read (a third of a second), even if that overlaps the
      // next line's first moment: in a fast verse the next line starts the instant this one's last
      // word is sung, and the word used to vanish as it arrived
      b = Math.max(b, Math.min(lw.start + 0.34, ph[i + 1] ? ph[i + 1].start + 0.28 : lw.start + 0.34));
      // what the depth search needs to measure this line's key word
      q.hotAt = hot.start;
      q.hotText = hot.text;
      q.hotIdx = q.ws.indexOf(hot);
      const ta = q.start - off, tb = b - off, th = hot.start - off; // timeline times
      // neon tubes need a dark scene to glow against: over a bright shot (a sunlit face, the white
      // of an eye filling the frame) their pale cores vanish, so those lines take the caps look
      const bright = () => {
        let n = 0, hi = 0;
        for (let t = ta + 0.05; t < tb; t += 0.1) {
          const at = srcAt(p, t), g = at && at.m.analysis && at.m.analysis.grid;
          if (!g || !g.lum) continue;
          n++;
          if (g.lum[Math.max(0, Math.min(g.lum.length - 1, Math.round(at.s * g.rate)))] > 0.5) hi++;
        }
        return n ? hi / n : 0;
      };
      // soft styles keep the romance edit's serif lines throughout (bold caps only where a scene hits)
      const soft = app.plan && app.plan.S && app.plan.S.kit === 'soft';
      // (pro: two looks only, serif and caps, so the type reads as one system in the edit's palette)
      const pro = !!(p.auto && p.auto.ctx && p.auto.ctx.pro);
      const lookOf = (en) => (en === 'drift' || (soft && en !== 'slam') ? 'serif' : en === 'slam' && bright() < 0.2 && !pro ? 'neon' : 'caps');
      q.look = lookOf(sceneEntrance(sceneAt(p, ta, Math.min(tb, ta + 1.2))));
      q.base = base;
      q.hotMul = pro ? 1.45 : 1;
      q.depthScale = 1.1;
      const sc = sceneAt(p, ta, Math.min(tb, ta + 1.2));
      const enter = sceneEntrance(sc);
      let place;
      const sx = subjectX(p, ta, tb);
      const dep = depthOn && app.depth.get(lineKey(q));
      const depth = !!(dep && dep.place);
      // cinema bars on screen during the line are off-limits: the visible band, in picture coordinates
      const pb = box.bottom - box.top;
      const bars = Math.max(0, ...p.effects.filter((e) => e.type === 'letterbox' && e.start < tb && e.start + e.dur > ta).map((e) => (e.params.intensity ?? 1) * 0.13));
      const vis = { top: Math.max(0, (bars + 0.01 - box.top) / pb), bottom: Math.min(1, (1 - bars - 0.01 - box.top) / pb) };
      const inVis = (y) => vis.top + y * (vis.bottom - vis.top);
      const smart = !depth && smartPlace(p, q, ta, tb, q.look, base, recent, vis);
      if (depth) {
        // the spot where the character covers part of the key word (but never most of it) all line
        // long, at the size the search found works
        place = { x: dep.place.x, align: 'center', y: dep.place.y, id: 'depth' };
        q.depthScale = 1.1 * (dep.place.scale || 1);
      } else if (smart) {
        place = smart;
      } else if (q.ws.length >= 4) {
        // long lines centre, unless the character is clearly on one side: then the free side
        place = sx < 0.38 ? { x: 0.94, align: 'right', y: inVis(0.6), id: 'mr' } : sx > 0.62 ? { x: 0.06, align: 'left', y: inVis(0.6), id: 'ml' } : { x: 0.5, align: 'center', y: inVis(0.62), id: 'c' };
      } else {
        const side = sx < 0.45 ? 'right' : sx > 0.55 ? 'left' : short % 2 ? 'right' : 'left';
        place = { x: side === 'left' ? 0.06 : 0.94, align: side, y: inVis(q.ws.length === 1 ? 0.5 : short % 2 ? 0.68 : 0.32), id: side[0] + (short % 2 ? 'b' : 't') };
        short++;
      }
      recent.unshift(place.id);
      // centred lines and long ones sit smaller so they don't take over the shot; a word going behind
      // a character keeps a little more size so the effect reads
      const sizeK = depth ? q.depthScale || 1 : (['c', 'tc', 'bc'].includes(place.id) ? 0.82 : 1) * (q.ws.length >= 5 ? 0.88 : 1);
      // words start their entrance 0.05 s early so they're fully up on the syllable (every look
      // reaches full opacity 0.05 s in), not fading in after it
      const lead = WORD_LEAD;
      // colour comes from the shot the big key word lands in (lines often cross a cut)
      const scHot = sceneAt(p, th, Math.min(tb, th + 0.8)) || sc;
      add(q.text, q.start - lead, b, {
        words: q.ws.map((w) => ({ text: w.text, t: Math.max(0, w.start - q.start), hot: w === hot })),
        // calm scenes read like the romance edit, action like the Blue Lock edit; the key word
        // gets its own big row and pulses on the song's beats
        look: q.look, lockup: true, depth, hotMul: q.hotMul, neon: q.look === 'neon' ? neonPalette(scHot) : undefined, depthSpans: depth ? dep.place.spans.map(([a2, b2]) => [a2 + lead, b2 + lead]) : undefined,
        beats: tm ? tm.beats.filter((t) => t > ta && t < tb).map((t) => t - ta + lead) : [],
        size: base * sizeK, x: place.x, align: place.align, y: box.top + place.y * pb, box: [box.top + vis.top * pb, box.top + vis.bottom * pb],
        ...(q.voice ? { color: mixHex(q.voice.color, '#ffffff', 0.55), accent: q.voice.color, glow: q.voice.color, speechEnd: q.voice.t1 } : paletteColors(p) || sceneColors(scHot, q.look === 'serif' ? 'serif' : 'caps')), voice: !!q.voice, enter, anim: 'none',
      });
    });
    // and their own spots in a pro edit's full-frame vertical copy (the studio runner waits on this)
    app.tallPromise = new Promise((res) => setTimeout(() => tallLayout().finally(res), 0));
  } else if (mode === 'giant') {
    // the reference lyric edits: one giant word at a time, on its syllable, each in its own colour,
    // behind the character when one's in frame (short words like "a" and "I" stay in front)
    const depthOn = $('#autoLyricsDepth').checked;
    let k = 0;
    // a word sung too quick to read on its own (the next one comes within three frames) shares its
    // caption with the next, up to three words, rather than flickering past
    const groups = [];
    for (const w of words) {
      const word = w.text.replace(/[.,!?;:"“”()]+/g, '');
      if (!word) continue;
      const g = groups[groups.length - 1];
      if (g && g.n < 3 && w.start - g.start < 0.12) { g.text += ' ' + word; g.end = w.end; g.n++; g.line = w.line; } else groups.push({ text: word, start: w.start, end: w.end, n: 1, line: w.line });
    }
    groups.forEach((w, i) => {
      // (gone as the next word comes in, which is a lead before it's sung: never two at once)
      const next = groups[i + 1] ? groups[i + 1].start - WORD_LEAD : w.end + 0.5;
      const b = Math.max(Math.min(next, w.start + 1.2, Math.max(w.end + 0.3, w.start + 0.3)), Math.min(next, w.start + 0.25));
      // a strong word (a real word of four letters or more, or the word a line lands on) can fill
      // the frame; giantLayout places them all once the characters are found
      const lineEnd = w.line != null && (!groups[i + 1] || groups[i + 1].line !== w.line) && w.text.length >= 3;
      const strong = w.n === 1 && (lineEnd || (w.text.replace(/[^\p{L}]/gu, '').length >= 4 && !MINOR_WORDS.has(w.text.toLowerCase())));
      add(w.text, w.start - WORD_LEAD, b, { style: 'giant', size: 0.3, color: GIANT_COLORS[k++ % GIANT_COLORS.length], behind: false, strong, anim: 'none', y: 0.5 });
    });
    // fast verses: a word sung quicker than a caption's shortest stay is cut off by the next one
    // (a hard swap, never two words at once), and one followed straight away doesn't fade out
    const gs = p.texts.filter((t) => t.style === 'giant' && t.lyric).sort((a, c) => a.start - c.start);
    gs.forEach((t, i) => {
      const n = gs[i + 1];
      if (!n) return;
      if (t.start + t.dur > n.start) t.dur = Math.max(0.04, n.start - t.start);
      t.cut = n.start - (t.start + t.dur) < 0.05;
    });
    // laid out round the characters once they're found (the studio runner waits on this)
    app.depthPromise = new Promise((res) => setTimeout(() => giantLayout(depthOn).finally(res), 0));
  } else if (mode === 'phrase') {
    const ph = phrases(words);
    ph.forEach((q, i) => add(q.text, q.start, Math.min(ph[i + 1] ? ph[i + 1].start : q.end + 0.6, q.end + 0.6), {}));
  } else {
    words.forEach((w, i) => {
      const next = words[i + 1] ? words[i + 1].start : w.end + 0.4;
      const b = Math.min(next, w.start + 1.6, Math.max(w.end + 0.25, w.start + 0.25));
      if (mode === 'kinetic') {
        const f = KINETIC_FONTS[i % KINETIC_FONTS.length];
        add(w.text.replace(/[.,!?;:]+$/, ''), w.start - WORD_LEAD, Math.max(b, Math.min(next, w.start + 0.5)), { style: 'kinetic', size: 0.2, font: f.font, weight: f.weight, italic: !!f.italic, color: KINETIC_COLORS[i % KINETIC_COLORS.length], anim: i % 3 === 0 ? 'slam' : 'pop' });
      } else add(w.text, w.start - WORD_LEAD, b, {});
    });
  }
  lyrStatus(`${words.length} words on screen${fixed.note}${wantCuts ? ', cutting on every word' : ''}. Tweak any caption on the Text track.`);
  app.changed();
}

// The words to caption: pasted lyrics snapped onto the heard timing when given.
// Corrections to misheard words from the director notes ({ "them": "her" }, "" drops a word):
// the heard word keeps its timing and capitals, only its spelling changes.
function fixHeard(words) {
  const fx = app.opts.notes && app.opts.notes.fix;
  if (!fx || !Object.keys(fx).length) return words;
  const map = new Map(Object.entries(fx).map(([a, b]) => [a.toLowerCase(), String(b)]));
  return words.flatMap((w) => {
    const m = w.text.match(/^([^\p{L}\p{N}]*)([\p{L}\p{N}']+)(.*)$/u), to = m && map.get(m[2].toLowerCase());
    if (to == null) return [w];
    if (!to) return [];
    const cap = m[2][0] !== m[2][0].toLowerCase();
    return [{ ...w, text: m[1] + (cap ? to[0].toUpperCase() + to.slice(1) : to) + m[3] }];
  });
}

// Pasted lyrics timed to the vocals letter by letter (so even the words Whisper missed land on
// their syllable, not spread evenly between their neighbours); kept per song and lyrics.
const lyricsKey = (raw) => { let h = 0x811c9dc5; for (let i = 0; i < raw.length; i++) { h ^= raw.charCodeAt(i); h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(16); };
// (with the aligner's version, so a change to the aligner times every song again, once: the timing
// is cached by its lyrics, and a fix that only changes how they're matched never reached a song
// timed before it, as "6ix" didn't; bump ALIGN_VERSION with any change to alignLyrics or the letter aligner)
const ALIGN_VERSION = 5;
const timedKey = (raw) => lyricsKey(raw) + 'a' + ALIGN_VERSION;
async function timeLyrics() {
  const L = app.lyrics, raw = $('#autoLyricsPaste').value.trim();
  const m = L && getMedia(app.project, L.mediaId);
  if (!m || !m.audio || !raw) return;
  const key = timedKey(raw);
  if (app.lyricsTimed && app.lyricsTimed.mediaId === L.mediaId && app.lyricsTimed.key === key) return;
  let timed = await cacheGet(m.fp, 'lyrtimes', key);
  if (!timed) {
    const runs = await vocalRuns(m.audio.buffer).catch(() => null);
    const al = alignLyrics(L.words, raw, runs);
    if (!al) return;
    try { timed = await alignWordsToAudio(m.audio.buffer, al, lyrStatus); cachePut(m.fp, 'lyrtimes', timed, key); } catch (e) { console.warn('[lyrics] timing model unavailable:', e); timed = unlagWords(al); }
  }
  app.lyricsTimed = { mediaId: L.mediaId, key, words: timed };
}

function lyricWords() {
  const L = app.lyrics, raw = $('#autoLyricsPaste').value.trim();
  if (!raw) return { words: fixHeard(L.words), pasted: false, note: '' };
  const T = app.lyricsTimed, timed = T && T.mediaId === L.mediaId && T.key === timedKey(raw) ? T.words : null;
  const words = timed || alignLyrics(L.words, raw);
  if (!words) { toast("Those lyrics don't match what's sung in this clip, so the heard words are kept", true); return { words: fixHeard(L.words), pasted: false, note: '' }; }
  const heard = words.filter((w) => w.heard).length;
  return { words, pasted: true, note: ` from your lyrics (${heard} timed from the song, ${words.length - heard} filled in)` };
}

// Caption lines: the pasted lyrics' own lines when given (long ones split in two), otherwise
// phrases from pauses and punctuation. A line too quick to read joins the next one.
function lyricLines(words, pasted) {
  let ph;
  if (pasted) {
    ph = [];
    for (const w of words) {
      const last = ph[ph.length - 1];
      if (last && last.line === w.line) last.ws.push(w); else ph.push({ line: w.line, ws: [w] });
    }
    ph = ph.flatMap((q) => (q.ws.length > 6 ? [q.ws.slice(0, Math.ceil(q.ws.length / 2)), q.ws.slice(Math.ceil(q.ws.length / 2))] : [q.ws]))
      .map((ws) => ({ text: ws.map((w) => w.text).join(' '), start: ws[0].start, end: ws[ws.length - 1].end, n: ws.length, ws }));
  } else ph = sentenceLines(words);
  for (let i = 0; i < ph.length - 1; i++) {
    const q = ph[i], n = ph[i + 1];
    if (n.start - q.start < 0.5 && q.ws.length + n.ws.length <= 7) {
      ph.splice(i, 2, { text: q.text + ' ' + n.text, start: q.start, end: n.end, n: q.n + n.n, ws: [...q.ws, ...n.ws] });
      i--;
    }
  }
  return ph;
}

// ---------- FX boost: where the characters are ----------
// FX boost enhances the effects and background around the characters, not the characters
// themselves, so it needs their outline in every shot: coarse masks, 10 a second, across the edit.
// The camera director's follow and push-in shots use the same outlines to frame the character.
let fxRun = 0;
function ensureFxMasks() {
  const p = app.project;
  if (!p.auto.applied.includes('fxboost') && !p.effects.some((e) => e.type === 'camera' || e.type === 'glint')) return null;
  const run = ++fxRun;
  app.fxPrep = (async () => {
    const end = timelineDuration(p), byMedia = new Map();
    for (let t = 0.05; t < end; t += 0.1) { const at = srcAt(p, t); if (at) { if (!byMedia.has(at.m)) byMedia.set(at.m, []); byMedia.get(at.m).push(at.s); } }
    try {
      for (const [m, ts] of byMedia) { await segmentTimes(m, ts); if (run !== fxRun) return; }
      // push-ins and the ladder aim at a face: find faces (or heads) through those shots
      const want = new Map();
      for (const e of p.effects) {
        // (eye glints sit on the eyes, so they need the faces too)
        if (e.type !== 'glint' && (e.type !== 'camera' || (e.params.mode !== 'push' && e.params.mode !== 'ladder' && e.params.mode !== 'glide'))) continue;
        // (glints follow the eyes frame to frame: every face sample through the shot, even one
        // playing fast, where a step of 0.1 s on the timeline skips samples in the source)
        const step = e.type === 'glint' ? 0.03 : 0.1;
        for (let t = e.start + 0.01; t < e.start + e.dur; t += step) { const at = srcAt(p, t); if (at) { if (!want.has(at.m)) want.set(at.m, []); want.get(at.m).push(at.s); } }
      }
      try { for (const [m, ts] of want) { await detectFaces(m, ts); if (run !== fxRun) return; } }
      catch (e) { console.warn('[camera] face detection unavailable:', e); }
      trackCameras();
      refineOverlays();
      placeSubtitles();
      app.player.invalidate();
      saveOutlines();
    } catch (e) { console.warn('[fx boost] character outlines unavailable:', e); }
  })();
  return app.fxPrep;
}
app.ensureFxMasks = ensureFxMasks;

// Voice-intro subtitles sit by whoever speaks, like the reference ("Ichigo!!" just above Rukia's
// head): once the character outlines are known, each subtitle takes the spot that stays clear of
// the characters the whole time it's up, as close above or beside the head as it can, with the
// bottom of the frame as the fallback.
function placeSubtitles() {
  const p = app.project, { w: W, h: H } = formatSize(p);
  const subs = p.texts.filter((t) => t.style === 'dialogue' && !t.placedByHand);
  if (!subs.length) return;
  measureCtx.font = `600 ${Math.round(0.036 * W)}px Poppins, Montserrat, Inter, sans-serif`;
  for (const t of subs) {
    const size = t.size || 0.036, tw = Math.min(0.5, measureCtx.measureText(t.text).width / W * (size / 0.036)), th = size * 1.25 * (W / H);
    // the characters on screen during the line, in output coordinates (fill layout)
    const frames = [];
    for (let tt = t.start + 0.05; tt < t.start + t.dur; tt += 0.2) {
      const f = frameParams(p, tt, W, H), m = f.media, mk = f.clip && maskAt(m, f.srcTime);
      if (!mk) continue;
      frames.push({ mk, f });
    }
    if (!frames.length) continue;
    const covered = (x0, y0, x1, y1) => {
      let s = 0, n = 0;
      for (const { mk, f } of frames) {
        const [cx, cy] = f.center, [rw, rh] = f.region, span = (mk.bottom ?? 1) - (mk.top ?? 0);
        for (let y = y0; y <= y1; y += (y1 - y0) / 5) for (let x = x0; x <= x1; x += (x1 - x0) / 9) {
          const sx = cx - rw / 2 + x * rw, sy = cy - rh / 2 + y * rh, my = (sy - (mk.top ?? 0)) / span;
          if (sx < 0 || sx > 1 || my < 0 || my > 1) continue;
          s += mk.data[Math.min(mk.h - 1, Math.floor(my * mk.h)) * mk.w + Math.min(mk.w - 1, Math.floor(sx * mk.w))] > 127; n++;
        }
      }
      return n ? s / n : 0;
    };
    // where the speaker's head is: the top of the outline in the first frame, at its widest column
    const { mk: m0, f: f0 } = frames[0];
    let headX = 0.5, headY = 0.3;
    {
      const span = (m0.bottom ?? 1) - (m0.top ?? 0);
      outer: for (let yy = 0; yy < m0.h; yy++) for (let xx = 0; xx < m0.w; xx++) if (m0.data[yy * m0.w + xx] > 127) {
        const sx = xx / m0.w, sy = (m0.top ?? 0) + (yy / m0.h) * span;
        headX = clamp((sx - (f0.center[0] - f0.region[0] / 2)) / f0.region[0], 0, 1);
        headY = clamp((sy - (f0.center[1] - f0.region[1] / 2)) / f0.region[1], 0, 1);
        break outer;
      }
    }
    const spots = [];
    for (const y of [0.13, 0.2, 0.3, 0.82, 0.88]) for (const [x, align] of [[0.06, 'left'], [0.5, 'center'], [0.94, 'right'], [headX, 'center']]) spots.push({ x, y, align });
    let best = null;
    for (const sp of spots) {
      const x0 = sp.align === 'left' ? sp.x : sp.align === 'right' ? sp.x - tw : sp.x - tw / 2, x1 = x0 + tw;
      if (x0 < 0.03 || x1 > 0.97) continue;
      const y0 = sp.y - th / 2, y1 = sp.y + th / 2;
      const cov = covered(x0, y0, x1, y1);
      const near = Math.hypot((x0 + x1) / 2 - headX, sp.y - (headY - 0.06));
      const score = cov * 6 + near * 0.8 + (sp.y > 0.5 ? 0.25 : 0);
      if (!best || score < best.score) best = { score, ...sp };
    }
    if (best) Object.assign(t, { x: best.x, y: best.y, align: best.align });
  }
}

// keep the character outlines and faces found so far for next time (they take the longest to find)
function saveOutlines() {
  for (const m of app.project.media) {
    if (m.kind !== 'video' || !m.fp) continue;
    if (m.masks && (m.masks.frames.size || (m.masks.fine && m.masks.fine.size))) cachePut(m.fp, 'masks', m.masks);
    if (m.faces && m.faces.size) cachePut(m.fp, 'faces', m.faces);
  }
}

// ---------- camera director: framing the character ----------
// Where the camera aims in one outline: for a follow cam, between the character's middle and
// their head (so a jump or a cheer stays framed); for a push-in, their face. In source picture
// coordinates (0..1), or null when nobody is there.
function subjectAim(m, mode) {
  if (!m) return null;
  const { w, h, data } = m, top0 = m.top ?? 0, span = (m.bottom ?? 1) - top0;
  const gw = w >> 1, gh = h >> 1, on = new Uint8Array(gw * gh);
  let n = 0;
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) if (data[y * 2 * w + x * 2] > 127) { on[y * gw + x] = 1; n++; }
  if (n / (gw * gh) < 0.012) return null;
  if (mode === 'push') {
    // a push-in aims at one face, the biggest character's, never the gap between two of them
    const lab = new Int32Array(gw * gh), stack = new Int32Array(gw * gh);
    let id = 0, best = 0, bestN = 0;
    for (let s0 = 0; s0 < on.length; s0++) {
      if (!on[s0] || lab[s0]) continue;
      id++;
      let top = 0, cnt = 0;
      stack[top++] = s0; lab[s0] = id;
      while (top) {
        const i = stack[--top], x = i % gw;
        cnt++;
        if (x > 0 && on[i - 1] && !lab[i - 1]) { lab[i - 1] = id; stack[top++] = i - 1; }
        if (x < gw - 1 && on[i + 1] && !lab[i + 1]) { lab[i + 1] = id; stack[top++] = i + 1; }
        if (i >= gw && on[i - gw] && !lab[i - gw]) { lab[i - gw] = id; stack[top++] = i - gw; }
        if (i < on.length - gw && on[i + gw] && !lab[i + gw]) { lab[i + gw] = id; stack[top++] = i + gw; }
      }
      if (cnt > bestN) { bestN = cnt; best = id; }
    }
    for (let i = 0; i < on.length; i++) on[i] = lab[i] === best ? 1 : 0;
    var solo = bestN / n >= 0.65; // one character clearly owns the frame
  }
  let c = 0, sx = 0, sy = 0, y0 = gh, y1 = -1;
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) if (on[y * gw + x]) { c++; sx += x; sy += y; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  // the head end: the top quarter of the outline. Two heads up there (characters touching, so
  // one outline) → the one with the most of the outline under it, not the gap between them
  const band = y0 + Math.max(1, (y1 - y0) * 0.25), col = new Float32Array(gw);
  for (let y = y0; y <= band; y++) for (let x = 0; x < gw; x++) if (on[y * gw + x]) col[x]++;
  let run = null, best = null, gap = 0;
  for (let x = 0; x <= gw; x++) {
    if (x < gw && col[x] > 0) { if (!run) run = { n: 0, sx: 0 }; run.n += col[x]; run.sx += col[x] * x; gap = 0; }
    else if (run && (++gap > gw * 0.03 || x === gw)) { if (!best || run.n > best.n) best = run; run = null; }
  }
  const hn = best ? best.n : 0, hx = best ? best.sx : 0;
  const cx = sx / c / gw, cy = sy / c / gh, headX = hn ? hx / hn / gw : cx, top = y0 / gh, bot = y1 / gh;
  const ax = mode === 'push' ? headX : (cx + headX) / 2;
  const ay = mode === 'push' ? top + (bot - top) * 0.22 : (cy + top + (bot - top) * 0.3) / 2;
  return { x: ax, y: top0 + ay * span, solo: mode === 'push' ? solo : true };
}

// The camera's aim through a shot, 10 samples a second: gaps filled from the nearest outline,
// one-off jumps (another character's outline for a frame) removed with a median, then smoothed
// so the camera glides like an operator's instead of twitching with the drawing.
function cameraPath(p, e) {
  const mode = e.params.mode, n = Math.max(2, Math.round(e.dur * 10) + 1), pts = [];
  for (let i = 0; i < n; i++) {
    const at = srcAt(p, Math.min(e.start + e.dur - 0.02, e.start + i / 10 + 0.01));
    pts.push(at ? subjectAim(maskAt(at.m, at.s), mode === 'ladder' ? 'push' : mode) : null);
  }
  let guess = false, face = false, soloFaces = 0;
  // (the pro glide too: a narrow frame, the vertical copy above all, has to keep the face, not the
  // middle of the body the outline's centre gives)
  if (mode === 'push' || mode === 'ladder' || mode === 'glide') {
    // a detected face beats an outline: aim at the most prominent one (its eyes for the ladder)
    const score = (b) => b[4] * Math.sqrt((b[2] - b[0]) * (b[3] - b[1]));
    const fp = [];
    for (let i = 0; i < n; i++) {
      const at = srcAt(p, Math.min(e.start + e.dur - 0.02, e.start + i / 10 + 0.01)), r = at && facesAt(at.m, at.s);
      const b = r && r.boxes.length ? r.boxes.reduce((a, c) => (score(c) > score(a) ? c : a)) : null;
      fp.push(b ? { x: (b[0] + b[2]) / 2, y: b[1] + (b[3] - b[1]) * (r.kind === 'face' ? 0.42 : 0.55), solo: r.boxes.length === 1 } : null);
      if (b && r.boxes.length === 1) soloFaces++;
    }
    if (fp.filter(Boolean).length >= Math.max(2, n * 0.4)) { for (let i = 0; i < n; i++) pts[i] = fp[i]; face = true; }
  }
  if (pts.filter(Boolean).length < Math.max(2, n * 0.4)) {
    // no outline here (the character model misses some heavily tinted or backlit shots): aim at
    // the footage's centre of action from the analysis instead, a little above the middle
    guess = true;
    for (let i = 0; i < n; i++) {
      const at = srcAt(p, Math.min(e.start + e.dur - 0.02, e.start + i / 10 + 0.01)), g = at && at.m.analysis && at.m.analysis.grid;
      pts[i] = g ? { x: g.cx[Math.max(0, Math.min(g.cx.length - 1, Math.round(at.s * g.rate)))], y: 0.42 } : null;
    }
    if (!pts.some(Boolean)) return null;
  }
  for (let i = 0; i < n; i++) if (!pts[i]) for (let d = 1; d < n; d++) { const q = pts[i - d] || pts[i + d]; if (q) { pts[i] = q; break; } }
  const med = (a, i) => { const s = a.slice(Math.max(0, i - 2), i + 3).sort((u, v) => u - v); return s[s.length >> 1]; };
  const sig = mode === 'push' ? 4 : 3;
  const gauss = (a) => a.map((_, i) => {
    let s = 0, ws = 0;
    for (let j = Math.max(0, i - sig * 2); j <= Math.min(a.length - 1, i + sig * 2); j++) { const wj = Math.exp(-((j - i) ** 2) / (2 * sig * sig)); s += a[j] * wj; ws += wj; }
    return s / ws;
  });
  const solo = pts.filter((q) => q && q.solo).length / n;
  const xs0 = pts.map((q) => q.x), ys0 = pts.map((q) => q.y);
  const xs = gauss(xs0.map((_, i) => med(xs0, i))), ys = gauss(ys0.map((_, i) => med(ys0, i)));
  const xy = [];
  for (let i = 0; i < n; i++) xy.push(+xs[i].toFixed(4), +ys[i].toFixed(4));
  return { rate: 10, xy, guess, face, solo: face ? soloFaces / n : solo };
}

function trackCameras() {
  for (const e of app.project.effects) {
    if (e.type !== 'camera') continue;
    const P = e.params;
    if (P.auto && P.mode === 'handheld') P.mode = 'follow'; // look again: the outlines may be there now
    if (P.mode !== 'follow' && P.mode !== 'push' && P.mode !== 'ladder' && P.mode !== 'glide') continue;
    P.path = cameraPath(app.project, e);
    // the punch-in ladder only goes all the way in to the eyes when one character owns the shot;
    // with two or a crowd (or no outline) it steps in gently instead of zooming into a gap
    if (P.mode === 'ladder' && P.auto && P.steps && P.steps.length > 1) {
      const sure = P.path && !P.path.guess && P.path.solo >= 0.6;
      P.steps = [[P.steps[0][0], sure ? 1.35 : 1.18], [P.steps[1][0], sure ? 2.1 : 1.38]];
    }
    // a follow shot with nobody to follow (a crowd, an effect) goes handheld instead
    if ((!P.path || P.path.guess) && P.auto && P.mode === 'follow') { P.mode = 'handheld'; P.path = null; }
  }
}
app.trackCameras = trackCameras;

// Hit sparks only belong on a character: once the outlines are ready, each automatic spark is
// moved onto the nearest edge of the character at its contact frame (where a blow lands), or
// switched off when there's no character there to hit (an effect floating in empty space reads
// as a mistake).
function refineOverlays() {
  const p = app.project;
  for (const e of p.effects) {
    if (e.type !== 'vfx' || e.src === 'manual') continue;
    if (e.params.behind && !e.params.hit) {
      // an overlay behind the characters needs some background to show in: where a character
      // fills the frame (an eye or face close-up) it would only peek through the gaps, so it's off
      let cov = 0, n = 0;
      for (let q = 0; q < 4; q++) {
        const at = srcAt(p, e.start + (e.dur * (q + 0.5)) / 4), m = at && maskAt(at.m, at.s);
        if (!m) continue;
        let on = 0;
        for (let i = 0; i < m.data.length; i += 7) if (m.data[i] > 127) on++;
        cov += on / Math.ceil(m.data.length / 7); n++;
      }
      e.params.off = n > 0 && cov / n > 0.6;
      continue;
    }
    if (!e.params.hit) continue;
    const P = e.params, a = vfxAsset(P.asset);
    const t = e.start + (a ? (a.peak || 0) / (a.fps || 12) / (P.speed || 1) : 0);
    const at = srcAt(p, t), m = at && maskAt(at.m, at.s);
    if (P.x0 == null) { P.x0 = P.x; P.y0 = P.y; }
    P.off = true;
    if (!m) continue;
    const top = m.top ?? 0, span = (m.bottom ?? 1) - top, gx = (P.x0 * m.w) | 0, gy = (((P.y0 - top) / span) * m.h) | 0;
    let best = null;
    // the nearest outline edge pixel (inside the character, next to the outside), within reach
    const R = Math.round(m.w * 0.18);
    for (let y = Math.max(1, gy - R); y < Math.min(m.h - 1, gy + R); y += 2) for (let x = Math.max(1, gx - R); x < Math.min(m.w - 1, gx + R); x += 2) {
      const i = y * m.w + x;
      if (m.data[i] <= 127) continue;
      if (m.data[i - 1] > 127 && m.data[i + 1] > 127 && m.data[i - m.w] > 127 && m.data[i + m.w] > 127) continue;
      const d = (x - gx) ** 2 + (y - gy) ** 2;
      if (!best || d < best.d) best = { d, x, y };
    }
    if (!best) continue;
    P.x = best.x / m.w; P.y = top + (best.y / m.h) * span; P.off = false;
  }
}

// ---------- where each caption line goes ----------
// Nine spots around the picture (corners, edges, centre). Each line takes the one that keeps it
// off the characters for its whole time on screen, sits close beside them (like a word tucked
// by a character's head), and isn't where the last couple of lines were. The centre is last resort.
const ANCHORS = [
  { id: 'tl', x: 0.06, y: 0.2, align: 'left' }, { id: 'tc', x: 0.5, y: 0.17, align: 'center' }, { id: 'tr', x: 0.94, y: 0.2, align: 'right' },
  { id: 'ml', x: 0.06, y: 0.5, align: 'left' }, { id: 'mr', x: 0.94, y: 0.5, align: 'right' },
  { id: 'bl', x: 0.06, y: 0.8, align: 'left' }, { id: 'bc', x: 0.5, y: 0.83, align: 'center' }, { id: 'br', x: 0.94, y: 0.78, align: 'right' },
  { id: 'c', x: 0.5, y: 0.5, align: 'center' },
];

// Fonts and scales of each caption look (must match BUILD_LOOKS in text.js), for measuring.
const LOOK_TYPE = {
  serif: { hot: (px) => `italic 400 ${px}px ${fontStack('DM Serif Display')}`, small: (px) => `400 ${px}px ${fontStack('DM Serif Display')}`, hotK: 1.6, smallK: 1, upper: false, spread: 1 },
  caps: { hot: (px) => `400 ${px}px ${fontStack('Anton')}`, small: (px) => `700 ${px}px "Inter"`, hotK: 1.8, smallK: 0.75, upper: true, spread: 1.16 },
  neon: { hot: (px) => `800 ${px}px "Inter"`, small: (px) => `800 ${px}px "Inter"`, hotK: 1.55, smallK: 0.95, upper: true, spread: 1.06 },
};
// neon palettes like the Haikyuu edit: alternating tube colours that suit the shot
function neonPalette(sc) {
  const h = sc && sc.chroma > 0.08 ? sc.hue : 30;
  if (h < 70 || h > 320) return ['#ff3b30', '#ffffff', '#ffd60a', '#ff7a1a'];
  if (h > 170 && h < 280) return ['#2f8bff', '#ffffff', '#5ef2ff', '#ff3df2'];
  return ['#ff3df2', '#ffffff', '#ffd60a', '#2f8bff'];
}

// The size of a line's lockup (key word row plus the small rows above/below), as fractions of the picture.
function lineBlock(p, q, look, base) {
  const { w: W, h: H } = formatSize(p), box = pictureBox(p), bh = (box.bottom - box.top) * H;
  const L = LOOK_TYPE[look] || LOOK_TYPE.serif, unit = base * W, hotPx = unit * L.hotK * (q.hotMul || 1), smallPx = unit * L.smallK;
  const up = (t) => (L.upper ? t.toUpperCase() : t);
  measureCtx.font = L.hot(hotPx);
  const hotW = measureCtx.measureText(up(q.hotText || '')).width;
  measureCtx.font = L.small(smallPx);
  const pre = q.ws.slice(0, q.hotIdx).map((w) => w.text).join(' '), post = q.ws.slice(q.hotIdx + 1).map((w) => w.text).join(' ');
  const sw = (t) => (t ? measureCtx.measureText(up(t)).width * L.spread : 0);
  return { w: Math.min(0.72, Math.max(hotW, sw(pre), sw(post)) / W), h: (hotPx * 1.05 + (pre ? smallPx * 1.35 : 0) + (post ? smallPx * 1.35 : 0)) / bh };
}

function smartPlace(p, q, ta, tb, look, base, recent, vis = { top: 0, bottom: 1 }) {
  const masks = [];
  for (let t = ta + 0.05; t < tb; t += 0.2) { const at = srcAt(p, t); const m = at && maskAt(at.m, at.s); if (m) masks.push(m); }
  if (masks.length < 2) return null;
  const { w: bw, h: bhF } = lineBlock(p, q, look, base);
  const frac = (m, x0, y0, x1, y1) => {
    let s = 0, n = 0;
    for (let i = 0; i < 10; i++) for (let j = 0; j < 6; j++) {
      const x = x0 + ((x1 - x0) * (i + 0.5)) / 10, y = y0 + ((y1 - y0) * (j + 0.5)) / 6;
      if (x < 0 || x > 1 || y < 0 || y > 1) continue;
      s += m.data[Math.min(m.h - 1, Math.floor(y * m.h)) * m.w + Math.min(m.w - 1, Math.floor(x * m.w))] > 127; n++;
    }
    return n ? s / n : 0;
  };
  let best = null;
  for (const a of ANCHORS) {
    const x0 = a.align === 'left' ? a.x : a.align === 'right' ? a.x - bw : a.x - bw / 2;
    const vy = vis.top + a.y * (vis.bottom - vis.top);
    const y = Math.min(vis.bottom - 0.03 - bhF / 2, Math.max(vis.top + 0.03 + bhF / 2, vy)), y0 = y - bhF / 2;
    let cover = 0, near = 0;
    for (const m of masks) { cover += frac(m, x0, y0, x0 + bw, y0 + bhF); near += frac(m, x0 - 0.08, y0 - 0.1, x0 + bw + 0.08, y0 + bhF + 0.1); }
    cover /= masks.length; near /= masks.length;
    const score = cover * 3 - Math.min(0.25, Math.max(0, near - cover)) * 1.2
      + (recent[0] === a.id ? 0.7 : 0) + (recent[1] === a.id ? 0.35 : 0) + (a.id === 'c' ? 0.9 : a.id === 'tc' || a.id === 'bc' ? 0.2 : 0) + (a.id === 'br' ? 0.2 : 0);
    if (!best || score < best.score) best = { score, id: a.id, x: a.x, align: a.align, y };
  }
  return best;
}

// ---------- text behind the characters ----------
app.depth = new Map(); // caption line → where the characters are when its key word lands
const lineKey = (q) => Math.round(q.start * 100);
// Giant words behind the characters (the director's backdrops and lifted key words), placed where
// they read: whole (a split word read as two fragments, "S-R ANK"), in a heavy condensed face (a
// thin serif stretched tall vanished into dark shots), at the height and size where the
// characters hide least of each letter over its first second, measured against the outlines as
// the caption depth search measures; where every placement leaves letters mostly hidden (a close-up
// filling the frame), its outline runs on in front (`ghost`) so it still reads. The fill is set
// against the shot's brightness, with an outline, so the word stands off the picture behind it; a
// lyric line over it stays in front, the three depths the XP2 edits stack (word, character, line).
// A lyric line in front of a giant word is set round it, never over its letters. The line's own key
// word lifted to a giant becomes a lockup, the way the reference edits set their hook words: the
// small words just above the giant one, on its left edge, and the line's small copy of the word
// gone (the giant is that word, on its syllable), the line ending with it. Any other line up with a
// giant word moves above or below it, whichever is clear of the characters.
function lockGiants(p) {
  const { w: W, h: H } = formatSize(p), notes = [];
  const giants = p.texts.filter((g) => g.style === 'giant' && g.backdrop && !g.body);
  const lines = p.texts.filter((t) => t.lyric && t.style !== 'giant' && t.words && t.words.length);
  const boxAt = (t, tm) => { const s = textSpot(p, t, tm, W, H); return s && s.b; };
  for (const g of giants) {
    const gb = boxAt(g, g.start + Math.min(0.3, g.dur / 2));
    if (!gb) continue;
    const own = g.from && lines.find((t) => t.id === g.from);
    if (own && Number.isInteger(g.word) && own.words[g.word]) {
      own.words = own.words.filter((_, i) => i !== g.word);
      own.dur = Math.min(own.dur, g.start + g.dur - own.start);
    }
    // (a word split round a face leaves its line where the director set it)
    if (g.split) continue;
    for (const t of lines) {
      if (t.start >= g.start + g.dur || t.start + t.dur <= g.start || !t.words.length) continue;
      const tm = Math.min(t.start + t.dur, g.start + g.dur) - 0.03, lb = boxAt(t, tm);
      if (!lb) continue;
      const hit = Math.min(lb.x1, gb.x1) - Math.max(lb.x0, gb.x0) > 0 && Math.min(lb.y1, gb.y1) - Math.max(lb.y0, gb.y0) > 0;
      if (!hit && t !== own) continue;
      const lh = lb.y1 - lb.y0, opts = [];
      if (gb.y0 - 0.02 - lh >= 0.04) opts.push(gb.y0 - 0.02 - lb.y1);
      if (gb.y1 + 0.02 + lh <= 0.96) opts.push(gb.y1 + 0.02 - lb.y0);
      let best = null;
      for (const dy of opts) {
        const c = { ...t, y: (t.y ?? 0.5) + dy, ...(t === own ? { x: Math.max(0.04, gb.x0), align: 'left' } : {}), depth: false, depthSpans: undefined };
        const sp = textSpot(p, c, tm, W, H);
        if (!sp) continue;
        const score = sp.face * 6 + (sp.cover ?? 0) * 2 + Math.abs(dy);
        if (!best || score < best.score) best = { score, c };
      }
      // (no room: a lockup's giant word steps down and in until its line fits on its top edge; any
      // other line that was sung well before the giant lands clears as it does)
      if (!best && t === own) {
        const y0 = g.y, m0 = g.maxH;
        for (const [gy, gm] of [[0.6, 0.44], [0.64, 0.36], [0.68, 0.3]]) {
          Object.assign(g, { y: gy, maxH: gm });
          const nb = boxAt(g, g.start + Math.min(0.3, g.dur / 2));
          if (!nb || nb.y0 - 0.02 - lh < 0.04) continue;
          const c = { ...t, y: (t.y ?? 0.5) + (nb.y0 - 0.02 - lb.y1), x: Math.max(0.04, nb.x0), align: 'left', depth: false, depthSpans: undefined };
          const sp = textSpot(p, c, tm, W, H);
          if (sp && sp.face < 0.3) { best = { c }; break; }
        }
        if (!best) Object.assign(g, { y: y0, maxH: m0 });
      }
      if (!best && t !== own) {
        const lastW = t.start + Math.max(0, ...t.words.map((w) => w.t || 0));
        if (g.start - lastW >= 0.25) { t.dur = Math.max(0.4, g.start + 0.02 - t.start); notes.push(`at ${t.start.toFixed(2)}s: the line clears as the giant word lands at ${g.start.toFixed(2)}s`); continue; }
      }
      if (!best) { notes.push(`at ${t.start.toFixed(2)}s: the line runs over the giant word at ${g.start.toFixed(2)}s (no room above or below it)`); continue; }
      // (a lockup sits on the giant's edge exactly: its first letter over the giant's first, a
      // letter-space above it, measured as drawn)
      if (t === own) {
        const nb = boxAt(g, g.start + Math.min(0.3, g.dur / 2)), cb = boxAt(best.c, tm);
        if (nb && cb) { best.c.x += nb.x0 - cb.x0; best.c.y += nb.y0 - 0.015 - cb.y1; }
      }
      Object.assign(t, { x: best.c.x, y: best.c.y, align: best.c.align, depth: false, depthSpans: undefined });
      notes.push(`at ${t.start.toFixed(2)}s: ${t === own ? 'set as a lockup over its giant word' : 'moved off the giant word'} at ${g.start.toFixed(2)}s`);
    }
  }
  return notes;
}

// Two lyric lines never overlap on screen: where the block one line has built up would meet the
// next line's, the first clears as the next line's first word lands, so the words of two lines
// never read as one (a long line stacks down the frame and can reach the next line's spot).
function separateLines(p) {
  const { w: W, h: H } = formatSize(p), notes = [];
  const ls = p.texts.filter((t) => t.lyric && t.style !== 'giant' && t.words && t.words.length).sort((a, b) => a.start - b.start);
  const box = (t, tm) => { const s = textSpot(p, t, tm, W, H); return s && s.b; };
  // (a spoken line and a sung one never share the screen: a lyric line still up when a voice's first
  // word comes in clears for it, its last word kept a fifth of a second where that's only a moment)
  const vstarts = [...new Set(p.texts.filter((t) => t.voice).map((t) => t.start))].sort((a, b) => a - b);
  const voiceRuns = vstarts.filter((v, i) => i === 0 || v - vstarts[i - 1] > 1.5);
  for (const v of voiceRuns) {
    for (const a of ls) {
      if (a.voice || a.start >= v || a.start + a.dur <= v + 0.02) continue;
      const lastW = a.start + Math.max(0, ...a.words.map((w) => w.t || 0));
      a.dur = Math.max(0.4, Math.max(v + 0.02, Math.min(lastW + 0.21, v + 0.12)) - a.start);
      notes.push(`at ${v.toFixed(2)}s: the sung line clears for the spoken one`);
    }
  }
  for (let i = 0; i < ls.length - 1; i++) {
    const a = ls[i], b = ls[i + 1], first = b.start + Math.max(0, Math.min(...b.words.map((w) => w.t || 0)));
    const end = Math.min(a.start + a.dur, b.start + b.dur);
    if (end <= first + 0.02) continue;
    const ba = box(a, first + 0.01), bb = box(b, end - 0.02);
    if (!ba || !bb) continue;
    const m = 0.01, ix = Math.min(ba.x1, bb.x1) - Math.max(ba.x0, bb.x0), iy = Math.min(ba.y1, bb.y1) - Math.max(ba.y0, bb.y0);
    // (two lines up together read top to bottom, left to right: a new line above the one still up,
    // or beside it on its left, would be read first, so it counts as a clash too)
    const before = bb.y1 <= ba.y0 + m || (iy > 0 && bb.x1 <= ba.x0 + m);
    if ((ix <= -m || iy <= -m) && !before) continue;
    // (the line before's last word needs a fifth of a second up to read: where the singing runs
    // straight on, the new line moves instead, across the frame or above or below the block, to a
    // spot inside the frame and off the faces)
    const lastW = a.start + Math.max(0, ...a.words.map((w) => w.t || 0));
    // (out of reading order but apart: the line up keeps its last word a quarter second, then goes,
    // so the two share the screen only while it leaves)
    if (ix <= -m || iy <= -m) {
      const e = Math.max(first + 0.04, lastW + 0.25);
      if (e < a.start + a.dur) { a.dur = e - a.start; notes.push(`at ${first.toFixed(2)}s: the line before goes as this one comes in (it would be read after this one)`); }
      continue;
    }
    // (a line whose key word tucks behind a character stays where it is: its depth is set to that spot)
    // (nor does one the director placed in the notes)
    if (first + 0.04 - lastW < 0.25 && !b.pinned && !b.depth && !(b.depthSpans && b.depthSpans.length)) {
      const tries = [{ x: 1 - (b.x ?? 0.5), align: b.align === 'left' ? 'right' : b.align === 'right' ? 'left' : 'center' }, { y: (b.y ?? 0.5) + (ba.y1 + 0.02 - bb.y0) }, { y: (b.y ?? 0.5) - (bb.y1 + 0.02 - ba.y0) },
        ...[[0.94, 0.2, 'right'], [0.94, 0.5, 'right'], [0.94, 0.78, 'right'], [0.06, 0.8, 'left'], [0.5, 0.83, 'center'], [0.5, 0.17, 'center'], [0.06, 0.5, 'left'], [0.06, 0.2, 'left']].map(([x, y, align]) => ({ x, y, align }))];
      let ok = null, best = Infinity;
      for (const o of tries) {
        const c = { ...b, ...o, depth: false, depthSpans: undefined };
        const sp = textSpot(p, c, end - 0.02, W, H), q = sp && sp.b;
        if (!q || q.x0 < 0.02 || q.x1 > 0.98 || q.y0 < 0.03 || q.y1 > 0.97 || sp.face > 0.15 || (sp.cover ?? 0) > 0.35) continue;
        // (clear of the line still up, and after it in reading order: below it, or to its right)
        const qx = Math.min(ba.x1, q.x1) - Math.max(ba.x0, q.x0), qy = Math.min(ba.y1, q.y1) - Math.max(ba.y0, q.y0);
        if ((qx > 0 && qy > 0) || q.y1 <= ba.y0 + m || (qy > 0 && q.x1 <= ba.x0 + m)) continue;
        // (the least over the characters, then the nearest to where it was)
        const score = sp.face * 6 + (sp.cover ?? 0) * 2 + Math.hypot((c.x ?? 0.5) - (b.x ?? 0.5), (c.y ?? 0.5) - (b.y ?? 0.5)) * 0.5;
        if (score < best) { best = score; ok = c; }
      }
      if (ok) {
        Object.assign(b, { x: ok.x, y: ok.y, align: ok.align, depth: false, depthSpans: undefined });
        notes.push(`at ${first.toFixed(2)}s: moved clear of the line before, which is still up (they would overlap)`);
        continue;
      }
    }
    // (its last word still gets a fifth of a second where that's only a moment past the new line's
    // first: the two meet only while one blurs in and the other out)
    a.dur = Math.max(0.4, Math.max(first + 0.04, Math.min(lastW + 0.21, first + 0.15)) - a.start);
    notes.push(`at ${first.toFixed(2)}s: the line before clears as this one comes in (they would overlap)`);
  }
  return notes;
}

function placeGiants(p) {
  const { w: W, h: H } = formatSize(p);
  const view = (m, t) => {
    const f = frameParams(p, t, W, H), tx = f.textXform, fx = f.fx, win = f.win;
    const ax = tx ? tx.a[0] : 1, ay = tx ? tx.a[1] : 1;
    const bx = tx ? 0.5 - ax * (0.5 + tx.off[0]) + tx.shift[0] : 0, by = tx ? 0.5 - ay * (0.5 + tx.off[1]) + tx.shift[1] : 0;
    const ww = win[2] - win[0], wh = win[3] - win[1], rx = f.region[0], ry = f.region[1];
    const sx0 = f.center[0] - (0.5 + fx.tx) * rx, sy0 = f.center[1] - (0.5 + fx.ty) * ry, top = m.top ?? 0, span = (m.bottom ?? 1) - top;
    return { m, kx: (ax / ww) * rx, ox: ((bx - win[0]) / ww) * rx + sx0, ky: ((ay / wh) * ry) / span, oy: (((by - win[1]) / wh) * ry + sy0 - top) / span };
  };
  const FONT = 'Anton', STRETCH = 1.15, FIT = 0.92;
  const gc = document.createElement('canvas'), gx = gc.getContext('2d', { willReadFrequently: true });
  const notes = [];
  for (const x of p.texts.filter((t) => t.backdrop && t.style === 'giant')) {
    const word = String(x.text).toUpperCase();
    if (x.body) {
      // (in front of everything by default: the letters stand beside the figure, and whatever it stands
      // on would cut into them, an R losing its leg to the bear's back reads as a B)
      Object.assign(x, { font: FONT, split: null, alpha: 1, outline: 'rgba(0,0,0,0.7)', punch: true, ghost: false, behind: !!x.body.behind });
      notes.push(`at ${x.start.toFixed(2)}s: set round the character as its letter ${Number(x.body.letter) + 1}`);
      continue;
    }
    // (`face`: the director's own typeface for the word, drawn at its own proportions)
    const F = x.face || FONT, ST = x.face ? 1 : STRETCH;
    const vs = [];
    for (let t = x.start + 0.04; t < x.start + Math.min(x.dur, 1.0); t += 0.1) { const at = srcAt(p, t); const m = at && maskAt(at.m, at.s); if (m) vs.push(view(m, t)); }
    // the word's letters as ink at a working size, as fractions of its own box
    const RW = 240;
    gx.font = `400 100px ${fontStack(F)}, Impact, sans-serif`;
    const w100 = Math.max(1, gx.measureText(word).width), rh = Math.ceil((RW * 100) / w100 * 1.25);
    gc.width = RW; gc.height = Math.max(8, rh);
    gx.font = `400 ${(RW / w100) * 100}px ${fontStack(F)}, Impact, sans-serif`;
    gx.textAlign = 'center'; gx.textBaseline = 'middle'; gx.fillStyle = '#fff';
    gx.clearRect(0, 0, gc.width, gc.height); gx.fillText(word, RW / 2, gc.height / 2);
    const d = gx.getImageData(0, 0, gc.width, gc.height).data, ink = [];
    const edges = [...word].map((_, i) => gx.measureText(word.slice(0, i + 1)).width / RW);
    for (let yy = 0; yy < gc.height; yy += 2) for (let xx = 0; xx < RW; xx += 2) if (d[(yy * RW + xx) * 4 + 3] > 127) ink.push(xx / RW, yy / gc.height, Math.max(0, edges.findIndex((e) => xx / RW < e)));
    const nL = edges.length;
    // each candidate: centre height and cap height (of the frame); the box follows the word's shape
    // (the director's own height and size, `y` and `maxH` in the notes, are kept as they are)
    const cands = x.maxH > 0 && x.maxH < 1 && x.y != null ? [[x.y, x.maxH]] : [[x.y ?? 0.5, 0.62], [0.5, 0.42], [0.33, 0.42], [0.67, 0.42], [0.25, 0.3], [0.75, 0.3], [0.5, 0.3]];
    let best = null;
    for (const [cy, capH] of cands) {
      // (the drawn size: cap height × stretch, narrowed to fit the width)
      const bw = Math.min(FIT, ((capH * H) / ST) * (w100 / 100) / W), bh = ((bw * W) / (w100 / 100)) * ST / H * 1.25;
      const vis = new Array(nL).fill(0), cnt = new Array(nL).fill(0);
      for (const v of vs) {
        const m = v.m;
        for (let i = 0; i < ink.length; i += 3) {
          const sx = 0.5 + (ink[i] - 0.5) * bw, sy = cy + (ink[i + 1] - 0.5) * bh;
          const mx = v.kx * sx + v.ox, my = v.ky * sy + v.oy, l = ink[i + 2];
          cnt[l]++;
          if (mx < 0 || mx > 1 || my < 0 || my > 1 || m.data[Math.min(m.h - 1, Math.floor(my * m.h)) * m.w + Math.min(m.w - 1, Math.floor(mx * m.w))] <= 127) vis[l]++;
        }
      }
      const per = vis.map((v2, i) => (cnt[i] ? v2 / cnt[i] : 1)), worst = Math.min(...per), mean = per.reduce((s, v2) => s + v2, 0) / nL;
      // (every letter must read; a bigger word reads further; the director's own height is a start)
      const score = mean + 0.6 * Math.min(worst, 0.6) + 0.25 * capH - (cy === (x.y ?? 0.5) && capH === 0.62 ? 0 : 0.02) - 0.05 * Math.abs(cy - 0.5);
      if (!best || score > best.score) best = { score, cy, capH, worst, mean, bh };
    }
    if (!vs.length) best = { cy: x.y ?? 0.5, capH: 0.5, worst: 1, mean: 1 };
    // the shot's brightness behind the word, from the scan: bright footage takes a deep fill with a
    // light edge, dark footage a bright one with a dark edge
    const at = srcAt(p, x.start + 0.05), g = at && at.m.analysis && at.m.analysis.grid;
    const lum = g && g.pl ? gridMean(g, 'pl', at.s, at.s + 0.5) : 0.4;
    // (the word's own tone, the middle of the director's gradient: blue for the shadows, red for Igris)
    const tone = (x.gradient && x.gradient.length >= 3 && x.gradient[1]) || x.color || '#9fd8ff';
    // (`ink` in the notes: "dark" sets it in the palette's deep ink, letters against the light, "light" the bright fill)
    const bright = x.ink === 'dark' ? true : x.ink === 'light' ? false : lum > 0.5;
    // (a lifted lyric word the shot would hide whatever the placement, a close-up filling the frame,
    // is left out: the line itself still shows; the director's own backdrop word stays, its outline in
    // front, and the report says to move it to a wider shot)
    if (best.mean < 0.45 && x.src === 'notes' && !x.split) {
      p.texts = p.texts.filter((t) => t !== x);
      notes.push(`at ${x.start.toFixed(2)}s left out: only ${Math.round(best.mean * 100)}% of it would show on this shot (a close-up)`);
      continue;
    }
    // (a word the director split round a face keeps its split, its halves either side; one set in
    // front stays in front: a close-up's outline can take in the whole frame)
    if (x.front) x.behind = false;
    Object.assign(x, { font: F, stretch: ST, fit: FIT, split: x.split || null, y: best.cy, maxH: best.capH, alpha: 1,
      // (`keep` in the notes: the director's own gradient stands, or the tone was all that survived of it)
      gradient: x.keep && x.gradient ? x.gradient : bright ? ['#0d2a63', mixHex(tone, '#0d2a63', 0.55), '#06122e'] : ['#ffffff', mixHex(tone, '#ffffff', 0.35), tone],
      outline: bright ? 'rgba(255,255,255,0.85)' : 'rgba(0,0,0,0.7)',
      ghost: !x.front && best.worst < 0.45, punch: true });
    if (x.front) { notes.push(`at ${x.start.toFixed(2)}s: in front of the characters, split round them`); continue; }
    notes.push(`at ${x.start.toFixed(2)}s: ${Math.round(best.mean * 100)}% readable (worst letter ${Math.round(best.worst * 100)}%) at height ${best.cy}, ${best.capH} of the frame${x.ghost ? ', outline in front' : ''}${best.mean < 0.45 ? ': mostly hidden, put it on a wider shot' : ''}`);
  }
  return notes;
}

let depthRun = 0;

// Search the picture for where a line's key word should sit so the character covers part of it
// (about a third), never most of it, for the rest of the shot the word appears in. At the next cut
// the word steps in front (the cut hides the switch). Null when there's no such spot.
const measureCtx = document.createElement('canvas').getContext('2d');
function depthPlaceAt(p, q, segs, sizeMul) {
  const { w: W, h: H } = formatSize(p), box = pictureBox(p), bh = (box.bottom - box.top) * H, pbH = box.bottom - box.top;
  const LT = LOOK_TYPE[q.look] || LOOK_TYPE.serif, caps = LT.upper, px = (q.base || 0.04) * W * LT.hotK * (q.hotMul || 1) * (q.depthScale || 1) * sizeMul;
  measureCtx.font = LT.hot(px);
  const ww = Math.min(W * 0.72, measureCtx.measureText(caps ? q.hotText.toUpperCase() : q.hotText).width) / W, wh = (px * 0.75) / bh;
  // Where a point of the caption canvas lands in a frame's character mask, as it will render: the
  // caption rides along with the camera (partly), the camera crops, zooms, pans and shakes, and
  // the mask spans the footage's picture band. All axis-aligned, so it's x·k + o per axis.
  const view = (m, t) => {
    const f = frameParams(p, t, W, H), tx = f.textXform, fx = f.fx, win = f.win;
    const ax = tx ? tx.a[0] : 1, ay = tx ? tx.a[1] : 1;
    const bx = tx ? 0.5 - ax * (0.5 + tx.off[0]) + tx.shift[0] : 0, by = tx ? 0.5 - ay * (0.5 + tx.off[1]) + tx.shift[1] : 0;
    const ww = win[2] - win[0], wh2 = win[3] - win[1], rx = f.region[0], ry = f.region[1];
    const sx0 = f.center[0] - (0.5 + fx.tx) * rx, sy0 = f.center[1] - (0.5 + fx.ty) * ry, top = m.top ?? 0, span = (m.bottom ?? 1) - top;
    // canvas P → screen ax·P + bx → window (S − w0)/ww → source sx0 + ·rx → mask (· − top)/span
    return { m, kx: (ax / ww) * rx, ox: ((bx - win[0]) / ww) * rx + sx0, ky: (ay / wh2) * ry / span, oy: (((by - win[1]) / wh2) * ry + sy0 - top) / span };
  };
  // every candidate shot's outlines, 15 a second
  const shots = (segs || []).map((sg) => {
    const ms = [];
    for (let t = sg.t0 + 0.02; t < sg.t1 - 0.02; t += 1 / 15) { const at = srcAt(p, t); const m = at && maskAt(at.m, at.s); if (m) ms.push(view(m, t)); }
    return { ...sg, masks: ms };
  }).filter((sg) => sg.masks.length >= 5);
  if (!shots.length) return null;
  const masks = shots[0].masks.map((v) => v.m);
  // the key word's real letter shapes at mask resolution: how much of its ink a character hides
  const M0 = masks[0], gw = Math.max(4, Math.ceil(ww * M0.w)), gh = Math.max(4, Math.ceil(wh * M0.h * 1.4));
  const gc = document.createElement('canvas');
  gc.width = gw; gc.height = gh;
  const gx = gc.getContext('2d', { willReadFrequently: true });
  gx.font = measureCtx.font.replace(/[\d.]+px/, `${(px * M0.w) / W}px`);
  gx.textAlign = 'center'; gx.textBaseline = 'middle'; gx.fillStyle = '#fff';
  gx.fillText(caps ? q.hotText.toUpperCase() : q.hotText, gw / 2, gh / 2);
  const gd = gx.getImageData(0, 0, gw, gh).data, ink = [];
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) if (gd[(y * gw + x) * 4 + 3] > 127) ink.push((x - gw / 2) / M0.w, (y - gh / 2) / M0.h);
  if (ink.length < 20) return null;
  // which letter each bit of ink belongs to (punctuation and other slivers of ink don't count)
  const word = caps ? q.hotText.toUpperCase() : q.hotText, tw = gx.measureText(word).width;
  const edges = [...word].map((_, i) => (gx.measureText(word.slice(0, i + 1)).width - tw / 2) / M0.w);
  const letterOf = new Int16Array(ink.length / 2), inkPer = new Array(edges.length).fill(0);
  for (let i = 0; i < ink.length; i += 2) { let l = edges.findIndex((e) => ink[i] < e); if (l < 0) l = edges.length - 1; letterOf[i / 2] = l; inkPer[l]++; }
  const med = [...inkPer].filter((n) => n).sort((a, b) => a - b)[Math.floor(inkPer.filter((n) => n).length / 2)] || 1;
  const counts = inkPer.map((n) => n >= med * 0.35);
  // a word is read from its start: hidden first letters (the first third) count half again
  const lead3 = -ww / 6;
  const cover = (v, cx, cy) => {
    const m = v.m;
    let s = 0, n = 0;
    for (let i = 0; i < ink.length; i += 2) {
      const x = v.kx * (cx + ink[i]) + v.ox, y = v.ky * (box.top + (cy + ink[i + 1]) * pbH) + v.oy;
      if (x < 0 || x > 1 || y < 0 || y > 1) continue;
      const wgt = ink[i] < lead3 ? 1.5 : 1;
      s += (m.data[Math.min(m.h - 1, Math.floor(y * m.h)) * m.w + Math.min(m.w - 1, Math.floor(x * m.w))] > 127) * wgt; n += wgt;
    }
    return n ? s / n : 0;
  };
  // the first letter always stays readable
  const first = -ww / 2 + ww * 0.16;
  const firstHidden = (v, cx, cy) => {
    const m = v.m;
    let s = 0, n = 0;
    for (let i = 0; i < ink.length; i += 2) {
      if (ink[i] >= first) continue;
      const x = v.kx * (cx + ink[i]) + v.ox, y = v.ky * (box.top + (cy + ink[i + 1]) * pbH) + v.oy;
      if (x < 0 || x > 1 || y < 0 || y > 1) continue;
      s += m.data[Math.min(m.h - 1, Math.floor(y * m.h)) * m.w + Math.min(m.w - 1, Math.floor(x * m.w))] > 127; n++;
    }
    return n ? s / n : 0;
  };
  // the most any one letter loses: a word can lose a corner but every letter must still read as
  // itself (half an "m" hidden reads as an "r", the end of "her" hidden reads "he")
  const worstLetter = (v, cx, cy) => {
    const m = v.m, hid = new Array(edges.length).fill(0), n = new Array(edges.length).fill(0);
    for (let i = 0; i < ink.length; i += 2) {
      const l = letterOf[i / 2];
      if (!counts[l]) continue;
      const x = v.kx * (cx + ink[i]) + v.ox, y = v.ky * (box.top + (cy + ink[i + 1]) * pbH) + v.oy;
      if (x < 0 || x > 1 || y < 0 || y > 1) continue;
      hid[l] += m.data[Math.min(m.h - 1, Math.floor(y * m.h)) * m.w + Math.min(m.w - 1, Math.floor(x * m.w))] > 127; n[l]++;
    }
    return Math.max(0, ...hid.map((h, l) => (n[l] ? h / n[l] : 0)));
  };
  // how ragged the outline is across the word: edge crossings per row (a cheek, shoulder or arm
  // crosses once; strands of hair or a fluttering sleeve many times, and a word behind them breaks
  // into confetti instead of reading as tucked behind)
  const ragged = (v, cx, cy) => {
    const m = v.m;
    let t = 0, rows = 0;
    for (let r = 0; r < 6; r++) {
      const yb = cy - wh / 2 + ((r + 0.5) * wh) / 6;
      let prev = null, tr = 0;
      for (let q = 0; q <= 32; q++) {
        const x = v.kx * (cx - ww / 2 + (q / 32) * ww) + v.ox, y = v.ky * (box.top + yb * pbH) + v.oy;
        if (x < 0 || x > 1 || y < 0 || y > 1) continue;
        const on = m.data[Math.min(m.h - 1, Math.floor(y * m.h)) * m.w + Math.min(m.w - 1, Math.floor(x * m.w))] > 127;
        if (prev != null && on !== prev) tr++;
        prev = on;
      }
      t += tr; rows++;
    }
    return rows ? t / rows : 0;
  };
  // the search places the key word itself; the lockup's small rows above/below shift the block centre
  const unit = (q.base || 0.04) * W * (q.depthScale || 1) * sizeMul, smallH = unit * LT.smallK * 1.12, hotH = px * (q.look === 'caps' ? 0.98 : 1.12), gap = unit * 0.22;
  const pre = q.hotIdx > 0 ? smallH + gap : 0, post = q.hotIdx < q.ws.length - 1 ? smallH + gap : 0;
  const hotOff = (pre + hotH / 2 - (pre + hotH + post) / 2) / bh;
  // one spot for the whole line (the word never moves); in each shot it goes behind only if the
  // character covers a piece of it (7–30% of the letters on average, start weighted), never more
  // than about 40%, and no letter loses more than about a third, so it always reads as the word
  const lineT0 = q.start - p.music.offset;
  let best = null;
  const why = { low: 0, high: 0, peak: 0, first: 0, letter: 0, short: 0, ragged: 0 }; // why candidate spots fail (diagnostics)
  // a fine search (partial overlap lives in a narrow band along a character's edge), keeping the
  // whole word on screen
  const x0 = Math.max(0.12, ww / 2 + 0.015), x1 = Math.min(0.88, 1 - ww / 2 - 0.015);
  for (let cx = x0; cx <= x1 + 1e-4; cx += 0.02) for (let cy = 0.16; cy <= 0.841; cy += 0.03) {
    let passDur = 0, err = 0;
    const spans = [];
    for (const sh of shots) {
      // judged on the shot as a whole: one stray frame (an arm swinging past) doesn't veto it,
      // but the word is never more than 60% hidden and its first letter reads in 90% of frames
      const c = sh.masks.map((v) => cover(v, cx, cy)), sorted = [...c].sort((a, b) => a - b), k = sorted.length;
      const mean = c.reduce((a, b) => a + b, 0) / k, p95 = sorted[Math.floor(0.95 * (k - 1))], p5 = sorted[Math.floor(0.05 * (k - 1))];
      if (mean < 0.07) { why.low++; continue; }
      if (mean > 0.3) { why.high++; continue; }
      if (p95 > 0.42 || sorted[k - 1] > 0.6) { why.peak++; continue; }
      const fh = sh.masks.map((v) => firstHidden(v, cx, cy));
      if (fh.filter((x) => x > 0.2).length > Math.max(1, 0.1 * k) || Math.max(...fh) > 0.5) { why.first++; continue; }
      const wl = sh.masks.map((v) => worstLetter(v, cx, cy));
      if (wl.reduce((a, b) => a + b, 0) / k > 0.34 || wl.filter((x) => x > 0.5).length > Math.max(1, 0.1 * k)) { why.letter++; continue; }
      // a clean edge to tuck behind (checked on a few frames through the shot)
      const rg = [0.2, 0.5, 0.8].map((u) => ragged(sh.masks[Math.min(k - 1, Math.floor(u * k))], cx, cy));
      const rgm = rg.reduce((a, b) => a + b, 0) / rg.length;
      if (rgm > 2.6) { why.ragged++; continue; }
      passDur += sh.t1 - sh.t0;
      err += (Math.abs(mean - 0.18) + (p95 - p5) * 0.3 + Math.max(0, rgm - 1.2) * 0.12) * (sh.t1 - sh.t0);
      // switch a hair before each cut frame so the new shot's first frame is already right
      spans.push([sh.t0 - lineT0 - 0.004, sh.t1 - lineT0 - 0.004]);
    }
    if (passDur < 0.4) { if (passDur > 0) why.short++; continue; }
    const score = -passDur + err / passDur + Math.abs(cy - 0.45) * 0.2;
    if (!best || score < best.score) best = { score, x: cx, y: cy - hotOff, spans };
  }
  (app.depthWhy = app.depthWhy || {})[lineKey(q)] = { word: q.hotText, size: sizeMul, shots: shots.map((sh) => [+(sh.t1 - sh.t0).toFixed(2), sh.masks.length]), why, found: !!best };
  return best && { x: best.x, y: Math.min(0.85, Math.max(0.15, best.y)), spans: best.spans, scale: sizeMul };
}

// A voice line one word at a time, the XP2 edits' way: each word cuts on as it's spoken and off as
// the next comes, still, in classical serif caps about a tenth of the picture tall, on the speaker's
// face (below the eyes, where the mouth is), filled in the speaker's colour with a pale core that
// flickers frame to frame over a glow.
function placeVoiceWords(p, q, off) {
  const { w: W, h: H } = formatSize(p), c = q.voice.color, light = mixHex(c, '#ffffff', 0.72);
  // (a translated line's words don't sit on the original's syllables: stepped on the speech
  // onsets they bunched, three frames for one word and seconds for the next (the Solo Leveling
  // test); they step evenly through the spoken span instead, by length, five frames at least)
  const t0 = q.ws[0].start, t1 = Math.max(q.end, t0 + (5 / 24) * q.ws.length);
  const wt = q.ws.map((w) => String(w.text).length + 2), tot = wt.reduce((s, x) => s + x, 0);
  let acc = t0;
  // (`words` in the voice note: each word's own time, seconds from the line's start, measured on the
  // voice by the director, and one more for when the last word goes, so a word lands as it's said)
  const wa = Array.isArray(q.voice.wordAt) && q.voice.wordAt.length >= q.ws.length ? q.voice.wordAt : null;
  const at0 = wa ? q.ws.map((w, i) => q.voice.t0 + wa[i] + off) : q.ws.map((w, i) => { const s = acc; acc += ((t1 - t0) * wt[i]) / tot; return s; });
  const last = wa && wa.length > q.ws.length ? q.voice.t0 + wa[q.ws.length] + off : q.end + 0.25;
  q.ws.forEach((w, i) => {
    const a = at0[i] - off - WORD_LEAD, b = (i + 1 < at0.length ? at0[i + 1] : last) - off - WORD_LEAD;
    // (`spot: [x, y]` in the voice note: the director's own place for the words, the dark beside a bright moon)
    const tm = a + Math.min(0.1, (b - a) / 2), at = Array.isArray(q.voice.spot) ? { x: q.voice.spot[0], y: q.voice.spot[1] } : voiceWordSpot(p, tm, W, H);
    p.texts.push({ id: uid('tx'), text: w.text, start: Math.max(0, a), dur: Math.max(0.12, b - a), style: 'giant', font: 'Cinzel', size: 0.1, maxH: 0.12, fit: 0.62,
      x: at.x, y: at.y, voiceAt: tm, ...(Array.isArray(q.voice.spot) ? { spotFixed: true } : {}), still: true, cut: true, grain: false, shimmer: [c, light], glowColor: c, color: c, behind: false, anim: 'none', src: 'manual', lyric: true, voice: true });
  });
}
// where a voice word sits in a frame drawn at W×H: on the biggest face, below the eyes
function voiceWordSpot(p, tm, W, H) {
  const f = frameParams(p, tm, W, H), fr = f.clip && facesAt(f.media, f.srcTime);
  const bx = fr && fr.boxes && fr.boxes.length ? fr.boxes.reduce((a, b) => ((b[2] - b[0]) * (b[3] - b[1]) > (a[2] - a[0]) * (a[3] - a[1]) ? b : a)) : null;
  if (!bx) return { x: 0.5, y: 0.62 };
  const [cx, cy] = f.center, [rw, rh] = f.region;
  return { x: clamp(((bx[0] + bx[2]) / 2 - (cx - rw / 2)) / rw, 0.2, 0.8), y: clamp((bx[1] + (bx[3] - bx[1]) * 0.78 - (cy - rh / 2)) / rh, 0.2, 0.82) };
}

// The key word at full size if it can tuck behind a character cleanly, otherwise a little smaller
// (a big word over a big character only has a narrow band along the character's edge).
function depthPlace(p, q, segs) {
  for (const k of [1, 0.85, 0.72]) { const r = depthPlaceAt(p, q, segs, k); if (r) return r; }
  return null;
}

function srcAt(p, t) {
  const c = p.clips[clipIndexAt(p.clips, t)], m = c && getMedia(p, c.mediaId);
  return m && m.kind === 'video' ? { m, s: srcTimeAt(c, Math.max(0, Math.min(c.dur, t - c.start))) } : null;
}

// The shots a stretch of the timeline passes through: breaks at clip boundaries and at the
// footage's own cuts (from the scan, plus exact ones found frame by frame).
function shotSegments(p, ta, tb) {
  const segs = [];
  let cur = null;
  for (let t = ta; t < tb; t += 1 / 60) {
    const at = srcAt(p, t);
    const ci = clipIndexAt(p.clips, t);
    if (!at) { cur = null; continue; }
    const fps = (at.m.masks && at.m.masks.fps) || at.m.fps || 30;
    const cutBetween = cur && (cur.ci !== ci || at.s < cur.sLast
      || (at.m.analysis.scenes || []).some((sc) => sc.start > cur.sLast + 1e-4 && sc.start <= at.s + 1e-4)
      || [...((at.m.masks && at.m.masks.cuts) || [])].some((n) => n / fps > cur.sLast + 1e-4 && n / fps <= at.s + 1e-4));
    if (!cur || cutBetween) { cur = { t0: t, t1: t, m: at.m, ci, s0: at.s, sLast: at.s }; segs.push(cur); }
    cur.t1 = t + 1 / 60; cur.sLast = at.s;
  }
  return segs.map((g) => ({ t0: g.t0, t1: Math.min(tb, g.t1), m: g.m, s0: g.s0, s1: g.sLast }));
}

// Find the characters for every caption line: where they are while it's up (for placing it),
// and, for phasing, every shot it's on screen in from its key word on. Each shot where the
// characters fill a sensible part of the picture gets per-frame outlines (stopping at its exact
// cut); then one spot is chosen that works in as many of those shots as possible, and the key
// word goes behind only in the shots where it does — stepping in front at a cut, which hides it.
// Where a caption would sit at time tm with the edit drawn at w×h: its box (0..1 of the frame),
// how much of that box the characters cover (0..1; null with no outline there) and how much of the
// biggest face it covers (0..1).
let coverLayer = null;
function textSpot(p, tx, tm, w, h) {
  coverLayer = coverLayer || new TextLayer();
  coverLayer.setSize(Math.round(w / 4), Math.round(h / 4));
  const cv = coverLayer.draw([tx], tm), b = cv && cv.bounds;
  if (!b) return null;
  const f = frameParams(p, tm, w, h);
  if (!f.clip) return { b, cover: null, face: 0 };
  const [cx, cy] = f.center, [rw, rh] = f.region, mk = maskAt(f.media, f.srcTime);
  let cover = null;
  if (mk) {
    const span = (mk.bottom ?? 1) - (mk.top ?? 0);
    let on = 0, n = 0;
    for (let y = b.y0; y <= b.y1 + 1e-6; y += (b.y1 - b.y0) / 6) for (let x = b.x0; x <= b.x1 + 1e-6; x += (b.x1 - b.x0) / 12) {
      const sx = cx - rw / 2 + x * rw, my = (cy - rh / 2 + y * rh - (mk.top ?? 0)) / span;
      if (sx < 0 || sx > 1 || my < 0 || my > 1) continue;
      on += mk.data[Math.min(mk.h - 1, Math.floor(my * mk.h)) * mk.w + Math.min(mk.w - 1, Math.floor(sx * mk.w))] > 127 ? 1 : 0;
      n++;
    }
    cover = n ? on / n : null;
  }
  let face = 0;
  const fr = facesAt(f.media, f.srcTime);
  for (const q of (fr && fr.boxes) || []) {
    const fx0 = (q[0] - (cx - rw / 2)) / rw, fx1 = (q[2] - (cx - rw / 2)) / rw, fy0 = (q[1] - (cy - rh / 2)) / rh, fy1 = (q[3] - (cy - rh / 2)) / rh;
    const ix = Math.max(0, Math.min(b.x1, fx1) - Math.max(b.x0, fx0)), iy = Math.max(0, Math.min(b.y1, fy1) - Math.max(b.y0, fy0));
    face = Math.max(face, (ix * iy) / Math.max(1e-6, (fx1 - fx0) * (fy1 - fy0)));
  }
  return { b, cover, face };
}

const mixHex = (a, b, t) => '#' + [0, 2, 4].map((i) => Math.round(parseInt(a.slice(1 + i, 3 + i), 16) * (1 - t) + parseInt(b.slice(1 + i, 3 + i), 16) * t).toString(16).padStart(2, '0')).join('');
// spots a medium word can take (its centre, 0..1 of the frame): round the frame for 16:9, and
// down the middle third for the vertical copy, clear of the app's buttons and caption at the bottom
const WIDE_SPOTS = [[0.25, 0.5], [0.75, 0.5], [0.25, 0.24], [0.75, 0.24], [0.25, 0.76], [0.75, 0.76], [0.5, 0.2], [0.5, 0.8]];
const TALL_SPOTS = [[0.5, 0.16], [0.5, 0.3], [0.5, 0.44], [0.5, 0.6], [0.5, 0.72], [0.34, 0.3], [0.66, 0.3], [0.34, 0.62], [0.66, 0.62]];

// Giant captions laid out the way the reference lyric edits are: a strong word fills the frame
// behind the character where it stays readable; any other word sits medium-sized in the shot's
// open space (never on a face, beside the character rather than on it), moving round the frame from
// word to word; colours from the edit's palette, tone on tone. Worked out for the 16:9 frame and,
// for a pro edit, again for its full-frame vertical copy (`tall`), whose crop puts the character
// somewhere else.
async function giantLayout(depthOn = true) {
  const p = app.project, run = ++depthRun;
  const gs = p.texts.filter((t) => t.style === 'giant' && t.lyric).sort((a, b) => a.start - b.start);
  if (!gs.length) return;
  const times = (t) => [0.2, 0.5, 0.85].map((u) => t.start + Math.min(t.dur * u, t.dur - 0.02));
  try {
    const byMedia = new Map();
    for (const t of gs) for (const tm of times(t)) { const at = srcAt(p, tm); if (at) { if (!byMedia.has(at.m)) byMedia.set(at.m, []); byMedia.get(at.m).push(at.s); } }
    let nm = 0;
    for (const [m, ts] of byMedia) {
      await segmentTimes(m, ts, (x) => lyrStatus(`Finding the characters… ${Math.round(((nm + x) / byMedia.size) * 100)}%`));
      try { await detectFaces(m, ts); } catch (e) { /* placed by the outlines alone */ }
      nm++;
      if (run !== depthRun) return;
    }
    const { w: W, h: H } = formatSize(p);
    const forms = [{ w: W, h: H, key: null }, ...(p.auto && p.auto.ctx && p.auto.ctx.pro && W > H ? [{ w: 1080, h: 1920, key: 'tall' }] : [])];
    let big = 0;
    for (const fm of forms) {
      const tall = fm.h > fm.w;
      let prev = null;
      for (const t of gs) {
        const spots = (o) => times(t).map((tm) => textSpot(p, { ...t, ...o }, tm, fm.w, fm.h)).filter(Boolean);
        const worst = (s, k) => Math.max(0, ...s.map((q) => q[k] ?? 0));
        let pick = null;
        if (t.strong && depthOn) {
          const o = { x: 0.5, y: 0.5, maxH: 0.62, fit: 0.86, behind: true }, s = spots(o);
          if (s.length && worst(s, 'cover') <= 0.4) pick = { o, a: null };
        }
        if (!pick) {
          const size = tall ? (t.strong ? { maxH: 0.15, fit: 0.8 } : { maxH: 0.11, fit: 0.66 }) : (t.strong ? { maxH: 0.3, fit: 0.5 } : { maxH: 0.2, fit: 0.4 });
          let best = null;
          for (const a of tall ? TALL_SPOTS : WIDE_SPOTS) {
            const o = { x: a[0], y: a[1], ...size, behind: false };
            // (the whole word inside the frame)
            const s0 = textSpot(p, { ...t, ...o }, times(t)[1], fm.w, fm.h);
            if (s0) { const b = s0.b; o.x += Math.max(0, 0.05 - b.x0) - Math.max(0, b.x1 - 0.95); o.y += Math.max(0, 0.06 - b.y0) - Math.max(0, b.y1 - (tall ? 0.78 : 0.94)); }
            const s = spots(o);
            if (!s.length) continue;
            const score = worst(s, 'face') * 6 + worst(s, 'cover') * 2 + (prev === a ? 0.6 : 0) + Math.abs(o.y - 0.5) * 0.3;
            if (!best || score < best.score) best = { score, o, a };
          }
          if (best) pick = best;
        }
        if (!pick) continue;
        prev = pick.a;
        if (!fm.key && pick.o.behind) big++;
        if (fm.key) t[fm.key] = pick.o; else Object.assign(t, pick.o);
      }
    }
    // the edit's palette, tone on tone: a word filling the frame in the look's own colour, the
    // others in a pale tint of it or warm white, in turn; on a bright patch of picture (a white wall,
    // the sky) a word turns to the palette's dark ink instead, as the reference's do. The patch is
    // read from the footage under the word, in each frame shape.
    const L = p.look && LOOKS[p.look.preset], base = L && L.sw && L.sw[1];
    const pal = base && p.look.preset !== 'none' ? { deep: mixHex(base, '#ffffff', 0.2), tint: mixHex(base, '#ffffff', 0.62), paper: '#f4efe6', ink: mixHex(L.sw[0], '#000000', 0.2) } : { deep: null, tint: null, paper: '#f4efe6', ink: '#14161c' };
    const sources = new Map(), cv = document.createElement('canvas');
    cv.width = 96; cv.height = 54;
    const g = cv.getContext('2d', { willReadFrequently: true });
    const under = async (t, o, fm) => {
      const tm = t.start + t.dur * 0.5, f = frameParams(p, tm, fm.w, fm.h);
      if (!f.clip) return null;
      const sp = textSpot(p, { ...t, ...o }, tm, fm.w, fm.h);
      if (!sp) return null;
      if (!sources.has(f.media.id)) sources.set(f.media.id, await openFrameSource(f.media));
      const fr = await sources.get(f.media.id).frameAt(f.srcTime);
      if (!fr) return null;
      g.drawImage(fr, 0, 0, cv.width, cv.height);
      const [cx, cy] = f.center, [rw, rh] = f.region, b = sp.b;
      const x0 = Math.max(0, Math.floor((cx - rw / 2 + b.x0 * rw) * cv.width)), x1 = Math.min(cv.width, Math.ceil((cx - rw / 2 + b.x1 * rw) * cv.width));
      const y0 = Math.max(0, Math.floor((cy - rh / 2 + b.y0 * rh) * cv.height)), y1 = Math.min(cv.height, Math.ceil((cy - rh / 2 + b.y1 * rh) * cv.height));
      if (x1 <= x0 || y1 <= y0) return null;
      const d = g.getImageData(x0, y0, x1 - x0, y1 - y0).data;
      let l = 0;
      for (let i = 0; i < d.length; i += 4) l += (d[i] * 0.2126 + d[i + 1] * 0.7152 + d[i + 2] * 0.0722) / 255;
      return l / (d.length / 4);
    };
    try {
      for (const fm of forms) {
        let k = 0;
        for (const t of gs) {
          const o = fm.key ? t[fm.key] : t;
          if (!o) continue;
          const lum = await under(t, o, fm);
          const color = lum != null && lum > 0.62 ? pal.ink : o.behind && pal.deep ? pal.deep : k++ % 2 && pal.tint ? pal.tint : pal.paper;
          if (fm.key) t[fm.key].color = color; else t.color = color;
        }
        if (run !== depthRun) return;
      }
    } finally { for (const src of sources.values()) src.close(); }
    lyrStatus(`${big} of ${gs.length} words fill the frame behind the characters, the rest sit in the open space beside them. ${$('#autoLyricsStatus').textContent}`);
    app.changed();
  } catch (e) {
    console.warn('[depth]', e);
    lyrStatus('Could not find the characters (' + (e.message || e) + '), so the words stay in the middle, in front.');
  }
}

// A pro edit's vertical copy is drawn full-frame, where the crop puts the characters somewhere else:
// each lyric line gets its own spot there (`tall`), down the middle third, clear of faces and of the
// app's buttons and caption at the bottom, at a size that reads on a phone (the line's size is a
// share of the width, and 1080 px is narrow), always in front of the characters.
let tallRun = 0;
async function tallLayout() {
  const p = app.project, run = ++tallRun, { w: W, h: H } = formatSize(p);
  if (!(p.auto && p.auto.ctx && p.auto.ctx.pro && W > H)) return;
  const ts = p.texts.filter((t) => t.lyric && t.words && t.words.length);
  // (voice words, one at a time on the speaker's face, find the face again in each frame)
  const vws = p.texts.filter((t) => t.voice && t.voiceAt != null);
  if (!ts.length && !vws.length) return;
  const times = (t) => [0.2, 0.5, 0.85].map((u) => t.start + Math.min(t.dur * u, t.dur - 0.02));
  try {
    const byMedia = new Map();
    for (const t of ts) for (const tm of times(t)) { const at = srcAt(p, tm); if (at) { if (!byMedia.has(at.m)) byMedia.set(at.m, []); byMedia.get(at.m).push(at.s); } }
    for (const t of vws) { const at = srcAt(p, t.voiceAt); if (at) { if (!byMedia.has(at.m)) byMedia.set(at.m, []); byMedia.get(at.m).push(at.s); } }
    for (const [m, tl] of byMedia) {
      await segmentTimes(m, tl, () => {});
      try { await detectFaces(m, tl); } catch (e) { /* placed by the outlines alone */ }
      if (run !== tallRun) return;
    }
    const spots = [[0.5, 0.18], [0.5, 0.3], [0.5, 0.42], [0.5, 0.6], [0.5, 0.72]];
    let prev = null;
    for (const t of ts) {
      let best = null;
      for (const a of spots) {
        const o = { x: a[0], y: a[1], align: 'center', size: (t.size || 0.04) * 1.55, depth: false, depthSpans: undefined, box: [0.1, 0.8] };
        const s = times(t).map((tm) => textSpot(p, { ...t, ...o }, tm, 1080, 1920)).filter(Boolean);
        if (!s.length) continue;
        const face = Math.max(0, ...s.map((q) => q.face)), cover = Math.max(0, ...s.map((q) => q.cover ?? 0));
        const score = face * 6 + cover * 1.5 + (prev === a ? 0.4 : 0) + Math.abs(a[1] - 0.45) * 0.3;
        if (!best || score < best.score) best = { score, o, a };
      }
      // (no spot measured: centred high, in front, never the 16:9 copy's depth spot, which points
      // at where the character was in the wide frame)
      if (best) { t.tall = best.o; prev = best.a; } else t.tall = { x: 0.5, y: 0.3, align: 'center', size: (t.size || 0.04) * 1.55, depth: false, depthSpans: undefined, box: [0.1, 0.8] };
    }
    for (const t of vws) {
      // (a spot the director set for the line keeps its words there)
      if (t.spotFixed) continue;
      Object.assign(t, voiceWordSpot(p, t.voiceAt, W, H));
      t.tall = { ...voiceWordSpot(p, t.voiceAt, 1080, 1920), maxH: 0.075, fit: 0.78 };
    }
    app.changed();
  } catch (e) { console.warn('[tall captions]', e); }
}

async function findCharacters(ph, depthOn = true) {
  const p = app.project, run = ++depthRun, off = p.music.offset;
  const todo = ph.filter((q) => { const d = app.depth.get(lineKey(q)); return !d || (depthOn && d.off); });
  if (!todo.length) return;
  const lineEnd = (q) => { const i = ph.indexOf(q); return Math.min(ph[i + 1] ? ph[i + 1].start : q.end + 0.8, q.end + 0.8) - off; };
  try {
    // where the characters are for every line's time on screen (5 a second)
    const byMedia = new Map();
    for (const q of todo) for (let t = q.start - off + 0.05; t < lineEnd(q); t += 0.2) { const at = srcAt(p, t); if (at) { if (!byMedia.has(at.m)) byMedia.set(at.m, []); byMedia.get(at.m).push(at.s); } }
    let nm = 0;
    for (const [m, ts] of byMedia) { await segmentTimes(m, ts, (x) => lyrStatus(`Finding the characters… ${Math.round(((nm + x) / byMedia.size) * 100)}%`)); nm++; if (run !== depthRun) return; }
    // with depth off the lines are marked done (placed beside the characters, none behind them);
    // switching depth on later works them out properly
    if (!depthOn) { for (const q of todo) app.depth.set(lineKey(q), { off: true }); placeAutoLyrics(false); return; }
    // the shots each line could phase in
    app.depthSegs = {};
    const plans = todo.map((q) => {
      const all = shotSegments(p, (q.hotAt ?? q.start) - off, lineEnd(q)), info = [];
      const segs = all.filter((sg) => {
        let cov = 0, n = 0;
        for (let t = sg.t0 + 0.05; t < sg.t1; t += 0.15) { const at = srcAt(p, t); const st = at && maskStats(maskAt(at.m, at.s)); if (st) { cov += st.coverage; n++; } }
        info.push([+(sg.t1 - sg.t0).toFixed(2), n ? +(cov / n).toFixed(2) : null]);
        if (sg.t1 - sg.t0 < 0.4) return false;
        return n && cov / n > 0.04 && cov / n < 0.7;
      });
      app.depthSegs[lineKey(q)] = { word: q.hotText, from: +((q.hotAt ?? q.start) - off).toFixed(2), to: +lineEnd(q).toFixed(2), segs: info };
      return { q, segs };
    });
    const total = plans.reduce((a2, pl) => a2 + pl.segs.length, 0);
    let done = 0;
    for (const pl of plans) for (const sg of pl.segs) {
      const { cut: cutSrc, start: startSrc } = await segmentFrames(sg.m, sg.s0, sg.s1 + 0.02, (x) => lyrStatus(`Tracing the characters frame by frame… ${Math.round(((done + x) / Math.max(1, total)) * 100)}%`), lyrStatus);
      if (run !== depthRun) return;
      // the shot really starts a little later (its exact cut), and/or ends at a cut found inside
      if (startSrc != null) for (let t = sg.t0; t < sg.t1; t += 1 / 240) { const at = srcAt(p, t); if (at && at.s >= startSrc - 1e-4) { sg.t0 = t; break; } }
      if (cutSrc != null) for (let t = sg.t0; t < sg.t1; t += 1 / 240) { const at = srcAt(p, t); if (at && at.s >= cutSrc - 1e-4) { sg.t1 = t; break; } }
      done++;
    }
    let n = 0;
    for (const pl of plans) {
      const place = depthPlace(p, pl.q, pl.segs.filter((sg) => sg.t1 - sg.t0 >= 0.4));
      app.depth.set(lineKey(pl.q), { place });
      if (place) n++;
    }
    placeAutoLyrics(false);
    lyrStatus(`${n ? `${n} key word${n > 1 ? 's slip' : ' slips'} behind the characters` : 'No spot where a key word could sit behind a character without hiding it, so the text stays in front'}. ${$('#autoLyricsStatus').textContent}`);
    saveOutlines();
  } catch (e) {
    console.warn('[depth]', e);
    lyrStatus('Could not find the characters (' + (e.message || e) + '), so all text stays in front.');
  }
}

// What the shot under a caption looks like: its colour (hue and how strong), brightness,
// motion, and whether a cut or flash hits as the line starts.
function sceneAt(p, a, b) {
  const c = p.clips[clipIndexAt(p.clips, a)], m = c && getMedia(p, c.mediaId);
  const g = m && m.analysis && m.analysis.grid;
  if (!g || !g.phx) return null;
  const s0 = srcTimeAt(c, Math.max(0, a - c.start)), s1 = Math.max(s0 + 0.1, srcTimeAt(c, Math.min(c.dur, b - c.start)));
  const hx = gridMean(g, 'phx', s0, s1), hy = gridMean(g, 'phy', s0, s1);
  let peak = 0, flash = 0;
  for (let k = Math.floor(s0 * g.rate); k <= Math.ceil(s1 * g.rate) && k < g.motion.length; k++) { peak = Math.max(peak, g.motion[k]); flash = Math.max(flash, g.spike[k]); }
  return {
    hue: ((Math.atan2(hy, hx) * 180) / Math.PI + 360) % 360,
    chroma: Math.hypot(hx, hy),
    lum: gridMean(g, 'pl', s0, s1),
    motion: gridMean(g, 'pm', s0, s1),
    peak,
    hit: flash >= 0.7,
  };
}

const hsl = (h, s, l) => {
  const f = (n) => { const k = (n + h / 30) % 12, a = s * Math.min(l, 1 - l); return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))).toString(16).padStart(2, '0'); };
  return `#${f(0)}${f(8)}${f(4)}`;
};

// Caption colours that belong to the scene: white tinted toward the shot's own hue, the key
// word in that hue (gold in warm shots, cyan in blue ones). In a strongly coloured shot the
// key word burns near-white with a glow in the scene colour, so it never sinks into it.
// A spoken line's words spread over its moment (song seconds a..b), each given time in proportion to
// its length, the strongest words starred like the lyrics.
// A voice line's subtitle in phrases (split at its punctuation), each phrase coming in whole as it's
// spoken (the speech onsets the planner found), since a translation can't follow the Japanese word
// for word; without enough onsets the phrases share the line's time.
function voiceWords(v, off) {
  const phrases = String(v.text).split(/(?<=[,.!?…;:—])\s+/).map((ph) => ph.split(/\s+/).filter(Boolean)).filter((x) => x.length);
  const on = (v.onsets && v.onsets.length ? v.onsets : [v.t0]).filter((o) => o < v.t1 - 0.1);
  // (the line's own start is when its first words are heard: its span is measured on the voice; an
  // onset found in the episode's mix, score and all, can come a second late)
  if (!on.length || on[0] > v.t0 + 0.08) on.unshift(v.t0 + 0.02);
  // (each phrase takes the onset as far through the line's speech as it is through the words)
  const total = phrases.reduce((a, ph) => a + ph.length, 0);
  let before = 0;
  const starts = phrases.map((ph) => { const f = before / total; before += ph.length; return on.length >= phrases.length ? on[Math.min(on.length - 1, Math.round(f * on.length))] : on[0] + (v.t1 - on[0]) * f; });
  for (let i = 1; i < starts.length; i++) starts[i] = Math.max(starts[i], starts[i - 1] + 0.25);
  const out = [];
  phrases.forEach((ph, i) => ph.forEach((t) => out.push({ text: starWord(t), start: starts[i] + off, end: (starts[i + 1] ?? v.t1) + off, heard: true, timed: true })));
  return out;
}

function spreadWords(text, a, b) {
  const ws = String(text).split(/\s+/).filter(Boolean).map((t) => starWord(t));
  const wt = ws.map((t) => Math.max(2, t.replace(/[^\p{L}\d]/gu, '').length)), tot = wt.reduce((x, y) => x + y, 0) || 1, span = Math.max(0.2, b - a - 0.15);
  let t = a;
  return ws.map((text, i) => { const w = { text, start: t, end: t + (span * wt[i]) / tot, heard: true, timed: true }; t = w.end; return w; });
}

// A pro edit's caption colours: white words and the key word in the accent the grade keeps (the
// palette's opposite hue, orange against a blue grade), the same all edit long; null outside pro.
function paletteColors(p) {
  const L = p.look && p.look.preset && LOOKS[p.look.preset];
  if (!L || p.look.preset === 'none' || !(p.look.accent > 0)) return null;
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(L.sw[1].slice(i, i + 2), 16) / 255), mx = Math.max(r, g, b), d = mx - Math.min(r, g, b);
  if (d < 0.05) return null;
  const hue = (mx === r ? ((g - b) / d + 6) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4) * 60, h = (hue + 180) % 360;
  // (a second key word, in the stacked look, takes a neighbouring hue)
  return { color: '#ffffff', accent: hsl(h, 0.95, 0.6), glow: hsl(h, 1, 0.45), accent2: hsl((h + 320) % 360, 0.9, 0.62) };
}

function sceneColors(sc, style) {
  const plain = style === 'serif' ? '#f5e6c8' : '#ffffff';
  if (!sc || sc.chroma < 0.08) return { color: plain, accent: '#ffcf5c', glow: '#ffb000' };
  const h = sc.hue, strong = sc.chroma > 0.3;
  // bright shots (a sunlit floor) need a deeper key word to stand out
  if (sc.lum > 0.55) return { color: '#ffffff', accent: hsl(h, 0.95, 0.5), glow: hsl(h, 1, 0.35) };
  return {
    color: hsl(h, strong ? 0.6 : 0.45, 0.93),
    accent: strong ? hsl(h, 0.5, 0.95) : hsl(h, 0.9, 0.66),
    glow: hsl(h, 1, strong ? 0.55 : 0.5),
  };
}

// How a line arrives: it slams in on hits and flashes, pops on busy shots, drifts on calm ones.
function sceneEntrance(sc) {
  if (!sc) return 'drift';
  if (sc.hit || (sc.peak >= 0.95 && sc.motion >= 0.4)) return 'slam';
  return sc.motion > 0.28 || sc.peak >= 0.85 ? 'pop' : 'drift';
}

// Horizontal centre of the action on screen between two timeline times (0..1).
function subjectX(p, a, b) {
  const i = clipIndexAt(p.clips, a);
  const c = p.clips[i], m = c && getMedia(p, c.mediaId);
  const g = m && m.analysis && m.analysis.grid;
  if (!g || !g.sal) return 0.5;
  const s0 = srcTimeAt(c, Math.max(0, a - c.start)), s1 = srcTimeAt(c, Math.min(c.dur, b - c.start));
  return bestCropCenter(salProfile(g, Math.min(s0, s1), Math.max(s0, s1) + 0.05), 0.35).c;
}

function placeLyrics() {
  const p = app.project;
  const raw = $('#lyricsText').value.trim() || $('#autoLyricsPaste').value.trim();
  if (!raw || !p.clips.length) { toast('Paste the song lyrics at the top of the Text tab first', true); return; }
  const mode = $('#lyricsMode').value, style = $('#lyricsStyle').value;
  const st = TEXT_STYLES[style];
  const end = timelineDuration(p);
  const tm = timelineMusic(p);
  const bd = tm && tm.A ? tm.A.beatDur : 0.5;
  let grid = tm && tm.beats.length ? [...tm.beats] : Array.from({ length: Math.ceil(end / bd) }, (_, i) => i * bd);
  if (mode === 'half') grid = grid.flatMap((b, i) => [b, (b + (grid[i + 1] ?? b + bd)) / 2]);
  if (mode === 'line') grid = tm && tm.downbeats.length ? [...tm.downbeats] : grid.filter((_, i) => i % 4 === 0);
  grid = grid.filter((t) => t >= app.player.t - 0.06 && t < end - 0.05);
  const words = mode === 'line' ? raw.split(/\n+/).map((l) => l.trim()).filter(Boolean) : raw.split(/\s+/).filter(Boolean);
  const tokens = mode === 'pair' ? words.reduce((a, w, i) => (i % 2 ? (a[a.length - 1] += ' ' + w) : a.push(w), a), []) : words;
  if (!grid.length) { toast('No beats left after the playhead', true); return; }
  app.history.push();
  const n = Math.min(tokens.length, grid.length);
  for (let i = 0; i < n; i++) {
    const a = grid[i], b = grid[i + 1] ?? Math.min(end, a + (mode === 'line' ? bd * 4 : bd));
    p.texts.push({ id: uid('tx'), text: tokens[i], start: a, dur: Math.max(0.1, b - a - 0.02), style, size: st.size ?? 0.1, y: style === 'subtitle' ? 0.8 : 0.5, color: '#ffffff', anim: style === 'outline' || style === 'impact' ? 'slam' : 'fade', src: 'manual', lyric: true });
  }
  app.changed();
  toast(n < tokens.length ? `Placed ${n} of ${tokens.length} — the edit ran out of beats` : `Placed ${n} lyric captions`);
}

function addText(style) {
  const p = app.project;
  if (!p.clips.length) return;
  app.history.push();
  const st = TEXT_STYLES[style] || {};
  const label = style === 'jp' ? '最強' : style === 'tag' ? '@yourname' : 'YOUR TEXT';
  const t = { id: uid('tx'), text: label, start: app.player.t, dur: style === 'tag' ? Math.max(2, timelineDuration(p) - app.player.t) : 2, style, size: st.size ?? (style === 'subtitle' ? 0.055 : 0.12), y: st.y ?? (style === 'subtitle' ? 0.8 : 0.5), color: '#ffffff', anim: style === 'tag' ? 'none' : style === 'serif' || style === 'minimal' ? 'fade' : 'pop', src: 'manual' };
  p.texts.push(t);
  app.select({ kind: 'text', id: t.id });
  app.changed();
}

const rgbHex = (c) => '#' + c.map((v) => Math.round(clamp(v, 0, 1) * 255).toString(16).padStart(2, '0')).join('');

// ---------- watermark ----------
function renderWatermark() {
  const wm = app.project.watermark;
  const el = $('#wmPanel');
  el.innerHTML = wm ? `<div class="wm-preview"><img src="${wm.src}" alt="Your watermark"></div>
      <div class="sliders">${sliderField('Opacity', wm.opacity, 0.15, 1, 0.05, (v) => { wm.opacity = v; saveWatermark(wm); })}${sliderField('Size', wm.size, 0.04, 0.3, 0.01, (v) => { wm.size = v; saveWatermark(wm); })}</div>
      <div class="field"><label>Corner</label><div class="seg" id="wmCorner">${[['br', 'Bottom right'], ['bl', 'Bottom left'], ['tr', 'Top right'], ['tl', 'Top left']].map(([k, l]) => `<button data-c="${k}" class="${wm.corner === k ? 'on' : ''}">${l}</button>`).join('')}</div></div>
      <div class="ai-actions"><button class="btn small" id="wmPick">Change logo…</button><button class="btn small" id="wmRemove">Remove</button></div>`
    : `<div class="ai-actions"><button class="btn small primary" id="wmPick">Choose logo…</button></div>`;
  $('#wmPick').onclick = () => $('#wmFile').click();
  if (wm) {
    $('#wmRemove').onclick = () => { app.project.watermark = null; saveWatermark(null); renderWatermark(); app.player.invalidate(); };
    $('#wmCorner').querySelectorAll('[data-c]').forEach((b) => { b.onclick = () => { wm.corner = b.dataset.c; saveWatermark(wm); renderWatermark(); app.player.invalidate(); }; });
  }
}
$('#wmFile').onchange = async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (f) await setWatermark(f);
};
// keyed and remembered for every video from now on
async function setWatermark(file) {
  try {
    const src = await keyLogo(file);
    app.project.watermark = { ...WATERMARK_DEFAULT, ...(app.project.watermark || {}), src };
    saveWatermark(app.project.watermark);
    renderWatermark();
    app.player.invalidate();
    toast('Watermark added: it will be on every video you export');
  } catch (err) { toast(err.message || "Couldn't read that image", true); }
}
app.setWatermark = setWatermark;
renderWatermark();

function renderLook() {
  const look = app.project.look;
  $('#lookGrid').innerHTML = Object.entries(LOOKS).map(([k, l]) => `<button class="look-chip ${look.preset === k ? 'active' : ''}" data-look="${k}"><div class="sw" style="background:linear-gradient(135deg,${l.sw[0]},${l.sw[1]})"></div>${esc(l.label)}</button>`).join('');
  $('#lookGrid').querySelectorAll('[data-look]').forEach((b) => {
    b.onclick = () => { app.history.push(); applyLookPreset(app.project.look, b.dataset.look); renderLook(); app.player.invalidate(); };
  });
  const rows = [
    ['Grade'], ['exposure', 'Exposure', -1, 1, 0.01], ['contrast', 'Contrast', 0.5, 1.6, 0.01], ['saturation', 'Saturation', 0, 2, 0.01],
    ['temperature', 'Temperature', -1, 1, 0.01], ['tint', 'Tint', -1, 1, 0.01], ['fade', 'Fade', 0, 1, 0.01],
    ['duoAmt', 'Duotone', 0, 1, 0.01],
    ['Finish'], ['glow', 'Glow', 0, 1, 0.01], ['glowThreshold', 'Glow threshold', 0.2, 0.95, 0.01], ['sharpen', 'Sharpen', 0, 1, 0.01], ['clarity', 'Clarity', 0, 1, 0.01], ['depth', 'Depth (deep blacks)', 0, 1, 0.01], ['rich', 'Rich colour', 0, 1, 0.01], ['motionBlur', 'Motion blur', 0, 1, 0.01],
    ['vignette', 'Vignette', 0, 1, 0.01], ['grain', 'Grain', 0, 1, 0.01], ['chroma', 'Chromatic', 0, 1, 0.01], ['vhs', 'VHS', 0, 1, 0.01], ['leaks', 'Light leaks', 0, 1, 0.01],
    ['FX boost'], ['vibrance', 'Vibrance', 0, 1, 0.01], ['fxGlow', 'Effect glow', 0, 1, 0.01],
  ];
  $('#lookSliders').innerHTML = rows.map((r) => r.length === 1 ? `<div class="section-title">${r[0]}</div>` : `<div class="slider-row"><span>${r[1]}</span><input type="range" min="${r[2]}" max="${r[3]}" step="${r[4]}" value="${look[r[0]] ?? 0}" data-k="${r[0]}"><output>${(+(look[r[0]] ?? 0)).toFixed(2)}</output></div>`).join('')
    + `<div class="slider-row"><span>Duotone color</span><input type="color" id="duoColor" value="${rgbHex(look.duo || [1, 0.45, 0.1])}"><output></output></div>`
    + `<div class="ai-actions" style="margin-top:10px"><button class="btn small primary" id="lookAutoMatch">🎨 Auto Color-Match All Clips</button><button class="btn small" id="lookResetClips">Reset Clip Grades</button></div>`;
  $('#duoColor').onchange = (e) => {
    app.history.push();
    const n = parseInt(e.target.value.slice(1), 16);
    app.project.look.duo = [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
    if (!app.project.look.duoAmt) app.project.look.duoAmt = 0.5;
    renderLook();
    app.player.invalidate();
  };
  if ($('#lookAutoMatch')) {
    $('#lookAutoMatch').onclick = () => {
      app.history.push();
      const n = autoColorMatch(app.project);
      app.changed();
      toast(n ? `Color-matched ${n} clips` : 'Analyze at least 2 clips first', !n);
    };
  }
  if ($('#lookResetClips')) {
    $('#lookResetClips').onclick = () => {
      app.history.push();
      for (const c of app.project.clips) delete c.grade;
      app.changed();
      toast('Per-clip grades cleared');
    };
  }
  $('#lookSliders').querySelectorAll('input').forEach((inp) => {
    inp.onpointerdown = () => app.history.push();
    inp.oninput = () => {
      app.project.look[inp.dataset.k] = +inp.value;
      inp.nextElementSibling.textContent = (+inp.value).toFixed(2);
      app.player.invalidate();
    };
  });
}

// ---------- selection helpers ----------
function findSel(sel) {
  const p = app.project;
  if (!sel) return null;
  if (sel.kind === 'fx') return p.effects.find((e) => e.id === sel.id);
  if (sel.kind === 'ovl') return (p.overlays || []).find((e) => e.id === sel.id);
  if (sel.kind === 'text') return p.texts.find((e) => e.id === sel.id);
  if (sel.kind === 'clip') return p.clips.find((e) => e.id === sel.id);
  if (sel.kind === 'music') return p.music && p.music.mediaId === sel.id ? p.music : null;
  if (sel.kind === 'sfx') return (p.sfx || []).find((e) => e.id === sel.id);
  return null;
}

function deleteSelection() {
  const p = app.project, sel = app.sel;
  if (!sel || !findSel(sel)) return;
  app.history.push();
  if (sel.kind === 'fx') p.effects = p.effects.filter((e) => e.id !== sel.id);
  if (sel.kind === 'ovl') p.overlays = (p.overlays || []).filter((e) => e.id !== sel.id);
  if (sel.kind === 'text') { if (findSel(sel).lyric) app.captionEdits = true; p.texts = p.texts.filter((e) => e.id !== sel.id); }
  if (sel.kind === 'clip') { p.clips = p.clips.filter((e) => e.id !== sel.id); relayout(p.clips); }
  if (sel.kind === 'music') p.music = null;
  if (sel.kind === 'sfx') p.sfx = p.sfx.filter((e) => e.id !== sel.id);
  app.sel = null;
  app.changed();
  renderMedia();
}

function sliceKeys(keys, a, b) {
  if (!keys) return null;
  const out = [];
  for (let i = 0; i <= 8; i++) out.push([i / 8, +speedFromKeys(keys, a + ((b - a) * i) / 8).toFixed(4)]);
  return out;
}

function splitAtPlayhead() {
  const p = app.project, t = app.player.t;
  const i = clipIndexAt(p.clips, t);
  if (i < 0) return;
  const c = p.clips[i], local = t - c.start;
  if (local < 0.05 || c.dur - local < 0.05) return;
  app.history.push();
  const f = local / c.dur;
  const b = { ...structuredClone(c), id: uid('c'), start: t, dur: c.dur - local, srcIn: srcTimeAt(c, local), speedKeys: sliceKeys(c.speedKeys, f, 1), isDrop: false };
  // a spoken line's cut-off is measured from its clip's start: the second half's starts later
  if (c.audioOut != null) { b.audioOut = c.audioOut - local; if (b.audioOut <= 0) b.volume = 0; }
  delete b.voiceAudio; // (a voice line over the cuts stays with the first half, timed from its start)
  if (c.pan) { const mid = c.pan[0] + (c.pan[1] - c.pan[0]) * f; b.pan = [mid, c.pan[1]]; c.pan = [c.pan[0], mid]; }
  c.speedKeys = sliceKeys(c.speedKeys, 0, f);
  c.dur = local;
  p.clips.splice(i + 1, 0, b);
  relayout(p.clips);
  app.select({ kind: 'clip', id: b.id });
  app.changed();
}

// ---------- inspector ----------
const SPEEDS = {
  normal: { label: 'Normal', keys: null },
  slow: { label: '0.5×', keys: [[0, 0.5], [1, 0.5]] },
  fast: { label: '2×', keys: [[0, 2], [1, 2]] },
  swell: { label: 'Velocity', keys: SPEED_CURVES.swell },
  hit: { label: 'Hit', keys: SPEED_CURVES.hit },
  montage: { label: 'Montage', keys: SPEED_CURVES.montage },
  hero: { label: 'Hero', keys: SPEED_CURVES.hero },
  bullet: { label: 'Bullet', keys: SPEED_CURVES.bullet },
  jumpcut: { label: 'Jump cut', keys: SPEED_CURVES.jumpcut },
  flashin: { label: 'Flash in', keys: SPEED_CURVES.flashin },
  flashout: { label: 'Flash out', keys: SPEED_CURVES.flashout },
  freeze: { label: 'Freeze', keys: SPEED_CURVES.freeze },
};

function sliderField(label, value, min, max, step, onInput, fmt = (v) => (+v).toFixed(2)) {
  const id = uid('f');
  setTimeout(() => {
    const inp = document.getElementById(id);
    if (!inp) return;
    inp.onpointerdown = () => app.history.push();
    inp.oninput = () => { onInput(+inp.value); inp.nextElementSibling.textContent = fmt(inp.value); app.player.invalidate(); app.timeline.render(); if (app.gizmo) app.gizmo.render(); };
  });
  return `<div class="slider-row"><span>${esc(label)}</span><input id="${id}" type="range" min="${min}" max="${max}" step="${step}" value="${value}"><output>${fmt(value)}</output></div>`;
}

function renderInspector() {
  const el = $('#inspector');
  const p = app.project, sel = app.sel, obj = findSel(sel);
  if (!obj) {
    const d = timelineDuration(p);
    el.innerHTML = `<div class="insp-head"><div class="si" style="background:var(--grad);color:#fff">桜</div><div><h3>Project</h3><div class="sub">${esc(formatSize(p).label || p.format)} · ${fmtTime(d)}</div></div></div>
      <div class="field"><label>Timeline</label><div class="sub" style="color:var(--muted);font-size:12px">${p.clips.length} clips · ${p.effects.length} effects · ${p.texts.length} texts</div></div>
      <div class="section-title">Shortcuts</div>
      <div class="hint" style="line-height:2">
      <kbd>Space</kbd> play / pause<br><kbd>S</kbd> split clip at playhead<br><kbd>⌫</kbd> delete selection<br><kbd>⌘Z</kbd> / <kbd>⇧⌘Z</kbd> undo / redo<br>
      <kbd>←</kbd><kbd>→</kbd> step a frame · <kbd>⇧</kbd>+arrows jump beats<br>
      <kbd>F</kbd> flash · <kbd>Z</kbd> zoom · <kbd>X</kbd> shake · <kbd>G</kbd> glitch · <kbd>R</kbd> RGB at the playhead (tap them while playing!)<br>
      <kbd>⌘</kbd>+scroll zooms the timeline</div>`;
    return;
  }
  const commitAnd = (fn) => { app.history.push(); fn(); if (obj.src && obj.src !== 'manual') obj.src = 'manual'; if (obj.lyric) app.captionEdits = true; app.changed(); };

  if (sel.kind === 'fx') {
    const def = FX[obj.type];
    const fromS = obj.src && obj.src !== 'manual' ? app.suggestions.find((s) => s.id === obj.src) : null;
    let html = `<div class="insp-head"><div class="si" style="background:${def.color}">${def.icon}</div><div><h3>${esc(def.label)}</h3><div class="sub">${fromS ? 'Auto · ' + esc(fromS.title) : 'Effect'}</div></div></div>
      <div class="field"><label>Type</label><select id="iType">${Object.entries(FX).map(([k, d]) => `<option value="${k}" ${k === obj.type ? 'selected' : ''}>${esc(d.label)}</option>`).join('')}</select></div>
      <div class="field-row"><div class="field"><label>Start (s)</label><input type="number" id="iStart" step="0.01" min="0" value="${obj.start.toFixed(2)}"></div>
      <div class="field"><label>Duration (s)</label><input type="number" id="iDur" step="0.01" min="0.05" value="${obj.dur.toFixed(2)}"></div></div>`;
    for (const [k, d] of Object.entries(def.params || {})) {
      const v = obj.params[k] ?? d.def;
      if (d.type === 'vfx') {
        // the VFX library, grouped by kind
        const groups = new Map();
        for (const a of (vfxManifest() || { effects: [] }).effects) { const g = (a.tags || ['other'])[0]; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(a); }
        html += `<div class="field"><label>${esc(d.label)}</label><select data-vfx="${k}"><option value="">Choose…</option>${[...groups].map(([g, list]) => `<optgroup label="${esc(g)}">${list.map((a) => `<option value="${esc(a.id)}" ${a.id === v ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</optgroup>`).join('')}</select></div>`;
      } else if (d.type === 'color') html += `<div class="field"><label>${esc(d.label)}</label><input type="color" data-p="${k}" value="${v}"></div>`;
      else if (d.type === 'select') html += `<div class="field"><label>${esc(d.label)}</label><div class="seg">${d.options.map((o) => `<button data-seg="${k}" data-v="${o}" class="${o === v ? 'on' : ''}">${o}</button>`).join('')}</div></div>`;
      else html += sliderField(d.label, v, d.min, d.max, d.step, (x) => { obj.params[k] = x; if (obj.src !== 'manual') obj.src = 'manual'; });
    }
    html += `<div class="field"><button class="btn small" id="iFxCurve">📈 Keyframe Intensity Curve</button></div>`;
    html += `<div class="insp-actions"><button class="btn small" id="iJump">▶ Preview</button><button class="btn small" id="iDup">Duplicate on next beat</button><button class="btn small danger" id="iDel">Delete</button></div>`;
    el.innerHTML = html;
    // a moved or restyled camera move re-aims at the character for its new span
    const retrack = () => { if (obj.type === 'camera') ensureFxMasks(); };
    $('#iFxCurve').onclick = () => app.graphEditor.open({ type: 'fx', id: obj.id, prop: 'intensity' });
    $('#iType').onchange = (e) => { commitAnd(() => { obj.type = e.target.value; obj.params = defaultParams(obj.type); }); retrack(); };
    $('#iStart').onchange = (e) => { commitAnd(() => { obj.start = Math.max(0, +e.target.value); }); retrack(); };
    $('#iDur').onchange = (e) => { commitAnd(() => { obj.dur = Math.max(0.05, +e.target.value); }); retrack(); };
    el.querySelectorAll('[data-p]').forEach((i) => { i.onchange = () => commitAnd(() => { obj.params[i.dataset.p] = i.value; }); });
    // picking an overlay sets the effect to its natural length
    el.querySelectorAll('[data-vfx]').forEach((i) => { i.onchange = () => commitAnd(() => { obj.params[i.dataset.vfx] = i.value; const a = vfxAsset(i.value); if (a && !a.loop && !a.still) obj.dur = Math.max(0.1, a.frames / (a.fps || 12) / (obj.params.speed || 1)); }); });
    el.querySelectorAll('[data-seg]').forEach((b) => { b.onclick = () => { commitAnd(() => { obj.params[b.dataset.seg] = b.dataset.v; if (b.dataset.seg === 'mode') obj.params.auto = false; }); retrack(); }; });
    $('#iJump').onclick = () => { app.player.seek(Math.max(0, obj.start - 0.6)); app.player.play(); };
    $('#iDup').onclick = () => {
      const tm = timelineMusic(p);
      const nb = tm && tm.beats.find((b) => b > obj.start + 0.05);
      const t = nb != null ? nb : obj.start + obj.dur;
      app.history.push();
      const e2 = { ...structuredClone(obj), id: uid('fx'), start: t, src: 'manual' };
      p.effects.push(e2);
      app.sel = { kind: 'fx', id: e2.id };
      app.changed();
    };
    $('#iDel').onclick = deleteSelection;
    return;
  }

  if (sel.kind === 'ovl') {
    const m = getMedia(p, obj.mediaId);
    const BLENDS = ['screen', 'normal', 'add', 'overlay', 'multiply'];
    el.innerHTML = `<div class="insp-head"><div class="si" style="background:#38bdf8;color:#08101c">▣</div><div><h3>Overlay</h3><div class="sub">${esc(m ? m.name : 'missing')} · ${fmtTime(obj.start)}</div></div></div>
      <div class="field-row"><div class="field"><label>Start (s)</label><input type="number" id="iStart" step="0.01" min="0" value="${obj.start.toFixed(2)}"></div>
      <div class="field"><label>Duration (s)</label><input type="number" id="iDur" step="0.01" min="0.1" value="${obj.dur.toFixed(2)}"></div></div>
      <div class="field"><label>Blend Mode</label><div class="seg">${BLENDS.map((b) => `<button data-blend="${b}" class="${(obj.blend || 'screen') === b ? 'on' : ''}">${b}</button>`).join('')}</div></div>
      <div class="sliders" style="margin:0 0 12px">
        ${sliderField('Opacity', obj.opacity ?? 1, 0, 1, 0.01, (v) => { obj.opacity = v; })}
        ${sliderField('Scale', obj.scale ?? 1, 0.1, 3.5, 0.01, (v) => { obj.scale = v; })}
        ${sliderField('Position X', obj.x ?? 0.5, 0, 1, 0.01, (v) => { obj.x = v; })}
        ${sliderField('Position Y', obj.y ?? 0.5, 0, 1, 0.01, (v) => { obj.y = v; })}
        ${sliderField('Rotation', Math.round(((obj.rot || 0) * 180) / Math.PI), -180, 180, 1, (v) => { obj.rot = (v * Math.PI) / 180; }, (v) => `${Math.round(v)}°`)}
      </div>
      <label class="toggle" style="margin:0 0 8px"><input type="checkbox" id="iLumaKey" ${obj.lumaKey ? 'checked' : ''}><span>Luma Key (remove black bg)</span></label>
      <label class="toggle" style="margin:0 0 12px"><input type="checkbox" id="iOvlBehind" ${obj.behind ? 'checked' : ''}><span>Behind Subject (requires matte)</span></label>
      <div class="insp-actions"><button class="btn small danger" id="iDel">Delete</button></div>`;
    $('#iStart').onchange = (e) => commitAnd(() => { obj.start = Math.max(0, +e.target.value); });
    $('#iDur').onchange = (e) => commitAnd(() => { obj.dur = Math.max(0.1, +e.target.value); });
    el.querySelectorAll('[data-blend]').forEach((b) => { b.onclick = () => commitAnd(() => { obj.blend = b.dataset.blend; }); });
    $('#iLumaKey').onchange = (e) => commitAnd(() => { obj.lumaKey = e.target.checked; });
    $('#iOvlBehind').onchange = (e) => commitAnd(() => { obj.behind = e.target.checked; });
    $('#iDel').onclick = deleteSelection;
    return;
  }

  if (sel.kind === 'text') {
    const curFont = obj.font || (TEXT_STYLES[obj.style] && TEXT_STYLES[obj.style].font) || TEXT_FONTS[0];
    const hasGrad = Array.isArray(obj.gradient) && obj.gradient.length >= 2;
    const letters = Array.isArray(obj.letters) ? obj.letters : null;
    el.innerHTML = `<div class="insp-head"><div class="si" style="background:#a855f7;color:#fff">T</div><div><h3>Text</h3><div class="sub">${fmtTime(obj.start)} · ${obj.dur.toFixed(2)}s</div></div></div>
      <div class="field"><label>Text</label><textarea id="iText">${esc(obj.text)}</textarea></div>
      <div class="field"><label>Font</label><select id="iFont">${TEXT_FONTS.map((f) => `<option value="${esc(f)}" ${f === curFont ? 'selected' : ''}>${esc(f)}</option>`).join('')}</select></div>
      <div class="field"><label>Style</label><div class="seg">${Object.entries(TEXT_STYLES).map(([k, s]) => `<button data-style="${k}" class="${k === obj.style ? 'on' : ''}">${esc(s.label)}</button>`).join('')}</div></div>
      <div class="field"><label>Animation</label><div class="seg">${Object.entries(TEXT_ANIMS).map(([k, l]) => `<button data-anim="${k}" class="${k === obj.anim ? 'on' : ''}">${esc(l)}</button>`).join('')}</div></div>
      <div class="sliders" style="margin:0 0 12px">
        ${sliderField('Size', obj.size, 0.03, 0.35, 0.005, (v) => { obj.size = v; })}
        ${sliderField('Pos X', obj.x ?? 0.5, 0.05, 0.95, 0.01, (v) => { obj.x = v; })}
        ${sliderField('Pos Y', obj.y ?? 0.5, 0.05, 0.95, 0.01, (v) => { obj.y = v; })}
        ${sliderField('Rotation', Math.round(((obj.rot || 0) * 180) / Math.PI), -180, 180, 1, (v) => { obj.rot = (v * Math.PI) / 180; }, (v) => `${Math.round(v)}°`)}
        ${sliderField('3D Tilt', obj.persp || 0, -0.45, 0.45, 0.01, (v) => { obj.persp = v; })}
        ${sliderField('Tracking', obj.tracking ?? 0, -0.05, 0.4, 0.005, (v) => { obj.tracking = v; })}
        ${sliderField('Split Gap', obj.splitGap || 0, 0, 0.45, 0.005, (v) => { obj.splitGap = v; })}
        ${sliderField('Stroke W', obj.strokeW ?? 0, 0, 0.25, 0.005, (v) => { obj.strokeW = v; })}
        ${sliderField('Glow', obj.glowAmt ?? 0, 0, 1, 0.02, (v) => { obj.glowAmt = v; })}
      </div>
      <div class="field-row" style="margin-bottom:8px">
        <div class="field"><label>Fill</label><input type="color" id="iColor" value="${obj.color || '#ffffff'}"></div>
        <div class="field"><label>Stroke / Glow</label><div style="display:flex;gap:6px"><input type="color" id="iStrokeCol" value="${obj.strokeColor || '#000000'}" title="Stroke color"><input type="color" id="iGlowCol" value="${obj.glowColor || '#ff4d8d'}" title="Glow color"></div></div>
      </div>
      <label class="toggle" style="margin:0 0 8px"><input type="checkbox" id="iGradOn" ${hasGrad ? 'checked' : ''}><span>Two-tone gradient fill</span></label>
      ${hasGrad ? `<div class="field-row" style="margin-bottom:8px"><div class="field"><label>Top</label><input type="color" id="iGradA" value="${obj.gradient[0]}"></div><div class="field"><label>Bottom</label><input type="color" id="iGradB" value="${obj.gradient[1]}"></div></div>` : ''}
      <label class="toggle" style="margin:0 0 8px"><input type="checkbox" id="iBehind" ${obj.behind ? 'checked' : ''}><span>Place behind character (depth)</span></label>
      <div class="section-title">Per-Letter Lock Mode</div>
      <div class="ai-actions" style="margin-bottom:8px">
        <button class="btn small" id="iLettersToggle">${letters ? 'Exit Per-Letter Mode' : 'Split into Per-Letter Handles'}</button>
        ${letters ? '<button class="btn small" id="iLettersReset">Reset Letters</button>' : ''}
      </div>
      ${letters ? `<div class="field" style="max-height:130px;overflow:auto">${letters.map((L, idx) => `<div style="display:grid;grid-template-columns:24px 1fr auto;gap:6px;align-items:center;margin-bottom:4px;font-size:11px"><b>${esc(L.ch)}</b><input type="number" data-ldel="${idx}" min="0" max="2" step="0.02" value="${(L.delay || 0).toFixed(2)}" title="Delay (s)"><label><input type="checkbox" data-lhid="${idx}" ${L.hidden ? 'checked' : ''}> hide</label></div>`).join('')}</div>` : ''}
      <div class="field-row"><div class="field"><label>Start (s)</label><input type="number" id="iStart" step="0.01" min="0" value="${obj.start.toFixed(2)}"></div>
      <div class="field"><label>Duration (s)</label><input type="number" id="iDur" step="0.01" min="0.1" value="${obj.dur.toFixed(2)}"></div></div>
      <div class="insp-actions"><button class="btn small danger" id="iDel">Delete</button></div>`;
    const ta = $('#iText');
    ta.onfocus = () => app.history.push();
    ta.oninput = () => {
      obj.text = ta.value; obj.src = 'manual';
      if (obj.lyric) app.captionEdits = true;
      if (obj.words) {
        const ws = ta.value.trim().split(/\s+/);
        if (ws.length === obj.words.length) ws.forEach((w, i) => { obj.words[i].text = w; }); else delete obj.words;
      }
      app.player.invalidate(); app.timeline.render(); if (app.gizmo) app.gizmo.render();
    };
    $('#iFont').onchange = (e) => commitAnd(() => { obj.font = e.target.value; });
    el.querySelectorAll('[data-style]').forEach((b) => { b.onclick = () => commitAnd(() => { obj.style = b.dataset.style; }); });
    el.querySelectorAll('[data-anim]').forEach((b) => { b.onclick = () => commitAnd(() => { obj.anim = b.dataset.anim; }); });
    $('#iColor').onchange = (e) => commitAnd(() => { obj.color = e.target.value; });
    $('#iStrokeCol').onchange = (e) => commitAnd(() => { obj.strokeColor = e.target.value; if (!obj.strokeW) obj.strokeW = 0.06; });
    $('#iGlowCol').onchange = (e) => commitAnd(() => { obj.glowColor = e.target.value; if (!obj.glowAmt) obj.glowAmt = 0.55; });
    $('#iGradOn').onchange = (e) => commitAnd(() => { if (e.target.checked) obj.gradient = [obj.color || '#ffffff', '#ff4d8d']; else delete obj.gradient; });
    if ($('#iGradA')) $('#iGradA').onchange = (e) => commitAnd(() => { obj.gradient = [e.target.value, obj.gradient[1]]; });
    if ($('#iGradB')) $('#iGradB').onchange = (e) => commitAnd(() => { obj.gradient = [obj.gradient[0], e.target.value]; });
    $('#iBehind').onchange = (e) => commitAnd(() => { obj.behind = e.target.checked; });
    const initLetters = () => [...(obj.text || '')].map((ch, i, a) => ({ ch, dx: +((i - (a.length - 1) / 2) * (obj.size || 0.12) * 0.72).toFixed(4), dy: 0, scale: 1, rot: 0, delay: +(i * 0.035).toFixed(3), hidden: false }));
    $('#iLettersToggle').onclick = () => commitAnd(() => { if (Array.isArray(obj.letters)) delete obj.letters; else obj.letters = initLetters(); });
    if ($('#iLettersReset')) $('#iLettersReset').onclick = () => commitAnd(() => { obj.letters = initLetters(); });
    el.querySelectorAll('[data-ldel]').forEach((inp) => { inp.onchange = (e) => commitAnd(() => { obj.letters[+inp.dataset.ldel].delay = Math.max(0, +e.target.value); }); });
    el.querySelectorAll('[data-lhid]').forEach((chk) => { chk.onchange = (e) => commitAnd(() => { obj.letters[+chk.dataset.lhid].hidden = e.target.checked; }); });
    $('#iStart').onchange = (e) => commitAnd(() => { obj.start = Math.max(0, +e.target.value); });
    $('#iDur').onchange = (e) => commitAnd(() => { obj.dur = Math.max(0.1, +e.target.value); });
    $('#iDel').onclick = deleteSelection;
    return;
  }

  if (sel.kind === 'clip') {
    const m = getMedia(p, obj.mediaId);
    const sig = JSON.stringify(obj.speedKeys);
    const cur = Object.entries(SPEEDS).find(([, s]) => JSON.stringify(s.keys) === sig)?.[0];
    const span = clipSpan(obj);
    const { w, h } = formatSize(p);
    const canPan = m && m.w / m.h > (w / h) * 1.05;
    const panC = obj.pan ? (obj.pan[0] + obj.pan[1]) / 2 : 0.5;
    const g = obj.grade || {};
    const clipIdx = p.clips.indexOf(obj);
    const kfRow = (label, prop) => {
      const keyed = prop === 'speed' ? (obj.speedKeys && obj.speedKeys.some((k) => !Array.isArray(k))) : !!(obj.kf && obj.kf[prop]);
      return `<button class="ge-pre${keyed ? ' active' : ''}" data-kf="${prop}" title="Edit ${label} curve">📈 ${label}</button>`;
    };
    el.innerHTML = `<div class="insp-head"><div class="si" style="background:#fbbf24">▶</div><div><h3>Clip</h3><div class="sub">${esc(m ? m.name : 'missing')} · ${fmtTime(obj.srcIn)}–${fmtTime(obj.srcIn + span)}</div></div></div>
      <div class="field"><label>Speed</label><div class="seg">${Object.entries(SPEEDS).map(([k, s]) => `<button data-speed="${k}" class="${k === cur ? 'on' : ''}">${s.label}</button>`).join('')}</div>${cur ? '' : '<div class="sub" style="color:var(--muted);font-size:11px">Custom ramp</div>'}</div>
      <div class="field"><label>Keyframe Curves</label><div class="ge-presets">${kfRow('Speed', 'speed')}${kfRow('Zoom', 'zoom')}${kfRow('Pan X', 'panX')}${kfRow('Pan Y', 'panY')}${kfRow('Rot', 'rot')}${kfRow('Exposure', 'exposure')}</div></div>
      <div class="sliders" style="margin:0 0 12px">
        ${m ? sliderField('Source in', obj.srcIn, 0, Math.max(0.01, m.duration - span), 0.01, (v) => { obj.srcIn = v; }, (v) => fmtTime(+v)) : ''}
        ${canPan ? sliderField('Reframe X', panC, 0, 1, 0.01, (v) => { obj.pan = [v, v]; obj.focus = v; }) : ''}
        ${sliderField('Pan Y', obj.panY ?? 0.5, 0.05, 0.95, 0.01, (v) => { obj.panY = v; })}
        ${sliderField('Zoom', obj.zoom || 1, 1, 2.5, 0.01, (v) => { obj.zoom = v; })}
        ${sliderField('Rotation', Math.round(((obj.rot || 0) * 180) / Math.PI), -180, 180, 1, (v) => { obj.rot = (v * Math.PI) / 180; }, (v) => `${Math.round(v)}°`)}
        ${m ? sliderField('Clip audio', obj.volume || 0, 0, 1.5, 0.01, (v) => { obj.volume = v; }) : ''}
      </div>
      <label class="toggle" style="margin:0 0 10px"><input type="checkbox" id="iMirror" ${obj.mirror ? 'checked' : ''}><span>Mirror horizontal</span></label>
      <div class="section-title">Per-Clip Color Grade</div>
      <div class="sliders" style="margin:0 0 8px">
        ${sliderField('Exposure', g.exposure || 0, -1, 1, 0.01, (v) => { obj.grade = { ...(obj.grade || {}), exposure: v }; })}
        ${sliderField('Contrast', g.contrast ?? 1, 0.5, 1.6, 0.01, (v) => { obj.grade = { ...(obj.grade || {}), contrast: v }; })}
        ${sliderField('Saturation', g.saturation ?? 1, 0, 2, 0.01, (v) => { obj.grade = { ...(obj.grade || {}), saturation: v }; })}
        ${sliderField('Temp', g.temperature || 0, -0.5, 0.5, 0.01, (v) => { obj.grade = { ...(obj.grade || {}), temperature: v }; })}
      </div>
      <div class="ai-actions" style="margin-bottom:10px">
        ${clipIdx > 0 ? '<button class="btn small" id="iMatchPrev">🎨 Match Prev Clip</button><button class="btn small" id="iMatchCut">⚡ Match-Cut Align</button>' : ''}
        <button class="btn small" id="iGradeReset">Reset Grade</button>
      </div>
      ${Array.isArray(obj.alts) && obj.alts.length ? `<div class="field"><label>Shot Swapper (alternates)</label><div class="swap-grid" id="iSwapGrid">${obj.alts.slice(0, 6).map((a, idx) => `<button class="swap-tile" data-alt="${idx}" title="${esc(a.reason || 'alt')} · score ${a.score}"><span>${fmtTime(a.srcIn)}</span></button>`).join('')}</div></div>` : ''}
      ${canPan && m.analysis ? '<div class="field"><button class="btn small" id="iFollow">⛶ Follow the action</button></div>' : ''}
      <div class="insp-actions"><button class="btn small" id="iSplit">✂ Split at playhead</button><button class="btn small danger" id="iDel">Delete</button></div>`;
    el.querySelectorAll('[data-kf]').forEach((b) => { b.onclick = () => app.graphEditor.open({ type: 'clip', id: obj.id, prop: b.dataset.kf }); });
    $('#iMirror').onchange = (e) => commitAnd(() => { obj.mirror = e.target.checked; });
    if ($('#iMatchPrev')) {
      $('#iMatchPrev').onclick = () => commitAnd(() => {
        const prev = p.clips[clipIdx - 1];
        const pm = prev && getMedia(p, prev.mediaId);
        if (!pm || !pm.analysis?.grid || !m || !m.analysis?.grid) { toast('Analyze footage first to match levels', true); return; }
        const l0 = gridMean(pm.analysis.grid, 'pl', prev.srcIn, prev.srcIn + clipSpan(prev));
        const l1 = gridMean(m.analysis.grid, 'pl', obj.srcIn, obj.srcIn + span);
        const s0 = pm.analysis.grid.ps ? gridMean(pm.analysis.grid, 'ps', prev.srcIn, prev.srcIn + clipSpan(prev)) : 0.3;
        const s1 = m.analysis.grid.ps ? gridMean(m.analysis.grid, 'ps', obj.srcIn, obj.srcIn + span) : 0.3;
        obj.grade = {
          ...(obj.grade || {}),
          exposure: +clamp((l0 - l1) * 1.4, -0.5, 0.5).toFixed(3),
          saturation: +clamp(s0 > 0.04 && s1 > 0.04 ? s0 / s1 : 1, 0.75, 1.35).toFixed(3),
        };
      });
    }
    if ($('#iMatchCut')) {
      $('#iMatchCut').onclick = () => commitAnd(() => {
        const prev = p.clips[clipIdx - 1];
        const pm = prev && getMedia(p, prev.mediaId);
        const outPose = extractPose(pm, (prev.srcIn || 0) + Math.max(0, clipSpan(prev) - 0.05));
        const inPose = extractPose(m, obj.srcIn);
        const pair = scorePosePair(outPose, inPose);
        const al = computeAlignTransform(outPose, inPose, pair.mirrorRecommended);
        obj.mirror = al.mirror;
        obj.pan = [al.panX, al.panX];
        obj.panY = al.panY;
        obj.zoom = al.zoom;
        toast(`Match-cut aligned (${Math.round(pair.score * 100)}% fit${al.mirror ? ', mirrored' : ''})`);
      });
    }
    $('#iGradeReset').onclick = () => commitAnd(() => { delete obj.grade; });
    if ($('#iSwapGrid')) {
      const tiles = [...el.querySelectorAll('[data-alt]')];
      tiles.forEach((b) => {
        b.onclick = () => commitAnd(() => {
          const a = obj.alts[+b.dataset.alt];
          if (!a) return;
          const prevCut = { mediaId: obj.mediaId, srcIn: obj.srcIn, score: 0, reason: 'prev' };
          obj.mediaId = a.mediaId;
          obj.srcIn = a.srcIn;
          obj.alts[+b.dataset.alt] = prevCut;
        });
      });
      (async () => {
        const cache = (window._altThumbs = window._altThumbs || new Map());
        for (const b of tiles) {
          if (!b.isConnected) return;
          const a = obj.alts[+b.dataset.alt];
          const am = a && getMedia(p, a.mediaId);
          if (!am || am.kind !== 'video') continue;
          const key = `${am.id}|${a.srcIn.toFixed(2)}`;
          let url = cache.get(key);
          if (!url) {
            try {
              const v = await loadVideoMeta(am.url);
              url = await makeThumb(v, Math.min(Math.max(0, a.srcIn), Math.max(0, am.duration - 0.05)));
              v.removeAttribute('src'); v.load();
              if (url) cache.set(key, url);
            } catch {}
          }
          if (url && b.isConnected) {
            const img = document.createElement('img');
            img.src = url;
            b.prepend(img);
          }
        }
      })();
    }
    // decode the clip's own audio the first time someone reaches for the Clip audio slider
    const audioRow = [...el.querySelectorAll('.slider-row')].find((r) => r.firstElementChild.textContent === 'Clip audio');
    if (audioRow && m && !m.audio) {
      audioRow.querySelector('input').addEventListener('pointerdown', async () => {
        try { await decodeAudio(m); } catch (e) { toast(`${m.name} has no audio track`, true); }
      }, { once: true });
    }
    el.querySelectorAll('[data-speed]').forEach((b) => {
      b.onclick = () => commitAnd(() => {
        const keys = SPEEDS[b.dataset.speed].keys;
        const max = m ? m.duration : Infinity;
        obj.speedKeys = keys ? structuredClone(keys) : null;
        const sp = obj.dur * avgSpeedOfKeys(obj.speedKeys);
        if (obj.srcIn + sp > max) {
          if (max - sp >= 0) obj.srcIn = max - sp;
          else { obj.srcIn = 0; obj.dur = max / avgSpeedOfKeys(obj.speedKeys); relayout(p.clips); }
        }
      });
    });
    if ($('#iFollow')) $('#iFollow').onclick = () => commitAnd(() => { obj.pan = reframePan(m, obj, cropWidth(p, m)); });
    $('#iSplit').onclick = splitAtPlayhead;
    $('#iDel').onclick = deleteSelection;
    return;
  }

  if (sel.kind === 'sfx') {
    const snd = sfxById(obj.sound);
    const tag = snd && snd.tags[0];
    const alts = tag ? sfxManifest().sounds.filter((s) => s.tags.includes(tag)) : [];
    el.innerHTML = `<div class="insp-head"><div class="si" style="background:#14b8a6;color:#fff">🔊</div><div><h3>${esc(snd ? snd.name : obj.sound)}</h3><div class="sub">${esc(snd ? snd.cat + ' · ' + snd.tags.join(', ') : '')} · ${fmtTime(obj.start)}</div></div></div>
      <div class="sliders" style="margin:0 0 12px">${sliderField('Volume', obj.vol ?? 0.7, 0, 1.5, 0.01, (v) => { obj.vol = v; if (obj.src && obj.src !== 'manual') obj.src = 'manual'; })}</div>
      ${alts.length > 1 ? `<div class="field"><label>Swap for another ${esc(tag)}</label><select id="iSwap">${alts.map((s) => `<option value="${esc(s.id)}" ${s.id === obj.sound ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></div>` : ''}
      <div class="field-row"><div class="field"><label>Start (s)</label><input type="number" id="iStart" step="0.01" min="0" value="${obj.start.toFixed(2)}"></div><div></div></div>
      <div class="insp-actions"><button class="btn small" id="iPrev">▶ Preview</button><button class="btn small danger" id="iDel">Delete</button></div>`;
    if ($('#iSwap')) $('#iSwap').onchange = (e) => commitAnd(() => { obj.sound = e.target.value; loadSfx(obj.sound).then(() => previewSfx(obj.sound)); });
    $('#iStart').onchange = (e) => commitAnd(() => { obj.start = Math.max(0, +e.target.value); });
    $('#iPrev').onclick = () => previewSfx(obj.sound);
    $('#iDel').onclick = deleteSelection;
    return;
  }

  if (sel.kind === 'music') {
    const m = getMedia(p, obj.mediaId);
    const A = m.audio && m.audio.analysis;
    const d = timelineDuration(p);
    el.innerHTML = `<div class="insp-head"><div class="si" style="background:var(--cyan)">♪</div><div><h3>Soundtrack</h3><div class="sub">${esc(m.name)}${A ? ` · ${Math.round(A.bpm)} BPM · ${A.drops.length} drop${A.drops.length === 1 ? '' : 's'}` : ''}</div></div></div>
      <div class="sliders" style="margin:0 0 12px">
        ${sliderField('Song start', obj.offset, 0, Math.max(0.01, m.duration - d), 0.01, (v) => { obj.offset = v; }, (v) => fmtTime(+v))}
        ${sliderField('Volume', obj.volume, 0, 1.5, 0.01, (v) => { obj.volume = v; })}
        ${sliderField('Fade in', obj.fadeIn, 0, 4, 0.05, (v) => { obj.fadeIn = v; }, (v) => (+v).toFixed(1) + 's')}
        ${sliderField('Fade out', obj.fadeOut, 0, 4, 0.05, (v) => { obj.fadeOut = v; }, (v) => (+v).toFixed(1) + 's')}
      </div>
      <label class="toggle" style="margin:0 0 12px"><input type="checkbox" id="iDuck" ${obj.duck !== false ? 'checked' : ''}><span>Duck the song under clip audio</span></label>
      <p class="hint">Moving the song start shifts the music under the edit. Hit Regenerate in Auto-edit to re-cut everything to the new section.</p>
      <div class="insp-actions"><button class="btn small danger" id="iDel">Remove soundtrack</button></div>`;
    $('#iDel').onclick = deleteSelection;
    $('#iDuck').onchange = (e) => { app.history.push(); obj.duck = e.target.checked; app.player.invalidate(); };
  }
}

// ---------- keyboard ----------
window.addEventListener('keydown', (e) => {
  if (app.exporting) return; // no editing shortcuts while an export runs
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' && !['range', 'checkbox'].includes(e.target.type) || tag === 'textarea' || tag === 'select') return;
  const k = e.key.toLowerCase();
  const mod = e.metaKey || e.ctrlKey;
  if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? app.history.redo() : app.history.undo(); return; }
  if (mod && k === 'y') { e.preventDefault(); app.history.redo(); return; }
  if (mod) return;
  if (e.code === 'Space') { e.preventDefault(); app.player.toggle(); return; }
  if (k === 'backspace' || k === 'delete') { e.preventDefault(); deleteSelection(); return; }
  if (k === 's') { splitAtPlayhead(); return; }
  if (k === 'arrowleft' || k === 'arrowright') {
    e.preventDefault();
    const dir = k === 'arrowright' ? 1 : -1;
    if (e.shiftKey) jumpBeat(dir); else app.player.seek(app.player.t + dir / 30);
    return;
  }
  if (k === 'home') { app.player.seek(0); return; }
  if (k === 'end') { app.player.seek(timelineDuration(app.project)); return; }
  if (k === 'escape') { app.select(null); return; }
  const map = { f: 'flash', z: 'zoom', x: 'shake', g: 'glitch', r: 'rgb', i: 'impact', t: 'twitch' };
  if (map[k]) {
    const t = app.player.playing ? Math.max(0, app.player.t - 0.04) : app.player.t;
    addEffect(map[k], t, !app.player.playing);
  }
});

// ---------- export ----------
function openExport() {
  const p = app.project;
  const d = timelineDuration(p);
  if (!p.clips.length || d <= 0) { toast('Add footage first', true); return; }
  if (!exportSupported()) { toast('Export needs WebCodecs — use Chrome, Edge or Safari 17+', true); return; }
  if (app.player.playing) app.player.pause();
  const { w, h } = formatSize(p);
  const res = [[1, 'Full HD'], [2 / 3, 'HD 720p']].map(([s, l]) => ({ w: even(w * s), h: even(h * s), l }));
  // anime is usually 24 fps: exporting at 30 repeats every 4th frame (judder), so match it
  const srcFps = (p.media.find((m) => m.kind === 'video' && m.fps) || {}).fps;
  // (the file's rate is read rounded: 23.98 is NTSC film rate, exactly 24000/1001; 24 stays 24)
  const filmRate = srcFps && srcFps < 27 ? (Math.abs(srcFps - 23.976) < 0.01 ? 24000 / 1001 : Math.round(srcFps)) : null;
  const state = { res: 0, fps: filmRate || 30, q: 'high' };
  const guide = (p.music && getMedia(p, p.music.mediaId) || {}).guide;
  const root = $('#modalRoot');
  root.innerHTML = `<div class="modal-back"><div class="modal">
    <h3>Export video</h3><div class="sub">${fmtTime(d)} · MP4 (H.264 + AAC) · ready for TikTok, Reels & Shorts</div>
    ${(() => { const mm = p.music && getMedia(p, p.music.mediaId); const t = mm && BUILTIN_TRACKS.find((x) => x.id === mm.builtin); return t ? `<div class="hint" style="margin:-8px 0 14px">If you post this, add to your caption: <b style="color:var(--text)">${esc(creditFor(t))}</b></div>` : ''; })()}
    <div id="exForm">
      <div class="field"><label>Resolution</label><div class="seg" id="exRes">${res.map((r, i) => `<button data-i="${i}" class="${i === 0 ? 'on' : ''}">${r.l} · ${r.w}×${r.h}</button>`).join('')}</div></div>
      <div class="field"><label>Frame rate</label><div class="seg" id="exFps">${filmRate ? `<button data-v="${filmRate}" class="on">Match footage (${Math.round(filmRate)} fps)</button>` : ''}<button data-v="30" class="${filmRate ? '' : 'on'}">30 fps</button><button data-v="60">60 fps</button></div></div>
      <div class="field"><label>Quality</label><div class="seg" id="exQ"><button data-v="std">Standard</button><button data-v="high" class="on">High</button><button data-v="max">Max</button></div></div>
      ${guide ? `<div class="hint" style="margin:0 0 10px">The tempo guide is left out (sound effects stay). On Instagram, add <b style="color:var(--text)">${esc(guide.title)}</b> and start it ${guide.introBars} bar${guide.introBars > 1 ? 's' : ''} before the part you want to hit, so that part lands on the flash at <b style="color:var(--text)">${fmtTime(guide.drop)}</b>. Nudge the start by ear until the cuts sit on the beat.</div>` : ''}
      ${p.music && !guide ? `<label class="toggle" style="margin:4px 0 6px"><input type="checkbox" id="exSong" checked><span>Include the song</span></label><div class="hint" id="exSongNote" style="display:none;margin:0 0 8px">The song is left out (sound effects stay). On Instagram, add the same sound and start it at <b style="color:var(--text)">${fmtTime(p.music.offset)}</b> into the track so the cuts line up.</div>` : ''}
      <label class="toggle" style="margin:4px 0 6px"><input type="checkbox" id="exCover" checked><span>Also make a cover image (9:16 portrait)</span></label>
      <div class="field" id="exCoverF"><label>Cover title</label><input type="text" id="exCoverTitle" placeholder="${esc(coverTitle(p, mainDropTime()))}" maxlength="40"><div class="hint" style="margin:4px 0 0">Leave empty for the edit's own hook line. The key word goes behind the character.</div></div>
      <div class="sub" id="exEst" style="margin:4px 0 0"></div>
      <div class="actions"><button class="btn ghost" id="exCancel">Cancel</button><button class="btn primary" id="exGo">Export MP4</button></div>
    </div>
    <div id="exRun" style="display:none">
      <div class="progress"><i id="exBar"></i></div>
      <div class="pinfo"><span id="exStage">Preparing…</span><span id="exEta"></span></div>
      <div id="exDone"></div>
      <div class="actions"><button class="btn ghost" id="exStop">Cancel</button></div>
    </div></div></div>`;
  const bpp = { std: 0.1, high: 0.16, max: 0.25 };
  const bitrate = () => Math.round(res[state.res].w * res[state.res].h * state.fps * bpp[state.q]);
  const est = () => { $('#exEst').textContent = `≈ ${((bitrate() * d) / 8 / 1e6).toFixed(0)} MB · ${(bitrate() / 1e6).toFixed(1)} Mbps`; };
  est();
  const seg = (id, fn) => $(id).querySelectorAll('button').forEach((b) => {
    b.onclick = () => { $(id).querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b)); fn(b); est(); };
  });
  seg('#exRes', (b) => { state.res = +b.dataset.i; });
  seg('#exFps', (b) => { state.fps = +b.dataset.v; });
  seg('#exQ', (b) => { state.q = b.dataset.v; });
  const close = () => { root.innerHTML = ''; };
  $('#exCancel').onclick = close;
  if ($('#exSong')) $('#exSong').onchange = (e) => { $('#exSongNote').style.display = e.target.checked ? 'none' : 'block'; };
  $('#exCover').onchange = (e) => { $('#exCoverF').style.display = e.target.checked ? '' : 'none'; };
  $('#exGo').onclick = async () => {
    const wantCover = $('#exCover').checked, coverText = $('#exCoverTitle').value;
    $('#exForm').style.display = 'none';
    $('#exRun').style.display = 'block';
    const ctrl = new AbortController();
    $('#exStop').onclick = () => ctrl.abort();
    const r = res[state.res];
    try {
      const includeMusic = !$('#exSong') || $('#exSong').checked;
      if (app.fxPrep) { $('#exStage').textContent = 'Finding the characters for FX boost…'; await app.fxPrep; }
      app.exporting = true;
      const blob = await exportVideo(app, { width: r.w, height: r.h, fps: state.fps, bitrate: bitrate(), includeMusic }, (pr) => {
        $('#exBar').style.width = Math.round(pr.p * 100) + '%';
        $('#exStage').textContent = pr.frames ? `${pr.stage} frame ${pr.frame}/${pr.frames}` + (pr.modes && pr.modes.includes('seek') ? ' (compat mode)' : '') : pr.stage + '…';
        $('#exEta').textContent = pr.eta != null ? `~${Math.ceil(pr.eta)}s left` : '';
      }, ctrl.signal).finally(() => { app.exporting = false; });
      const url = URL.createObjectURL(blob);
      const name = `sakuga-edit-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}.mp4`;
      $('#exStage').textContent = `Done · ${(blob.size / 1e6).toFixed(1)} MB`;
      $('#exEta').textContent = '';
      $('#exDone').innerHTML = `<video src="${url}" controls playsinline></video>`;
      $('#exStop').outerHTML = `<button class="btn ghost" id="exClose">Close</button><a class="btn primary" id="exDl" href="${url}" download="${name}" style="display:inline-grid;place-items:center;text-decoration:none">⬇ Download MP4</a>`;
      $('#exClose').onclick = close;
      $('#exDl').click();
      if (wantCover) {
        // cover images: the strongest frame with the title set behind the character
        $('#exStage').textContent = `Done · ${(blob.size / 1e6).toFixed(1)} MB · making cover images…`;
        try {
          const cv = await makeCovers(app, { title: coverText });
          const links = `<a class="btn ghost" href="${URL.createObjectURL(cv.portrait)}" download="${name.replace('.mp4', '-cover.png')}" style="display:inline-grid;place-items:center;text-decoration:none">⬇ Cover image</a>`;
          $('#exDone').insertAdjacentHTML('beforeend', `<div class="cover-row"><img src="${URL.createObjectURL(cv.portrait)}" alt="Cover"><div>${links}</div></div>`);
          $('#exStage').textContent = `Done · ${(blob.size / 1e6).toFixed(1)} MB · cover "${cv.title}"`;
        } catch (e) { console.warn('[cover]', e); $('#exStage').textContent = `Done · ${(blob.size / 1e6).toFixed(1)} MB (no cover: ${e.message || e})`; }
      }
    } catch (e) {
      if (e.name === 'AbortError') { close(); toast('Export cancelled'); return; }
      console.error(e);
      $('#exStage').textContent = 'Export failed: ' + (e.message || e);
      $('#exStop').textContent = 'Close';
      $('#exStop').onclick = close;
    }
  };
}

const even = (x) => Math.max(2, Math.round(x / 2) * 2);

// The main drop on the timeline (seconds), or null.
function mainDropTime() {
  const pl = app.plan, d = pl && pl.G && pl.G.drops && pl.G.drops.find((x) => x - pl.win.start > 1);
  return d != null ? d - pl.win.start : null;
}

// ---------- toasts ----------
function toast(msg, err = false) {
  const t = document.createElement('div');
  t.className = 'toast' + (err ? ' err' : '');
  t.textContent = msg;
  $('#toasts').appendChild(t);
  setTimeout(() => t.remove(), err ? 5000 : 3200);
}

// ---------- boot ----------
renderMedia();
renderAI();
renderLook();
renderInspector();
app.changed();
loadUiFont();
document.addEventListener('captionstylesready', () => app.player.invalidate());
document.fonts?.addEventListener('loadingdone', () => app.player.invalidate());

loadSavedLyrics();
loadVfxManifest().then(() => { if (app.plan) app.suggestions = buildSuggestions(app.project, app.plan); renderAI(); });
loadSfxManifest().then(() => { renderSounds(); if (app.plan) app.suggestions = buildSuggestions(app.project, app.plan); renderAI(); });
// unlock audio on first interaction
window.addEventListener('pointerdown', () => { const c = audioContext(); if (c.state === 'suspended') c.resume(); }, { once: true });
