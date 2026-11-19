// Container colour tag for an MP4 from mp4-muxer: a 'colr' box (nclx: BT.709 primaries, transfer
// and matrix, limited range) inside the video sample entry, as ffmpeg writes with
// -movflags +write_colr. The H.264 stream already says BT.709 in its own headers, but some players
// (QuickTime among them) go by the container's tag first, and without one can show the edit a
// shade brighter or darker than it was made.
//
// Inserting the box grows the boxes around it, and (with the index at the front of the file)
// moves the media data, so every chunk offset is moved on by the same amount.

const COLR = new Uint8Array([0, 0, 0, 19, 0x63, 0x6f, 0x6c, 0x72, 0x6e, 0x63, 0x6c, 0x78, 0, 1, 0, 1, 0, 1, 0]);
const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl']);

function boxes(v, start, end) {
  const out = [];
  for (let o = start; o + 8 <= end;) {
    let size = v.getUint32(o), head = 8;
    const type = String.fromCharCode(v.getUint8(o + 4), v.getUint8(o + 5), v.getUint8(o + 6), v.getUint8(o + 7));
    if (size === 1) { size = Number(v.getBigUint64(o + 8)); head = 16; } else if (size === 0) size = end - o;
    if (size < head || o + size > end) break;
    out.push({ type, o, size, head });
    o += size;
  }
  return out;
}

export function withColr(buffer) {
  const src = new Uint8Array(buffer), v = new DataView(buffer);
  const top = boxes(v, 0, src.length);
  const moov = top.find((b) => b.type === 'moov'), mdat = top.find((b) => b.type === 'mdat');
  if (!moov) return buffer;
  // the video sample entry, and the boxes it sits in
  let at = -1, chain = null;
  const walk = (b, path) => {
    if (at >= 0) return;
    if (CONTAINERS.has(b.type)) { for (const c of boxes(v, b.o + b.head, b.o + b.size)) walk(c, [...path, b]); return; }
    if (b.type !== 'stsd') return;
    // stsd: version/flags, entry count, then the sample entries
    for (const e of boxes(v, b.o + 16, b.o + b.size)) {
      if (e.type !== 'avc1' && e.type !== 'hvc1') continue;
      // a sample entry already tagged is left as it is
      if (boxes(v, e.o + 8 + 78, e.o + e.size).some((c) => c.type === 'colr')) return;
      at = e.o + e.size; chain = [...path, b, e];
      return;
    }
  };
  walk(moov, []);
  if (at < 0) return buffer;
  const n = COLR.length, out = new Uint8Array(src.length + n), w = new DataView(out.buffer);
  out.set(src.subarray(0, at), 0);
  out.set(COLR, at);
  out.set(src.subarray(at), at + n);
  for (const b of chain) {
    if (b.head === 16) w.setBigUint64(b.o + 8, w.getBigUint64(b.o + 8) + BigInt(n));
    else w.setUint32(b.o, w.getUint32(b.o) + n);
  }
  // the media data moved on: so does every chunk offset (only when the index comes first)
  if (mdat && mdat.o > moov.o) {
    const fix = (b) => {
      if (CONTAINERS.has(b.type)) { for (const c of boxes(w, b.o + b.head, b.o + b.size)) fix(c); return; }
      if (b.type === 'stco') { const k = w.getUint32(b.o + 12); for (let i = 0; i < k; i++) { const p = b.o + 16 + i * 4; w.setUint32(p, w.getUint32(p) + n); } }
      if (b.type === 'co64') { const k = w.getUint32(b.o + 12); for (let i = 0; i < k; i++) { const p = b.o + 16 + i * 8; w.setBigUint64(p, w.getBigUint64(p) + BigInt(n)); } }
    };
    fix(boxes(w, moov.o, moov.o + moov.size + n)[0]);
  }
  return out.buffer;
}
