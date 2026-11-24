# Sakuga Studio

Sakuga Studio is a browser-based video editor for cutting footage to music. Drop in clips, overlays, and a song, and the editor proposes beat-synced cuts, speed ramps, and match-cut transitions. You can sculpt Bezier motion and speed curves, transform clips and text directly on the preview canvas, composite blend-mode overlays, inspect pre-flight QA checks, and export an H.264 MP4 with WebCodecs.

![The Afterlight example open in Sakuga Studio, with the preview above the editable timeline.](docs/editor.png)

## Run the editor

From a clone of this repository, start the local server with Python 3.9 or later.

```sh
git clone https://github.com/yslarid/sakuga-studio.git
cd sakuga-studio
python3 serve.py
```

Open [127.0.0.1:5178](http://127.0.0.1:5178) in desktop Chrome. On Windows you can run `py -3 serve.py`. The editor runs directly from the source files. Python serves them on the loopback interface.

Select **Open example** to load *Afterlight*, a four-second animation, and its original 120 BPM backing track. Watch the cuts against the waveform. Open **Text**, add a title at the playhead, then use **Export** to save an H.264 MP4. **Choose files** opens your own footage instead.

## Inside the editor

| If you’re interested in… | Start here |
| --- | --- |
| How a song becomes an edit | The [audio worker](js/analysis/audio-worker.js) finds beats and changes in energy. The [edit planner](js/engine/autoedit.js) and [match-cut matcher](js/engine/matchcut.js) pair those timings with pose, motion, and color continuity across 13 edit styles (including *Match-Cut Flow*, *Character Showcase*, and *3D Depth Lyric*). |
| Curves, keyframes, and direct manipulation | The [curve evaluator](js/curves.js) drives cubic Bezier velocity ramps and per-clip transform keyframes. The [graph editor](js/ui/graph-editor.js) edits keyframes and handles in a collapsible drawer, and the [canvas gizmo](js/ui/canvas-gizmo.js) supports drag, scale, rotate, and per-letter depth positioning on the preview. |
| What happens when you move a clip | The [timeline](js/ui/timeline.js) updates the [project state](js/state.js), including source timing, blend-mode overlay tracks (`OVL`), speed curves, and undo history. |
| Effects, grading, and MP4 export | The [effects catalog](js/effects.js) defines 59 GPU effects and camera/transition presets rendered by the [WebGL2 compositor](js/render/renderer.js). The [exporter](js/export/exporter.js) composites video, overlays, and text at the chosen format (including `5:4` and source-matched aspect) and encodes via WebCodecs. |
| How captions and 3D text follow speech | The [caption pipeline](js/lyrics.js) aligns words to the audio. The [text layer](js/render/text.js) renders styled titles, perspective warps, and per-letter depth lockups at the playhead. |
| Pre-flight checks and local media tools | The [QA panel](js/ui/qa-panel.js) flags pacing, exposure, transition, and match-cut issues with one-click fixes in the browser. The [local tools guide](docs/local-tools.md) covers optional Python utilities, their inputs, and their dependencies. |

You can also inspect a finished render for repeated frames and jumps in camera motion. Install FFmpeg on your path, then run the optical-flow audit on a short segment.

```sh
python -m pip install -r tools/requirements/motion.txt
python tools/flowaudit.py examples/Afterlight.mp4 --t0 0 --t1 2 --out motion-report
```

## What runs locally

The editor reads media through the browser’s file picker or the bundled example. Editing and export run on the device. The timeline lives in the current tab, so export your work before reloading. The browser can reuse cached analysis between sessions.

The core editor works with the bundled files. Google Fonts and optional model runtimes or weights use the network. Speech transcription and subject masks download the selected models on first use. Optional RIFE interpolation accepts a compatible local model. To enable it, place your weights in `models/rife422lite_fp16.onnx` and set `interpolationModelPath` in [interp.js](js/render/interp.js) to `../../models/rife422lite_fp16.onnx`. By default the exporter uses the original frames. MP4 export requires WebCodecs and a browser with an H.264 encoder.

The [browser smoke test](tests/README.md) imports the example, checks undo and redo, and verifies the exported video and audio streams with FFprobe.

## License

The original Sakuga Studio code in this repository is available under the [MIT License](LICENSE). Bundled libraries and media retain their respective licenses. See the [third-party credits and notices](THIRD_PARTY.md).
