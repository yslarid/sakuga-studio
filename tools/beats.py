#!/usr/bin/env python3
"""Build a beat and downbeat map in source seconds with Beat This!."""
import argparse
from statistics import median
import subprocess

from media_io import cached, input_file, source_stamp, write_json


def beat_map(beats, downbeats):
    beats = [round(float(x), 4) for x in beats]
    intervals = [b - a for a, b in zip(beats, beats[1:]) if b > a]
    return {"beats": beats, "downbeats": [round(float(x), 4) for x in downbeats],
            "bpm": round(60 / median(intervals), 3) if intervals else None}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("song", type=input_file)
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()
    src = source_stamp(args.song)
    out = args.song.with_suffix(".beats.json")
    if out == args.song:
        parser.error("choose a source media file")
    model = "beat_this final0"
    if not args.force and cached(out, source=src, model=model):
        print(out)
        return
    import numpy as np
    import torch
    from beat_this.inference import Audio2Beats
    sr = 22050
    decoded = subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-i", args.song, "-vn", "-ac", "1",
                              "-ar", str(sr), "-f", "f32le", "-"], check=True, stdout=subprocess.PIPE).stdout
    pcm = np.frombuffer(decoded, dtype="<f4")
    if pcm.size == 0:
        parser.error("the source contains no audio samples")
    track = Audio2Beats(checkpoint_path="final0", device="mps" if torch.backends.mps.is_available() else "cpu", dbn=False)
    beats, downbeats = track(pcm, sr)
    write_json(out, {"source": src, "model": model, **beat_map(beats, downbeats)})
    print(out)


if __name__ == "__main__":
    main()
