#!/usr/bin/env python3
"""Extract word-timed dialogue with MLX Whisper, optionally isolating voices with Demucs."""
import argparse
from math import gcd
import re
import subprocess
import sys
import tempfile
from pathlib import Path

from media_io import cached, input_file, source_stamp, write_json
from stems import open_separator, vocal_track

SR = 16000
JA = re.compile(r'[\u3040-\u30ff\u31f0-\u31ff\uff66-\uff9f]')  # kana: Japanese, not Chinese
# Skip common non-dialogue labels, musical cues and transcription artifacts.
JUNK = re.compile(r'[\[\]♪()*]|thank(s| you) for watching|subscribe|subtitle|^(you|music|applause|oh|ah)[.!]*$|ご視聴|チャンネル登録|字幕|お疲れ様でした$', re.I)


def load_pcm(path, stereo=False):
    import numpy as np
    out = subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-i', path, '-vn', '-ac', '2' if stereo else '1', '-ar', str(SR), '-f', 'f32le', '-'],
                         capture_output=True, check=True).stdout
    a = np.frombuffer(out, dtype=np.float32)
    return a.reshape(-1, 2) if stereo else a


def voices_only(footage, tmp):
    """The footage's voices, separated by Demucs (htdemucs), as 16 kHz mono."""
    from scipy.signal import resample_poly
    separator = open_separator()
    voice = vocal_track(separator, footage, Path(tmp) / "mix.wav")
    divisor = gcd(SR, separator.samplerate)
    return resample_poly(voice, SR // divisor, separator.samplerate // divisor)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('footage', type=input_file)
    ap.add_argument('--raw', action='store_true', help='transcribe the mix as it is (no voice separation)')
    ap.add_argument('--lang', default='auto', help="spoken language ('auto' to let Whisper tell)")
    ap.add_argument('--model', default='mlx-community/whisper-large-v3-turbo')
    ap.add_argument('--force', action='store_true')
    a = ap.parse_args()
    footage = a.footage
    out_path = footage.with_suffix(".dialogue.json")
    settings = {"source": source_stamp(footage), "model": a.model, "separated": not a.raw, "requested_language": a.lang}
    if not a.force and cached(out_path, **settings):
        print(out_path)
        return
    import numpy as np
    import mlx_whisper
    with tempfile.TemporaryDirectory() as tmp:
        mix = load_pcm(footage, stereo=True)
        voice = mix.mean(1) if a.raw else voices_only(footage, tmp)
    print(f'transcribing {len(voice) / SR:.0f} s of {"audio" if a.raw else "separated voices"}', file=sys.stderr)

    def run(lang):
        return mlx_whisper.transcribe(voice.astype(np.float32), path_or_hf_repo=a.model, language=lang, task='transcribe', word_timestamps=True,
                                      condition_on_previous_text=False, hallucination_silence_threshold=1.5, no_speech_threshold=0.6, verbose=None)
    res = run(None if a.lang == 'auto' else a.lang)
    segs = [s for s in res['segments'] if s['text'].strip()]
    # For an explicit Japanese pass, retry language detection when almost no lines contain kana.
    if a.lang == 'ja' and segs and sum(1 for s in segs if JA.search(s['text'])) < len(segs) * 0.3:
        res = run(None)
    lines = dialogue_lines(res, mix)
    write_json(out_path, {**settings, "lines": lines})
    print(f"{len(lines)} spoken lines", file=sys.stderr)
    print(out_path)


def dialogue_lines(res, mix):
    """Keep dialogue candidates with usable word bounds and vocal prominence."""
    import numpy as np
    mid = mix.mean(1)
    fr = SR // 20
    n = len(mid) // fr
    rms = np.sqrt((mid[:n * fr].reshape(n, fr) ** 2).mean(1)) if n else np.zeros(1)
    med = float(np.median(rms)) or 1e-4
    lines = []
    for s in res['segments']:
        text = re.sub(r'\s+', ' ', s['text']).strip()
        ws = [w for w in s.get('words') or [] if w['word'].strip()]
        if not text or JUNK.search(text):
            continue
        a0, a1 = (ws[0]['start'], ws[-1]['end']) if ws else (s['start'], s['end'])
        if a1 - a0 < 0.3 or a1 - a0 > 12 or len(text) / (a1 - a0) > 22 or len(text) > 140:
            continue
        seg = rms[int(a0 * 20):max(int(a0 * 20) + 1, int(a1 * 20))]
        lines.append({'start': round(a0, 3), 'end': round(a1 + 0.08, 3), 'original': text, 'loud': round(float(seg.mean()) / med, 2) if len(seg) else 0,
                      'lang': res.get('language'), 'words': [[w['word'].strip(), round(w['start'], 3), round(w['end'], 3)] for w in ws]})
    # the same line over and over across music is a hallucination loop, not dialogue
    key = lambda x: re.sub(r'[\s、。,.!?！？…]', '', x['original'])
    looped = {key(x) for x in lines if sum(1 for y in lines if key(y) == key(x) and abs(y['start'] - x['start']) < 20) >= 3}
    lines = [x for x in lines if key(x) not in looped]
    return lines


if __name__ == '__main__':
    main()
