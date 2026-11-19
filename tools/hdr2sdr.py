#!/usr/bin/env python3
"""Tone-map limited-range BT.2020/PQ video to BT.709 SDR while preserving compatible audio."""
import argparse
from fractions import Fraction
import json
import math
from pathlib import Path
import subprocess

from media_io import atomic_output, input_file


def tone_map(encoded, white):
    import numpy as np
    m1, m2 = 2610 / 16384, 2523 / 4096 * 128
    c1, c2, c3 = 3424 / 4096, 2413 / 4096 * 32, 2392 / 4096 * 32
    p = np.power(np.clip(encoded, 0, 1), 1 / m2)
    nits = 10000 * np.power(np.maximum(p - c1, 0) / (c2 - c3 * p), 1 / m1)
    matrix = np.array([[1.6605, -0.5876, -0.0728], [-0.1246, 1.1329, -0.0083],
                       [-0.0182, -0.1006, 1.1187]], dtype=np.float32)
    linear = np.maximum((nits / white) @ matrix.T, 0)
    knee, peak = 0.8, 4.0
    t = np.clip((linear - knee) / (peak - knee), 0, 1)
    rolled = np.where(linear <= knee, linear, knee + (1 - knee) * (1 - (1 - t) ** 3))
    return np.where(rolled < 0.018, 4.5 * rolled, 1.099 * np.power(np.maximum(rolled, 0.018), 0.45) - 0.099)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=input_file)
    parser.add_argument("output", type=Path)
    parser.add_argument("--white", type=float, default=203, help="reference white in nits (default 203)")
    args = parser.parse_args()
    if not math.isfinite(args.white) or args.white <= 0:
        parser.error("--white must be positive and finite")
    if args.source == args.output.resolve():
        parser.error("choose a distinct output file")
    info = subprocess.check_output(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_streams",
                                    "-of", "json", args.source])
    streams = json.loads(info)["streams"]
    if not streams:
        parser.error("source has no video stream")
    stream = streams[0]
    if (stream.get("color_transfer"), stream.get("color_space"), stream.get("color_primaries"),
            stream.get("color_range")) != ("smpte2084", "bt2020nc", "bt2020", "tv"):
        parser.error("expected a tagged, limited-range BT.2020 nonconstant-luminance PQ source")
    width, height = stream["width"], stream["height"]
    if width % 2 or height % 2:
        parser.error("4:2:0 output requires even dimensions")
    rate = stream["r_frame_rate"]
    if Fraction(rate) <= 0 or Fraction(stream["avg_frame_rate"]) != Fraction(rate):
        parser.error("provide a constant-frame-rate source")
    import numpy as np
    decode = ["ffmpeg", "-nostdin", "-v", "error", "-noautorotate", "-i", args.source, "-map", "0:v:0",
              "-vf", "scale=in_color_matrix=bt2020:in_range=tv:out_range=full:flags=accurate_rnd+full_chroma_int,format=rgb48le",
              "-fps_mode", "passthrough", "-f", "rawvideo", "-"]
    encode = ["ffmpeg", "-nostdin", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s",
              f"{width}x{height}", "-r", rate, "-i", "-", "-i", args.source, "-map", "0:v", "-map", "1:a?",
              "-c:a", "copy", "-c:v", "libx264", "-crf", "10", "-preset", "medium", "-pix_fmt", "yuv420p",
              "-vf", "scale=out_color_matrix=bt709:out_range=tv:flags=accurate_rnd+full_chroma_int,"
                     "setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv",
              "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv"]
    size = width * height * 6
    with atomic_output(args.output) as draft:
        with subprocess.Popen(decode, stdout=subprocess.PIPE) as decoder:
            with subprocess.Popen([*encode, draft], stdin=subprocess.PIPE) as encoder:
                try:
                    while raw := decoder.stdout.read(size):
                        if len(raw) != size:
                            raise ValueError("truncated raw video frame")
                        frame = np.frombuffer(raw, dtype="<u2").reshape(height, width, 3).astype(np.float32) / 65535
                        sdr = tone_map(frame, args.white)
                        encoder.stdin.write((np.clip(sdr, 0, 1) * 255 + 0.5).astype(np.uint8).tobytes())
                    encoder.stdin.close()
                    if decoder.wait() or encoder.wait():
                        raise RuntimeError("ffmpeg failed to convert the source")
                finally:
                    decoder.stdout.close()
                    if decoder.poll() is None:
                        decoder.kill()
                    if encoder.poll() is None:
                        encoder.kill()
    print(args.output)


if __name__ == "__main__":
    main()
