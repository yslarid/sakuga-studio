# Third-party software and media

## MP4 libraries

The browser loads these classic scripts directly from `vendor/`. Both work offline.

| Bundled path | Original release artifact | License |
| --- | --- | --- |
| `vendor/mp4-muxer.min.js` | `mp4-muxer@5.1.3`, `build/mp4-muxer.js` | MIT, © 2023 Vanilagy. [Included notice](vendor/LICENSE-mp4-muxer.txt) · [Official release archive](https://registry.npmjs.org/mp4-muxer/-/mp4-muxer-5.1.3.tgz) |
| `vendor/mp4box.all.min.js` and its source map | `mp4box@0.5.2`, `dist/mp4box.all.min.js` and `dist/mp4box.all.min.js.map` | BSD 3-Clause, © 2012 Telecom ParisTech/TSI/MM/GPAC Cyril Concolato. [Included notice](vendor/LICENSE-mp4box.txt) · [Official release archive](https://registry.npmjs.org/mp4box/-/mp4box-0.5.2.tgz) |

The files retain the upstream release bytes. The MP4 muxer uses its distribution build under the filename expected by the editor. To reproduce the files, obtain the pinned archives with `npm pack mp4-muxer@5.1.3 --ignore-scripts` and `npm pack mp4box@0.5.2 --ignore-scripts`. Extract the paths above from the archives’ `package/` directory, along with each `package/LICENSE`. The archive and individual file hashes are in the [dependency manifest](vendor/dependencies.json).

## Optional browser models

The analysis tools load their inference runtime from jsDelivr when used. The pinned releases are [ONNX Runtime Web 1.22.0](https://www.npmjs.com/package/onnxruntime-web/v/1.22.0) (MIT) and [Transformers.js 4.3.0](https://www.npmjs.com/package/@huggingface/transformers/v/4.3.0) (Apache-2.0). Model weights are downloaded separately on first use.

| Editor feature | Model and published license information |
| --- | --- |
| Face and head detection | The [face detector](https://huggingface.co/deepghs/anime_face_detection/tree/784dc4c0bb692351ddcdbe6131a050b17d3025d5) and [head detector](https://huggingface.co/deepghs/anime_head_detection/tree/06604feee81983792a57c21081e539c0ae229833) from deepghs each list MIT. |
| Foreground masks | [skytnt/anime-seg](https://huggingface.co/skytnt/anime-seg/tree/493cb60893f47441b26ec4fb9a306bce9e342982) lists Apache-2.0. |
| Speech transcription and word timing | [Xenova/whisper-small](https://huggingface.co/Xenova/whisper-small/tree/2d67713f236afa48a18992566e7647f6ca848e13) lists Apache-2.0. |
| Japanese-to-English translation | The editor uses the [ONNX conversion](https://huggingface.co/Xenova/opus-mt-ja-en/tree/1a906cfaaf7c8f4193f67f5885c082aa6dbd9d16) of [Helsinki-NLP/opus-mt-ja-en](https://huggingface.co/Helsinki-NLP/opus-mt-ja-en/tree/0770961a39ba6bd66305b149c3f4110bcafca2e6). The upstream model card lists Apache-2.0. |
| English lyric alignment | The editor uses the [ONNX conversion](https://huggingface.co/Xenova/wav2vec2-base-960h/tree/a19f851b3d42865797e410752b4c570c871e4825) of [facebook/wav2vec2-base-960h](https://huggingface.co/facebook/wav2vec2-base-960h/tree/22aad52d435eb6dbaf354bdad9b0da84ce7d6156). The upstream model card lists Apache-2.0. |

## Music

Two original recordings by Kevin MacLeod are included under Creative Commons Attribution 4.0 International. The track credits, publisher links and credit lines for exported edits are in [music/CREDITS.txt](music/CREDITS.txt). The [license text](music/LICENSE-CC-BY-4.0.txt) is included for offline use.

## Sound effects

The catalog contains 93 sound effects released under CC0 1.0. Each manifest entry gives its source. The included WAV files were converted to 16-bit PCM at 44.1 kHz, with quiet originals peak-normalized. The editor also synthesizes additional sounds with Web Audio. [CC0 legal text](sfx/LICENSE-CC0-1.0.txt)

- Kenney created the 68 selections from [Interface Sounds](https://kenney.nl/assets/interface-sounds), [Sci-fi Sounds](https://kenney.nl/assets/sci-fi-sounds), [Voiceover Pack: Fighter](https://kenney.nl/assets/voiceover-pack-fighter) and [Impact Sounds](https://kenney.nl/assets/impact-sounds). [Kenney catalog](sfx/manifest.json)
- Twenty-five transitions are drawn from the individually marked CC0 recordings by Freesound contributors in the [MixClap collection](https://www.mixclap.com/en/blog/transition-sound-effects). [Transition catalog](sfx/catalog-new.json)

## Visual effects

The 37 visual effects are adapted from CC0 1.0 source artwork. They were cropped, scaled, retimed or assembled into WebP sprite sheets for playback. Each effect carries its source URL in the [VFX manifest](vfx/manifest.json). [CC0 legal text](sfx/LICENSE-CC0-1.0.txt)

- Sinestesia supplied nine hand-animated effects from [2D Explosion Animations](https://opengameart.org/content/2d-explosion-animations-frame-by-frame), [Blood, Hit and Both](https://opengameart.org/content/animations-blood-hit-and-both-d), [Hit Animation](https://opengameart.org/content/hit-animation-frame-by-frame) and [Hit Animation 2](https://opengameart.org/content/hit-animation-2-frame-by-frame).
- Inguz Media supplied three effects from [2DFX Impact Spritesheets](https://opengameart.org/content/2dfx-impact-spritesheets). This distribution uses the author’s CC0 option.
- Unity Labs Paris supplied ten [VFX image sequences and flipbooks](https://unity.com/blog/engine-platform/free-vfx-image-sequences-flipbooks).
- Kenney supplied ten effects from [Particle Pack](https://kenney.nl/assets/particle-pack) and five from [Smoke Particles](https://kenney.nl/assets/smoke-particles).
