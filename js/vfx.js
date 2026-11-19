// VFX overlay library (vfx/manifest.json): sprite atlases (hits, sparks, explosions, lightning,
// light leaks, film burns…) played frame by frame over the footage. Images load lazily and are
// shared by the preview and the exporter; the renderer uploads each to its own GL context.

let manifest = null;
const images = new Map(); // id → { img, ready }

// The library is the main catalog plus packs added later (extra.json), merged.
export async function loadVfxManifest() {
  const all = { packs: [], effects: [] };
  for (const url of ['vfx/manifest.json', 'vfx/extra.json']) {
    try {
      const r = await fetch(url);
      if (!r.ok) continue;
      const m = await r.json();
      all.packs.push(...(m.packs || []));
      all.effects.push(...(m.effects || []));
    } catch (e) { /* missing or unreadable: skip it */ }
  }
  manifest = all.effects.length ? all : null;
  return manifest;
}

export const vfxManifest = () => manifest;
export const vfxAsset = (id) => (manifest ? manifest.effects.find((e) => e.id === id) : null);

export function loadVfxImage(id) {
  if (images.has(id)) return images.get(id).ready;
  const a = vfxAsset(id);
  if (!a) return Promise.resolve(null);
  const img = new Image();
  const ready = new Promise((res) => {
    img.onload = () => (img.decode ? img.decode().catch(() => {}) : Promise.resolve()).then(() => res(img));
    img.onerror = () => res(null);
  });
  img.src = a.file;
  images.set(id, { img, ready });
  return ready;
}

// The decoded image for an asset, or null while it's still loading.
export function vfxImage(id) {
  const x = images.get(id);
  return x && x.img.complete && x.img.naturalWidth ? x.img : null;
}

export function preloadProjectVfx(project) {
  const ids = [...new Set((project.effects || []).filter((e) => e.type === 'vfx' && e.params.asset).map((e) => e.params.asset))];
  return Promise.all(ids.map((id) => loadVfxImage(id)));
}

// How an asset composites: black-background footage screens over the picture; transparent
// sprites that glow (sparks, lightning, fire…) add light; smoke, blood and dust lay over normally.
export function vfxMode(a) {
  if (!a || a.blend === 'screen') return 0;
  if (a.glow != null) return a.glow ? 2 : 1; // hand-drawn sprites with outlines keep their look
  return (a.tags || []).some((t) => t === 'smoke' || t === 'dust' || t === 'blood' || t === 'explosion') ? 1 : 2;
}

// Assets with a tag, in a stable order; `i` rotates through them. `prefer(a)` scores candidates
// (higher first) so the pick suits the moment, e.g. a hue close to the shot's.
// What the automatic edit may use: only overlays whose licence lets the finished edit be posted and
// shared (CC0, which Kenney's are). Others (Mixkit's) stay available to add by hand.
const shareable = (e) => /^CC0/i.test(e.license || '');
export function pickVfx(tag, i = 0, filter, prefer) {
  if (!manifest) return null;
  let pool = manifest.effects.filter((e) => shareable(e) && (e.tags || []).includes(tag) && (!filter || filter(e)));
  if (!pool.length) return null;
  if (prefer) {
    const scored = pool.map((e) => ({ e, s: prefer(e) })).sort((a, b) => b.s - a.s);
    pool = scored.slice(0, Math.max(1, Math.ceil(scored.length / 2))).map((x) => x.e);
  }
  return pool[((i % pool.length) + pool.length) % pool.length];
}
