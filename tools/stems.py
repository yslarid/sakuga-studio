#!/usr/bin/env python3
"""Extract a dialogue stem for each specified time range using Demucs."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile

from media_io import atomic_output, input_file, seconds, source_stamp

PRE, POST, CONTEXT = 0.12, 0.3, 1.5
OUTPUT_RATE = 48_000


def parse_span(value):
    try:
        start, end = map(seconds, value.split(":"))
    except (ValueError, argparse.ArgumentTypeError) as exc:
        raise argparse.ArgumentTypeError("use START:END in seconds") from exc
    if start >= end:
        raise argparse.ArgumentTypeError("END must follow START")
    return value, start, end


def open_separator():
    from demucs.api import Separator
    import torch
    return Separator(model="htdemucs", device="mps" if torch.backends.mps.is_available() else "cpu", segment=7.8)


def vocal_track(separator, media, decoded_path, start=None, duration=None):
    command = ["ffmpeg", "-nostdin", "-v", "error", "-y"]
    if start is not None:
        command += ["-ss", str(start), "-t", str(duration)]
    subprocess.run(command + ["-i", media, "-vn", "-ac", "2", "-ar", str(separator.samplerate), decoded_path], check=True)
    _, stems = separator.separate_audio_file(os.fspath(decoded_path))
    return stems["vocals"].detach().cpu().numpy().mean(axis=0)


def trim_voice(voice, rate, start, end, context_start):
    import numpy as np
    lo = max(0, round((start - PRE - context_start) * rate))
    hi = min(len(voice), round((end + POST - context_start) * rate))
    if hi <= lo:
        raise ValueError("requested span falls outside the decoded audio")
    voice = voice[lo:hi].copy()
    fade = round(0.03 * rate)
    if fade > 0 and len(voice) > 8 * fade:
        voice[:fade] *= np.linspace(0, 1, fade)
        voice[-4 * fade:] *= np.linspace(1, 0, 4 * fade)
    return voice


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("footage", type=input_file)
    parser.add_argument("output_directory", type=Path)
    parser.add_argument("spans", nargs="+", type=parse_span, metavar="START:END")
    args = parser.parse_args()
    args.output_directory.mkdir(parents=True, exist_ok=True)
    key = json.dumps([str(args.footage), source_stamp(args.footage)], sort_keys=True)
    tag = hashlib.sha256(key.encode()).hexdigest()[:16]
    result = {}
    separator = None
    with tempfile.TemporaryDirectory() as work:
        decoded = Path(work) / "decoded.wav"
        voice_file = Path(work) / "voice.wav"
        for span, start, end in args.spans:
            name = f"stem-{tag}-{start}-{end}-htdemucs.wav"
            path = args.output_directory / name
            if not path.is_file():
                import soundfile as sf
                if separator is None:
                    separator = open_separator()
                context_start = max(0, start - CONTEXT)
                signal = vocal_track(separator, args.footage, decoded, context_start, end - context_start + CONTEXT)
                trimmed = trim_voice(signal, separator.samplerate, start, end, context_start)
                sf.write(voice_file, trimmed, separator.samplerate, subtype="FLOAT")
                with atomic_output(path) as draft:
                    subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-y", "-i", voice_file, "-ar",
                                    str(OUTPUT_RATE), "-ac", "1", "-c:a", "pcm_s16le", draft], check=True)
            result[span] = str(path.resolve())
    print(json.dumps(result))


if __name__ == "__main__":
    main()
