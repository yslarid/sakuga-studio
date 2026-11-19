#!/usr/bin/env python3
"""Follow a measured region through a shot and print normalized position / scale keys."""
import argparse
import json
import subprocess

from media_io import input_file, seconds


def frames(path, t0, t1, w):
    """Grey frames from t0 to t1 at the video's own rate, w pixels wide."""
    import numpy as np
    probe = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,r_frame_rate',
                            '-of', 'json', path], capture_output=True, text=True, check=True)
    s = json.loads(probe.stdout)['streams'][0]
    num, den = (int(v) for v in s['r_frame_rate'].split('/'))
    fps = num / den
    h = int(round(s['height'] * w / s['width'] / 2)) * 2
    p = subprocess.Popen(['ffmpeg', '-v', 'error', '-ss', f'{t0:.3f}', '-i', path, '-t', f'{t1 - t0:.3f}',
                          '-vf', f'scale={w}:{h}', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'],
                         stdout=subprocess.PIPE)
    try:
        i = 0
        while True:
            buf = p.stdout.read(w * h)
            if len(buf) < w * h:
                break
            yield t0 + i / fps, np.frombuffer(buf, np.uint8).reshape(h, w)
            i += 1
        if p.wait():
            raise ValueError("ffmpeg could not decode the shot")
    finally:
        p.stdout.close()
        if p.poll() is None:
            p.kill()
        p.wait()


def track(path, t0, t1, box, w=960):
    """[(t, A)] where A maps a point of the first frame (pixels) to the same point at t."""
    import cv2
    import numpy as np
    out, prev, pts, acc = [], None, None, np.eye(3)
    W = H = 0
    for t, g in frames(path, t0, t1, w):
        H, W = g.shape
        if prev is None:
            mask = np.zeros_like(g)
            mask[int(box[1] * H):int(box[3] * H), int(box[0] * W):int(box[2] * W)] = 255
            pts = cv2.goodFeaturesToTrack(g, 400, 0.01, 6, mask=mask)
            if pts is None or len(pts) < 6:
                raise ValueError("region has too few trackable features on the first frame")
            out.append((t, acc.copy())); prev = g
            continue
        nxt, st, _ = cv2.calcOpticalFlowPyrLK(prev, g, pts, None, winSize=(21, 21), maxLevel=3)
        if nxt is None or st is None:
            raise ValueError("lost the tracked region")
        ok = st.ravel() == 1
        M, inl = cv2.estimateAffinePartial2D(pts[ok], nxt[ok], method=cv2.RANSAC, ransacReprojThreshold=2.0) if ok.sum() >= 6 else (None, None)
        if M is not None:
            acc = np.vstack([M, [0, 0, 1]]) @ acc
            keep = np.zeros(len(pts), bool); keep[np.flatnonzero(ok)[inl.ravel() == 1]] = True
            pts = nxt[keep].reshape(-1, 1, 2)
        else:
            pts = nxt[ok].reshape(-1, 1, 2)
        # Replenish features from the tracked region when points leave the frame.
        if len(pts) < 120:
            q = np.array([[box[0] * W, box[1] * H], [box[2] * W, box[3] * H]], np.float32)
            q = (acc[:2, :2] @ q.T).T + acc[:2, 2]
            mask = np.zeros_like(g)
            mask[max(0, int(q[0, 1])):int(q[1, 1]), max(0, int(q[0, 0])):int(q[1, 0])] = 255
            more = cv2.goodFeaturesToTrack(g, 400, 0.01, 6, mask=mask)
            if more is not None:
                pts = np.vstack([pts, more]).astype(np.float32)
        if len(pts) < 6:
            raise ValueError("lost the tracked region")
        out.append((t, acc.copy())); prev = g
    return out, W, H


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('video', type=input_file)
    ap.add_argument('--from', dest='t0', type=seconds, required=True, help='shot start in the source (s)')
    ap.add_argument('--to', dest='t1', type=seconds, required=True, help='shot end in the source (s)')
    ap.add_argument('--at', type=seconds, help='the source time the figure was measured at (default: --from)')
    ap.add_argument('--box', required=True, help='x0,y0,x1,y1: the figure and what it stands on, fractions')
    ap.add_argument('--x', type=float, required=True); ap.add_argument('--top', type=float, required=True)
    ap.add_argument('--bottom', type=float, required=True); ap.add_argument('--gap', type=float, default=0)
    ap.add_argument('--every', type=int, default=2, help='a key every N frames')
    a = ap.parse_args()
    try:
        x0, y0, x1, y1 = map(float, a.box.split(','))
    except ValueError:
        ap.error("box must contain four comma-separated numbers")
    if not (0 <= x0 < x1 <= 1 and 0 <= y0 < y1 <= 1):
        ap.error("box must lie inside the normalized frame")
    if a.t1 <= a.t0 or a.every < 1 or (a.at is not None and not a.t0 <= a.at <= a.t1):
        ap.error("check the shot interval, reference time and sampling interval")
    if not (0 <= a.x <= 1 and 0 <= a.top < a.bottom <= 1 and 0 <= a.gap <= 1):
        ap.error("measurement coordinates must lie inside the normalized frame")
    import numpy as np
    try:
        tr, W, H = track(a.video, a.t0, a.t1, (x0, y0, x1, y1))
    except ValueError as exc:
        ap.error(str(exc))
    if not tr:
        ap.error("no frames in the requested interval")
    # (measured on one frame: carry the points back to the first frame, then out to every frame)
    at = a.at if a.at is not None else a.t0
    Am = min(tr, key=lambda e: abs(e[0] - at))[1]
    inv = np.linalg.inv(Am)
    pts = np.array([[a.x * W, a.top * H, 1], [a.x * W, a.bottom * H, 1], [(a.x + a.gap / 2) * W, a.bottom * H, 1]]).T
    p0 = inv @ pts
    keys = []
    for i, (t, A) in enumerate(tr):
        if i % a.every and i != len(tr) - 1:
            continue
        p = A @ p0
        keys.append([round(t, 3), round(p[0, 1] / W, 4), round(p[1, 0] / H, 4), round(p[1, 1] / H, 4), round(2 * (p[0, 2] - p[0, 1]) / W, 4)])
    print(json.dumps({'keys': keys}))


if __name__ == '__main__':
    main()
