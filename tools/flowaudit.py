"""Motion audit: how a video moves, frame by frame, so an edit's flow can be measured against the
references instead of judged by eye.

  python tools/flowaudit.py VIDEO [--out DIR] [--t0 S] [--t1 S] [--locks t,t,...]

Per frame pair (480 px wide, DIS optical flow):
  - the camera: a similarity transform fitted to the flow with RANSAC (zoom rate, rotation, pan),
    which is the editor's own camera move plus the footage's;
  - the action: the flow left after the camera is taken out (characters, effects);
  - new picture or held drawing (a repeat of the last frame), and the drawing cadence;
  - jank: a frame whose motion jumps against its neighbours (a stutter in a slow-motion stretch,
    an in-between that failed and fell back to a held drawing, a hold then a leap).
Cuts are found from the picture difference. Writes DIR/audit.json and DIR/audit.png (curves over
time with the cuts, the locks and every jank frame marked), and prints a per-shot summary.
"""
import argparse, json, math, os, subprocess
import numpy as np
import cv2


def frames(path, t0, t1, w=480):
    info = json.loads(subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries',
                                      'stream=width,height,r_frame_rate', '-of', 'json', path], capture_output=True, text=True).stdout)['streams'][0]
    n, d = info['r_frame_rate'].split('/'); fps = float(n) / float(d)
    h = int(round(info['height'] * w / info['width'] / 2) * 2)
    cmd = ['ffmpeg', '-v', 'error']
    if t0: cmd += ['-ss', f'{t0}']
    cmd += ['-i', path]
    if t1: cmd += ['-t', f'{t1 - (t0 or 0)}']
    cmd += ['-vf', f'scale={w}:{h},format=gray', '-f', 'rawvideo', '-']
    raw = subprocess.run(cmd, capture_output=True).stdout
    a = np.frombuffer(raw, np.uint8).reshape(-1, h, w)
    return a, fps


def analyse(a, fps, t0=0.0):
    dis = cv2.DISOpticalFlow_create(cv2.DISOPTICAL_FLOW_PRESET_MEDIUM)
    H, W = a.shape[1:]
    ys, xs = np.mgrid[8:H - 8:12, 8:W - 8:12]
    pts = np.stack([xs.ravel(), ys.ravel()], 1).astype(np.float32)
    rows = []
    for i in range(1, len(a)):
        A, B = a[i - 1], a[i]
        diff = float(np.abs(A.astype(np.int16) - B.astype(np.int16)).mean())
        r = {'t': round(t0 + i / fps, 4), 'diff': round(diff, 2),
             # fine detail energy: in-betweens that blur, or grain that comes and goes, make it pulse
             'hf': round(float(cv2.Laplacian(B, cv2.CV_32F).var()), 1)}
        if diff < 0.6:
            r.update(held=True, zoom=0.0, rot=0.0, pan=0.0, act=0.0, mag=0.0, sub=0.0); rows.append(r); continue
        f = dis.calc(A, B, None)
        v = f[pts[:, 1].astype(int), pts[:, 0].astype(int)]
        M, inl = cv2.estimateAffinePartial2D(pts, pts + v, method=cv2.RANSAC, ransacReprojThreshold=1.5)
        if M is None: M = np.array([[1, 0, 0], [0, 1, 0]], np.float32)
        s = math.hypot(M[0, 0], M[1, 0]); ang = math.degrees(math.atan2(M[1, 0], M[0, 0]))
        cam = (pts @ M[:, :2].T + M[:, 2]) - pts
        res = np.linalg.norm(v - cam, axis=1)
        r.update(held=False, zoom=round((s - 1) * 100, 3), rot=round(ang, 3),
                 pan=round(float(np.hypot(M[0, 2], M[1, 2])), 2),
                 cam=round(float(np.median(np.linalg.norm(cam, axis=1))), 2),
                 act=round(float(np.percentile(res, 75)), 2),
                 sub=round(float(np.percentile(res, 98)), 2),
                 mag=round(float(np.percentile(np.linalg.norm(v, axis=1), 75)), 2),
                 inl=round(float(inl.mean()) if inl is not None else 0, 2))
        rows.append(r)
    return rows


def shots(rows, cut_diff=38.0):
    cuts = [r['t'] for r in rows if r['diff'] > cut_diff]
    # a cut is the first frame of a big change; merge flashes (cuts closer than 3 frames)
    out = []
    for c in cuts:
        if not out or c - out[-1] > 0.12: out.append(c)
    return out


def jank(rows, fps):
    """Frames that break the rhythm of the frames around them, within a shot. Three measures:
    the whole picture's motion (mag), the moving subject's (sub: the fastest 2% of the flow once the
    camera is taken out, so a small ball or a hand counts), and fine detail (hf):
      stutter: the subject stops for a frame while it moves on both sides (a repeated or failed frame);
      leap: it moves 2.2x more than its neighbours (a pop after a hold);
      pulse: detail jumps 10% against its neighbours in a slow stretch (grain or blur coming and going)."""
    n = len(rows); flags = []
    m = np.array([r['mag'] for r in rows]); su = np.array([r.get('sub', 0) for r in rows]); hf = np.array([r.get('hf', 0) for r in rows])
    for i in range(3, n - 3):
        if any(rows[j]['diff'] > 38 for j in range(i - 3, i + 4)): continue
        nb = lambda a: np.r_[a[i - 3:i], a[i + 1:i + 4]]
        ms, mm = float(np.median(nb(su))), float(np.median(nb(m)))
        if ms > 1.2 and su[i] < 0.35 * ms:
            flags.append({'t': rows[i]['t'], 'kind': 'stutter', 'sub': float(su[i]), 'med': round(ms, 2)})
        elif ms > 0.6 and su[i] > 2.2 * ms + 1.0 and m[i] > 2.0 * mm + 0.5:
            flags.append({'t': rows[i]['t'], 'kind': 'leap', 'sub': float(su[i]), 'med': round(ms, 2)})
        elif mm < 3.0 and np.median(nb(hf)) > 0 and abs(hf[i] / np.median(nb(hf)) - 1) > 0.10:
            flags.append({'t': rows[i]['t'], 'kind': 'pulse', 'hf': float(hf[i]), 'med': float(np.median(nb(hf)))})
    return flags


def summary(rows, cuts, fps, locks):
    bounds = [rows[0]['t'] - 1 / fps] + cuts + [rows[-1]['t'] + 1e-6]
    out = []
    for a, b in zip(bounds, bounds[1:]):
        seg = [r for r in rows if a <= r['t'] < b and r['diff'] <= 38]
        if len(seg) < 4: continue
        new = sum(1 for r in seg if not r['held']) / len(seg)
        lk = [l for l in (locks or []) if a <= l < b]
        s = {'from': round(a, 2), 'to': round(b, 2), 'dur': round(b - a, 2), 'new_frames': round(new, 2),
             'zoom_total_pct': round(sum(r['zoom'] for r in seg), 1),
             'rot_total_deg': round(sum(r['rot'] for r in seg), 2),
             'pan_px': round(sum(r['pan'] for r in seg), 0),
             'motion_p75': round(float(np.percentile([r['mag'] for r in seg], 75)), 2),
             'action_p75': round(float(np.percentile([r['act'] for r in seg], 75)), 2)}
        if lk:
            L = lk[0]
            pre = [r['mag'] for r in seg if L - 1.0 <= r['t'] < L]; post = [r['mag'] for r in seg if L + 0.3 <= r['t'] < L + 1.5]
            s.update(lock=L, before=round(float(np.mean(pre)), 2) if pre else None, after=round(float(np.mean(post)), 2) if post else None,
                     cut_to_lock=round(L - a, 2), lock_to_cut=round(b - L, 2))
        out.append(s)
    return out


def plot(rows, cuts, fl, locks, path, title):
    from PIL import Image, ImageDraw, ImageFont
    W, H = 2400, 900; im = Image.new('RGB', (W, H), (18, 18, 22)); d = ImageDraw.Draw(im)
    font = ImageFont.load_default(size=18)
    t0, t1 = rows[0]['t'], rows[-1]['t']; X = lambda t: 60 + (t - t0) / (t1 - t0) * (W - 80)
    lanes = [('mag', 'motion (px/frame, p75)', 20, (240, 240, 240)), ('act', 'action after camera', 20, (120, 220, 255)),
             ('zoom', 'zoom rate %/frame', 3, (255, 200, 90)), ('rot', 'rotation deg/frame', 1.5, (255, 120, 160)), ('diff', 'picture change', 60, (150, 150, 150))]
    lh = (H - 60) / len(lanes)
    for k, (key, name, sc, col) in enumerate(lanes):
        y0 = 40 + k * lh; mid = y0 + lh / 2 if key in ('zoom', 'rot') else y0 + lh - 6
        d.text((6, y0 + 2), name, fill=col, font=font)
        d.line([(60, mid), (W - 20, mid)], fill=(50, 50, 60))
        pts = []
        for r in rows:
            v = r.get(key, 0) or 0
            y = mid - (v / sc) * (lh / 2 - 8 if key in ('zoom', 'rot') else lh - 30)
            pts.append((X(r['t']), max(y0 + 2, min(y0 + lh - 2, y))))
        d.line(pts, fill=col, width=2)
        for r in rows:
            if r.get('held'): d.line([(X(r['t']), y0 + lh - 4), (X(r['t']), y0 + lh - 1)], fill=(90, 90, 90))
    for c in cuts: d.line([(X(c), 30), (X(c), H - 10)], fill=(255, 60, 60), width=1)
    for l in locks or []: d.line([(X(l), 30), (X(l), H - 10)], fill=(80, 255, 120), width=1)
    for f in fl: d.ellipse([X(f['t']) - 5, 22, X(f['t']) + 5, 32], fill={'stutter': (255, 230, 0), 'leap': (255, 120, 0)}.get(f['kind'], (120, 200, 255)))
    for s in range(int(t0), int(t1) + 1): d.text((X(s) - 6, H - 22), str(s), fill=(160, 160, 160), font=font)
    d.text((W - 900, 4), title + '   red: cuts   green: locks   yellow/orange dots: stutter/leap', fill=(220, 220, 220), font=font)
    im.save(path)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('video'); ap.add_argument('--out'); ap.add_argument('--t0', type=float, default=0.0); ap.add_argument('--t1', type=float)
    ap.add_argument('--locks', default='')
    a = ap.parse_args()
    out = a.out or os.path.splitext(a.video)[0] + '-audit'; os.makedirs(out, exist_ok=True)
    if a.t0 < 0 or (a.t1 is not None and a.t1 <= a.t0):
        ap.error("The time range must start at zero or later and end after its start")
    fr, fps = frames(a.video, a.t0, a.t1)
    if len(fr) < 3:
        ap.error("Choose a time range containing at least three frames")
    rows = analyse(fr, fps, a.t0)
    cuts = shots(rows); fl = jank(rows, fps)
    locks = [float(x) for x in a.locks.split(',') if x]
    summ = summary(rows, cuts, fps, locks)
    json.dump({'fps': fps, 'rows': rows, 'cuts': cuts, 'jank': fl, 'shots': summ}, open(os.path.join(out, 'audit.json'), 'w'))
    plot(rows, cuts, fl, locks, os.path.join(out, 'audit.png'), os.path.basename(a.video))
    print(f'{os.path.basename(a.video)}: {fps:.3f} fps, {len(cuts)} cuts, {len(fl)} jank frames '
          f'({sum(1 for f in fl if f["kind"] == "stutter")} stutters, {sum(1 for f in fl if f["kind"] == "leap")} leaps, {sum(1 for f in fl if f["kind"] == "pulse")} pulses)')
    print('  (this counts the footage\'s own drawing cadence and dissolves too: a stutter only matters where the edit slowed the footage. Check the source before calling one a fault.)')
    for s in summ: print('  ', json.dumps(s))
    for k in ('stutter', 'leap', 'pulse'): print(f'  {k} at', [f['t'] for f in fl if f['kind'] == k][:40])


if __name__ == '__main__':
    main()
