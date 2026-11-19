# Third-party software and media

## MP4 libraries

The browser loads these classic scripts directly from `vendor/`. Both work offline.

| Bundled path | Original release artifact | License |
| --- | --- | --- |
| `vendor/mp4-muxer.min.js` | `mp4-muxer@5.1.3`, `build/mp4-muxer.js` | MIT, © 2023 Vanilagy. [Included notice](vendor/LICENSE-mp4-muxer.txt) · [Official release archive](https://registry.npmjs.org/mp4-muxer/-/mp4-muxer-5.1.3.tgz) |
| `vendor/mp4box.all.min.js` and its source map | `mp4box@0.5.2`, `dist/mp4box.all.min.js` and `dist/mp4box.all.min.js.map` | BSD 3-Clause, © 2012 Telecom ParisTech/TSI/MM/GPAC Cyril Concolato. [Included notice](vendor/LICENSE-mp4box.txt) · [Official release archive](https://registry.npmjs.org/mp4box/-/mp4box-0.5.2.tgz) |

The files retain the upstream release bytes. The MP4 muxer uses its distribution build under the filename expected by the editor. To reproduce the files, obtain the pinned archives with `npm pack mp4-muxer@5.1.3 --ignore-scripts` and `npm pack mp4box@0.5.2 --ignore-scripts`. Extract the paths above from the archives’ `package/` directory, along with each `package/LICENSE`. The archive and individual file hashes are in the [dependency manifest](vendor/dependencies.json).

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
