# Local media tools

These optional Python programs analyze local media and write ordinary WAV or JSON files. The browser editor runs independently. All timestamps below are seconds from the beginning of the input.

Create a virtual environment, activate it for your shell, and install the requirements for the command you want. Run the examples from the repository root with Python 3.11 or newer. FFmpeg and ffprobe must be on your PATH.

```sh
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -r tools/requirements/onsets.txt
python tools/onsetcheck.py soundtrack.wav 0.5 1.0 1.5
```

| Command | Install from tools/requirements/ | What it produces |
| --- | --- | --- |
| `python tools/stems.py clip.mp4 stems 2.0:4.5 7.0:8.0` | `stems.txt` | A mono 48 kHz PCM WAV per range and a JSON file-path map on stdout. The extractor includes 1.5 s of surrounding context for separation, then trims each line with 120 ms of lead and 300 ms of tail where available. |
| `python tools/transcribe.py clip.mp4 --lang auto` | `transcribe.txt` | A sibling `.dialogue.json` with word-level timings, the detected language, and relative loudness for candidate lines. Uses MLX Whisper on Apple silicon. Add `--raw` to skip Demucs separation, or `--model` to select a compatible local model path or Hugging Face repository. |
| `python tools/beats.py soundtrack.wav` | `beats.txt` | A sibling `.beats.json` with Beat This! beat and downbeat times and the median-interval BPM. BPM is null when there are fewer than two usable beats. |
| `python tools/onsetcheck.py soundtrack.wav 1.0 1.5 2.0` | `onsets.txt` | A JSON comparison of supplied cuts against spectral onsets at three strengths. Reports counts within 40 ms, the best shift within ±120 ms and the distribution for random shifts. A positive shift moves cuts later. |
| `python tools/cuts.py clip.mp4` | `cuts.txt` | TransNet V2 shot-start times, one per line. Runs on CPU. The time conversion assumes a constant frame rate. |
| `python tools/shots.py index clip.mp4` | `shots.txt` | A sibling `.shots.json` with spans, color, sampled motion and SigLIP embeddings. FFmpeg finds scene boundaries by default. Add `--detector transnet` after installing `cuts.txt` to use the learned detector. An optional sibling `.cuts.json` array adds known splice times. |
| `python tools/shots.py search clip.mp4 "person walking through a doorway" --top 5` | `shots.txt` | Shots ranked by similarity to the text query. `python tools/shots.py list clip.mp4 --sort motion` reads the same index using only Python's standard library. |
| `python tools/track.py clip.mp4 --from 0 --to 1 --box .2,.2,.8,.8 --x .5 --top .25 --bottom .75` | `tracking.txt` | Normalized subject position and scale keys from optical flow and a robust similarity fit. Use a single constant-frame-rate shot and select a region with visible texture. |
| `python tools/hdr2sdr.py input.mkv output.mkv` | `hdr.txt` | An H.264 BT.709 rendition of limited-range, BT.2020/PQ footage with compatible audio streams copied. Supply a constant-frame-rate source with even dimensions and explicit color tags. `--white` sets reference white in nits. |
| `python tools/timing_song.py fixtures --lyrics phrases.txt --music backing.wav` | Standard library | A synthesized timing fixture and a `.truth.json` word map. The phrases come from your UTF-8 text file and the backing track from your audio file. Uses macOS `say`, `espeak-ng`, or a directory of your own recordings with `--recorded-words words` (one `WORD.wav` for each alphanumeric token). |

Demucs, MLX Whisper, Beat This!, TransNet V2 and SigLIP use separately distributed models. First use can download weights, and each model has its own terms. The optical-flow tracker, onset comparison, HDR converter and speech timing fixture do their work without pretrained weights. Beats, transcription, shot indexing and stem extraction reuse results for matching inputs. Use `--force` on the beat, transcription and shot-indexing commands to recompute; deleting a cached stem WAV regenerates that range. Long footage can require substantial memory, especially whole-file audio decoding and shot detection.

The transcript filter is tuned for editing dialogue excerpts. It drops repeated short lines, non-dialogue labels and segments outside its duration and reading-rate limits. The timing fixture records the dry spoken word boundaries before mixing with the backing track.

Run the focused checks with `python -m unittest discover -s tools/tests -p test_local_tools.py`. The checks use synthetic fixtures, exercise FFmpeg when installed, and never initialize a pretrained model. NumPy enables the signal-processing checks.
