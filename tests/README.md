# Browser smoke test

This optional check runs the editor in a fresh Chrome session. It opens both example files through the file picker, analyzes the footage and beat track, applies a timeline effect, and tests undo and redo. It then exports the four-second edit and checks its H.264 frames and AAC audio. After reloading the tab, it uses **Open example** to build the timeline again.

The test needs Node.js 20 or later, Python 3, Google Chrome, and the `ffmpeg` and `ffprobe` commands. From the repository root, install Playwright for the test and start it with Chrome.

```sh
npm install --no-save --package-lock=false playwright
CHROME_CHANNEL=chrome node tests/editor-smoke.cjs
```

To capture the loaded editor, add `--screenshot editor-preview.png`. To choose a specific browser executable, set `CHROME_PATH` instead of `CHROME_CHANNEL`. Set `PYTHON` if your Python 3 command is named something other than `python3`.

The script starts the repository’s loopback server on an available port. It blocks external requests, uses the included original animation and pulse track, and removes its temporary export when it finishes.
