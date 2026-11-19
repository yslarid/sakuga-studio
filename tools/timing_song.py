#!/usr/bin/env python3
"""Build a spoken-word timing fixture with a measured onset and offset for each word."""
import argparse
import array
import math
import shutil
import os
from pathlib import Path
import subprocess
import tempfile
import wave

from media_io import atomic_output, input_file, write_json

SR = 16000

def run(*a):
    subprocess.run(a, check=True, capture_output=True)

def read_wav(path):
    with wave.open(path) as w:
        if w.getframerate() != SR or w.getnchannels() != 1 or w.getsampwidth() != 2:
            raise ValueError("expected a 16 kHz mono PCM16 wave")
        return array.array('h', w.readframes(w.getnframes()))

def word_audio(tmp, word, flat, voice, rate, recorded):
    aiff, wav = os.path.join(tmp, 'word.aiff'), os.path.join(tmp, 'word.wav')
    if recorded:
        if not word.isalnum():
            raise ValueError("use only letters or digits in phrases when supplying recorded words")
        source = recorded / (word + ".wav")
        if not source.is_file():
            raise ValueError(f"missing recorded word: {source.name}")
    elif shutil.which("say"):
        text = ("[[pmod 0]] [[pbas 48]] " if flat else "") + word
        command = ["say", "-r", str(rate), "-o", aiff]
        if voice:
            command.extend(["-v", voice])
        run(*command, "--", text)
        source = aiff
    else:
        source = os.path.join(tmp, "synth.wav")
        command = ["espeak-ng", "-s", str(rate), "-w", source]
        if voice:
            command.extend(["-v", voice])
        if flat:
            command.extend(["-z", "-a", "100", "-p", "45"])
        run(*command, "--", word)
    run("ffmpeg", "-nostdin", "-v", "error", "-y", "-i", source, "-ac", "1", "-ar", str(SR), wav)
    x = read_wav(wav)
    # the word's own onset and offset: first/last 10 ms above 3% of its peak
    if not x:
        raise ValueError("speech synthesizer produced empty audio; select an installed voice with --voice")
    peak = max(1, max(abs(v) for v in x))
    fr = SR // 100
    loud = [max(abs(v) for v in x[i:i + fr]) > peak * 0.03 for i in range(0, len(x), fr)]
    if not any(loud):
        raise ValueError(f"speech synthesizer produced no voiced samples for {word!r}")
    a = loud.index(True) * fr
    b = (len(loud) - loud[::-1].index(True)) * fr
    return x[a:b]

def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('out')
    ap.add_argument('--flat', action='store_true', help='use reduced intonation where supported and a slower default voice')
    ap.add_argument('--vocal-db', type=float, default=-2)
    ap.add_argument('--name', default='timing-song')
    ap.add_argument('--voice', help='installed voice for the selected speech synthesizer')
    ap.add_argument('--recorded-words', type=Path, metavar='DIRECTORY',
                    help='use local WORD.wav files with matching alphanumeric words instead of synthesizing')
    ap.add_argument('--rate', type=int, default=0, help='words per minute (default 165, or 115 with --flat)')
    ap.add_argument('--step', type=float, default=0.25, help='grid step in seconds (0.25 = eighths at 120 BPM)')
    ap.add_argument('--lyrics', type=input_file, required=True, help='UTF-8 text, one phrase per line')
    ap.add_argument('--music', type=input_file, required=True, help='local backing audio')
    ap.add_argument('--music-start', type=float, default=0)
    a = ap.parse_args()
    if not (math.isfinite(a.step) and a.step > 0 and a.rate >= 0 and math.isfinite(a.music_start) and a.music_start >= 0 and math.isfinite(a.vocal_db)):
        ap.error("step must be positive and rate/start must be nonnegative")
    if not a.name or a.name in (".", "..") or Path(a.name).name != a.name:
        ap.error("name must be a single filename stem")
    if a.recorded_words and not a.recorded_words.is_dir():
        ap.error("--recorded-words must be a directory")
    if not a.recorded_words and not (shutil.which("say") or shutil.which("espeak-ng")):
        ap.error("install espeak-ng or use macOS say")
    lines = [line.strip() for line in a.lyrics.read_text(encoding="utf-8").splitlines() if line.strip()]
    if not lines:
        ap.error("lyrics must contain at least one word")
    os.makedirs(a.out, exist_ok=True)
    out = Path(a.out) / (a.name + ".m4a")
    truth_path = Path(a.out) / (a.name + ".truth.json")
    if out.resolve() in (a.music, a.lyrics) or truth_path.resolve() in (a.music, a.lyrics):
        ap.error("choose output filenames distinct from the inputs")
    step = a.step
    t, voc, truth = 1.0, array.array('h'), []
    with tempfile.TemporaryDirectory() as tmp:
        for li, line in enumerate(lines):
            for word in line.split():
                try:
                    x = word_audio(tmp, word, a.flat, a.voice, a.rate or (115 if a.flat else 165), a.recorded_words)
                except ValueError as exc:
                    ap.error(str(exc))
                start = math.ceil(t / step - 1e-6) * step
                i0 = int(start * SR)
                if len(voc) < i0 + len(x):
                    voc.extend([0] * (i0 + len(x) - len(voc)))
                for k, v in enumerate(x):
                    voc[i0 + k] = v
                truth.append({'text': word, 'line': li, 'start': round(start, 3), 'end': round(start + len(x) / SR, 3)})
                t = start + len(x) / SR + 0.04
            t += 0.9  # a breath between lines
        dur = len(voc) / SR + 1.5
        vwav = os.path.join(tmp, 'vocal.wav')
        with wave.open(vwav, 'wb') as w:
            w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR); w.writeframes(voc.tobytes())
        # vocal: a little room reverb, level set against the music's loudness; then mixed
        flt = (f'[0:a]aresample=44100,aecho=0.8:0.5:40|70:0.25|0.15,loudnorm=I=-18:TP=-2,volume={a.vocal_db}dB[v];'
               f'[1:a]atrim={a.music_start}:{a.music_start + dur},asetpts=PTS-STARTPTS,aresample=44100,loudnorm=I=-18:TP=-2[m];'
               '[v][m]amix=inputs=2:duration=longest:normalize=0,alimiter=limit=0.95[o]')
        with atomic_output(out) as draft:
            run('ffmpeg', '-nostdin', '-v', 'error', '-y', '-i', vwav, '-i', a.music, '-filter_complex', flt,
                '-map', '[o]', '-ac', '2', '-c:a', 'aac', '-b:a', '192k', draft)
    write_json(truth_path, truth)
    print(out, f'{len(truth)} words, {dur:.1f}s')

if __name__ == '__main__':
    main()
