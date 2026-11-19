#!/usr/bin/env python3
"""Index shots using SigLIP, optical flow and shot boundaries. Search by a text description."""
import argparse
import base64
import json
import math
import os
import subprocess
import sys
from pathlib import Path

from media_io import cached, input_file, source_stamp, write_json

MODEL = 'google/siglip-base-patch16-224'
SIDE = 480


def side_path(footage):
    return os.path.splitext(footage)[0] + '.shots.json'


def frames_at(footage, ts, w=SIDE):
    """Decoded frames (RGB numpy) at the given source seconds."""
    import numpy as np
    out = []
    for t in ts:
        raw = subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-ss', f'{max(0, t):.3f}', '-i', footage, '-frames:v', '1', '-vf', f'scale={w}:-2',
                              '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], capture_output=True, check=True).stdout
        h = len(raw) // (w * 3)
        out.append(np.frombuffer(raw, np.uint8).reshape(h, w, 3) if h else None)
    return out


def scenes_of(footage, dur, detector):
    """Scene spans: TransNet V2's cuts (tools/cuts.py; ffmpeg's scene score past 0.3 without it),
    plus a joined source's own seams."""
    if detector == "transnet":
        from cuts import cut_times
        cuts = cut_times(footage)
    else:
        import re
        log = subprocess.run(['ffmpeg', '-nostdin', '-v', 'info', '-i', footage, '-vf', "scale=320:-2,select='gt(scene,0.3)',showinfo", '-an', '-f', 'null', '-'],
                             capture_output=True, text=True, check=True).stderr
        cuts = [float(m) for m in re.findall(r'pts_time:([0-9.]+)', log)]
    side = os.path.splitext(footage)[0] + '.cuts.json'
    if os.path.exists(side):
        cuts += [float(c) for c in json.loads(Path(side).read_text(encoding='utf-8'))]
    cuts = sorted(c for c in set(round(c, 3) for c in cuts) if 0.2 < c < dur - 0.2)
    edges = [0.0] + cuts + [dur]
    return [(a, b) for a, b in zip(edges, edges[1:]) if b - a >= 0.35]


def motion_of(footage, a, b):
    """Estimate flow between frames sampled 1/24 s apart at 480 pixels wide, plus mean direction."""
    import cv2
    import numpy as np
    n = 4 if b - a > 1.2 else 2
    mags, vx, vy = [], 0.0, 0.0
    for k in range(n):
        t = a + (b - a) * (k + 0.5) / n
        f0, f1 = frames_at(footage, [t, t + 1 / 24])
        if f0 is None or f1 is None or f0.shape != f1.shape:
            continue
        g0, g1 = cv2.cvtColor(f0, cv2.COLOR_RGB2GRAY), cv2.cvtColor(f1, cv2.COLOR_RGB2GRAY)
        fl = cv2.calcOpticalFlowFarneback(g0, g1, None, 0.5, 3, 15, 3, 5, 1.2, 0)
        m = np.hypot(fl[..., 0], fl[..., 1])
        mags.append(float(np.median(m)))
        vx += float(fl[..., 0].mean()); vy += float(fl[..., 1].mean())
    return (round(float(np.median(mags)), 2) if mags else 0.0), round(math.degrees(math.atan2(vy, vx)) % 360) if (vx or vy) else None


def feats(out):
    """The embedding from a features call (transformers 5 wraps it in an output object)."""
    return out if hasattr(out, 'norm') else (out.pooler_output if getattr(out, 'pooler_output', None) is not None else out[0])


def load_model():
    import torch
    from transformers import AutoModel, AutoProcessor
    dev = 'mps' if torch.backends.mps.is_available() else 'cpu'
    return AutoModel.from_pretrained(MODEL).to(dev).eval(), AutoProcessor.from_pretrained(MODEL), dev


def cmd_index(a):
    footage = os.path.abspath(a.footage)
    src = source_stamp(footage)
    seam_file = Path(footage).with_suffix(".cuts.json")
    settings = {"source": src, "model": MODEL, "detector": a.detector,
                "seams": source_stamp(seam_file) if seam_file.exists() else None}
    out = side_path(footage)
    if not a.force and cached(out, **settings):
        print(out)
        return
    import numpy as np
    import torch
    dur = float(subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', footage], capture_output=True, text=True, check=True).stdout)
    spans = scenes_of(footage, dur, a.detector)
    print(f'{len(spans)} scenes', file=sys.stderr)
    model, proc, dev = load_model()
    scenes = []
    for i, (s0, s1) in enumerate(spans):
        ts = [s0 + (s1 - s0) * q for q in (0.2, 0.5, 0.8)]
        fr = [f for f in frames_at(footage, ts) if f is not None]
        if not fr:
            continue
        with torch.no_grad():
            emb = feats(model.get_image_features(**proc(images=fr, return_tensors='pt').to(dev)))
            emb = torch.nn.functional.normalize(emb, dim=-1).cpu().numpy().astype(np.float16)
        mid = fr[len(fr) // 2].astype(np.float32) / 255
        lum = float((mid @ np.array([0.2126, 0.7152, 0.0722], np.float32)).mean())
        mot, ang = motion_of(footage, s0, s1)
        scenes.append({'i': i, 'start': round(s0, 3), 'end': round(s1, 3), 'motion': mot, 'dir': ang, 'lum': round(lum, 3),
                       'rgb': [round(float(x), 3) for x in mid.reshape(-1, 3).mean(0)], 'emb': base64.b64encode(emb.tobytes()).decode()})
        if i % 20 == 0:
            print(f'  {i}/{len(spans)}', file=sys.stderr)
    write_json(out, {**settings, 'scenes': scenes})
    print(out)


def load_index(footage):
    p = side_path(os.path.abspath(footage))
    if not os.path.exists(p):
        sys.exit(f'no index yet: run  tools/shots.py index {footage}')
    return json.loads(Path(p).read_text(encoding="utf-8"))


def cmd_search(a):
    import numpy as np
    import torch
    idx = load_index(a.footage)
    model, proc, dev = load_model()
    with torch.no_grad():
        q = feats(model.get_text_features(**proc(text=[a.query], padding='max_length', return_tensors='pt').to(dev)))
        q = torch.nn.functional.normalize(q, dim=-1).cpu().numpy()[0]
    rows = []
    for s in idx['scenes']:
        e = np.frombuffer(base64.b64decode(s['emb']), np.float16).reshape(-1, q.shape[0]).astype(np.float32)
        rows.append((float((e @ q).max()), s))
    rows.sort(key=lambda r: -r[0])
    for sc, s in rows[:a.top]:
        print(f"{sc:6.3f}  scene {s['i']:3d}  {s['start']:7.2f}-{s['end']:7.2f}  ({s['end'] - s['start']:4.1f}s)  motion {s['motion']:5.2f}  lum {s['lum']:.2f}")


def cmd_list(a):
    idx = load_index(a.footage)
    sc = sorted(idx['scenes'], key=lambda s: -s[a.sort]) if a.sort else idx['scenes']
    for s in sc:
        print(f"scene {s['i']:3d}  {s['start']:7.2f}-{s['end']:7.2f}  ({s['end'] - s['start']:4.1f}s)  motion {s['motion']:5.2f}  dir {s['dir']}  lum {s['lum']:.2f}"
              + (f"  {s['desc']}" if s.get('desc') else ''))


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    sub = ap.add_subparsers(dest='cmd', required=True)
    p = sub.add_parser('index'); p.add_argument('footage', type=input_file); p.add_argument('--force', action='store_true'); p.add_argument('--detector', choices=['ffmpeg', 'transnet'], default='ffmpeg'); p.set_defaults(fn=cmd_index)
    p = sub.add_parser('search'); p.add_argument('footage', type=input_file); p.add_argument('query'); p.add_argument('--top', type=int, default=12); p.set_defaults(fn=cmd_search)
    p = sub.add_parser('list'); p.add_argument('footage', type=input_file); p.add_argument('--sort', choices=['motion', 'lum'], default=None); p.set_defaults(fn=cmd_list)
    a = ap.parse_args()
    if a.cmd == "search" and a.top < 1:
        ap.error("--top must be positive")
    a.fn(a)


if __name__ == '__main__':
    main()
