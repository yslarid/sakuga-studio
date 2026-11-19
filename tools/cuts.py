#!/usr/bin/env python3
"""Print source timestamps for shot boundaries using TransNet V2 on the CPU."""
import argparse
from fractions import Fraction
import subprocess

from media_io import input_file

_model = None


def model():
    global _model
    if _model is None:
        import contextlib
        import io
        from transnetv2_pytorch import TransNetV2
        with contextlib.redirect_stdout(io.StringIO()):
            _model = TransNetV2(device='cpu')
        _model.eval()
    return _model


def fps_of(path):
    out = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=r_frame_rate', '-of', 'csv=p=0', path],
                         capture_output=True, text=True, check=True).stdout.strip()
    rate = Fraction(out)
    if rate <= 0:
        raise ValueError("source has no usable frame rate")
    return float(rate)


def cut_times(path, crop=None, threshold=0.5):
    """Cut times in seconds: where each new shot starts (a dissolve counts once, at its end)."""
    import numpy as np
    import torch
    vf = (f'crop={crop},' if crop else '') + 'scale=48:27'
    raw = subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-i', path, '-vf', vf, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
                         capture_output=True, check=True).stdout
    frames = np.frombuffer(raw, np.uint8).reshape(-1, 27, 48, 3)
    if len(frames) < 2:
        return []
    m = model()
    with torch.no_grad():
        single, _ = m.predict_frames(torch.from_numpy(frames.copy()), quiet=True)
    scenes = m.predictions_to_scenes(single.numpy(), threshold)
    fps = fps_of(path)
    return [round(float(a) / fps, 3) for a, _ in scenes[1:]]


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("video", type=input_file)
    parser.add_argument("--threshold", type=float, default=0.5)
    args = parser.parse_args()
    if not 0 < args.threshold < 1:
        parser.error("threshold must lie between zero and one")
    print('\n'.join(str(t) for t in cut_times(args.video, threshold=args.threshold)))
