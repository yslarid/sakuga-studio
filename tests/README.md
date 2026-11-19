# Browser smoke test

This optional check runs the editor in a fresh Chrome session. It uses **Open example** to analyze the included footage and beat track, applies a timeline effect, and tests undo and redo. It then exports the four-second edit and checks its H.264 frames and AAC audio. After reloading the tab, it imports the same two files through the file picker and rebuilds the timeline.

The test also checks that Original follows the sample on desktop and mobile, orientation survives undo and redo, and clearing the media restores Open example. It verifies the import and export libraries load on demand and that a captioned export produces a portrait cover with external fonts blocked.

The test needs Node.js 20 or later, Python 3, Google Chrome, and the `ffmpeg` and `ffprobe` commands. From the repository root, install Playwright for the test and start it with Chrome.

```sh
npm install --no-save --package-lock=false playwright
CHROME_CHANNEL=chrome node tests/editor-smoke.cjs
```

To capture the loaded editor, add `--screenshot editor-preview.png`. To choose a specific browser executable, set `CHROME_PATH` instead of `CHROME_CHANNEL`. Set `PYTHON` if your Python 3 command is named something other than `python3`.

The script starts the repository’s loopback server on an available port. It blocks external requests, uses the included original animation and pulse track, and removes its temporary export when it finishes.

To check a hosted copy on a local server, set `SAKUGA_BASE_URL` to its loopback editor URL (for example, `http://127.0.0.1:4173/sakuga-editor/`).
