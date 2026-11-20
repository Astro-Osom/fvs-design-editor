# Upscaling photos: models, licences and measurements

Research for the Upscale feature: making a low-resolution photo hold up when a design is exported at 4K. Facts marked "checked" were verified on 20 November 2026 from the model's own repository, model card, licence file, file listing or by running it. Nothing here relies on memory or blog posts for a licence or a size.

## What was needed

- Runs on the person's own computer, in the browser and in the desktop app. Nothing is uploaded.
- A licence that allows commercial use inside an MIT project. Nothing GPL, AGPL or non-commercial.
- A model file small enough to download on first use, with a ready-made ONNX export that a web page can fetch.
- Fast on a graphics card, and still usable without one.

## Models surveyed

Every file below is hosted on Hugging Face, whose download addresses send `Access-Control-Allow-Origin: *` (checked), so a page can fetch them. GitHub release downloads and Qualcomm's storage do not, which rules out fetching the official files directly.

| Model | Licence (code / weights) | ONNX size | Any input size | Scale | Verdict |
|---|---|---|---|---|---|
| Real-ESRGAN `realesr-general-x4v3` | BSD-3-Clause / BSD-3-Clause | 4.9 MB | Yes | 4 | **Chosen** |
| Real-ESRGAN `RealESRGAN_x4plus` | BSD-3-Clause / BSD-3-Clause | 33.7 MB (half precision), 67 MB | Yes | 4 | Much slower: about 40 seconds for one 720p photo on the test graphics card. Possible later as a "best quality" option. |
| Real-ESRGAN `RealESRGAN_x2plus` | BSD-3-Clause / BSD-3-Clause | 33.8 MB | Yes, even sizes | 2 | Too heavy for what it adds. |
| Real-ESRGAN `realesr-animevideov3` | BSD-3-Clause / BSD-3-Clause | 2.5 MB | Yes | 4 | Made for animation, not photos. |
| Swin2SR classical x2 / x4 | Apache-2.0 / Apache-2.0 | 54 to 55 MB | Multiples of 8 | 2 / 4 | Very large graph (about 28,000 steps), trained on clean downscales rather than real photos. |
| Swin2SR lightweight x2 | Apache-2.0 / Apache-2.0 | 8.1 MB | Multiples of 8 | 2 | 9.5 seconds just to start; slow per tile. |
| Swin2SR real-world x4 | Apache-2.0 / Apache-2.0 | 53.8 MB | Multiples of 8 | 4 | Too large and slow. |
| ClearRealityV1 (SPAN) | Apache-2.0 code; **weights changed from CC BY-NC-SA to Apache-2.0 on 11 February 2026** | 1.7 MB | Yes | 4 | **Not adopted: licence history is unclear.** See below. |
| 2xNomosUni (SPAN) | Apache-2.0 / CC BY 4.0 | 1.7 MB | Yes | 2 | 2x only; the published file also needs a fix to run on a graphics card. |
| RealPLKSR | MIT / MIT | 29.7 MB | No | 4 | Fixed input size. |
| EDSR x2 | Apache-2.0 upstream / none stated on the ONNX | 5.5 MB | Yes | 2 | Where the file came from is not documented. |
| ESPCN (ONNX model zoo) | Apache-2.0 | 0.2 MB | No (224, brightness only) | 3 | A demonstration model. |
| Qualcomm QuickSRNet / XLSR | BSD-3-Clause | 0.1 to 1.6 MB | No (128) | 4 | Cannot be fetched from a page. |

### The chosen model

**Real-ESRGAN "general x4 v3"** by Xintao Wang. A small model (4.9 MB) from a project aimed at real, degraded photos rather than clean test images.

- **Licence:** BSD-3-Clause for the code ([LICENSE](https://github.com/xinntao/Real-ESRGAN/blob/master/LICENSE), "Copyright (c) 2021, Xintao Wang"). The weights are published as release files of the same repository with no separate licence, so they fall under it. Commercial use is allowed (checked).
- **No official ONNX file exists.** The author publishes PyTorch files only. The editor uses third-party conversions on Hugging Face, and two of them were verified to contain the official weights bit for bit: all 101 weight tensors of the official file (SHA-256 `8dc7edb9…96292`) are present unchanged (checked).
- **Pinned and checked on download.** The editor asks for an exact revision and refuses any file whose SHA-256 differs:

| Source | Bytes | SHA-256 |
|---|---|---|
| `huggingface.co/thisismert/real-esrgan-onnx` at revision `238b42ef…`, `onnx/realesr-general-x4v3.onnx` | 4,866,418 | `5518a106453e751655edc12f208973207ab8355d0cafc1816b8a9041b01810dd` |
| `huggingface.co/skillsafe-ai/realesr-general-x4v3` at revision `042a40bc…`, `model.onnx` (second choice) | 4,866,428 | `a946f7a9397021b9b6b7e71df3d2821b04cc09ff244423b7ca79cb191ce4a00e` |

Both are small personal repositories and could disappear. If that happens, the fix is to host a copy in a repository the project controls and add its address to `src/upscale/model.ts`.

- **What the authors say about quality:** "not too strong deblur and denoise capacity". It has no face model; upstream uses a separate one (GFPGAN) when faces matter.

### The small fallback that was not adopted

ClearRealityV1 is three times smaller and about 2.7 times faster on a processor, which would make it a good fallback for computers without a usable graphics card. It was **not adopted**, for two reasons:

- Its weights were published as non-commercial (CC BY-NC-SA) until the author changed the model card to Apache-2.0 in February 2026. Another catalogue still lists the old licence. That is a question for the project's owner, not something to assume.
- The published file fails on a graphics card until its output dimensions are relabelled, so the project would have to host a modified copy.

Without it, the same chosen model runs on the processor when there is no graphics card. That is much slower (see below).

## The runtime

`onnxruntime-web` 1.31.1 (published 26 October 2026), MIT licence (checked on the npm registry; the project's GitHub repository returned "not found" on the day, so the licence file itself could not be read).

- It must be imported as `onnxruntime-web/webgpu`. The default import lacks a graphics-card version of one operation this model uses 33 times, and measured about 7 times slower.
- One WebAssembly file (28.7 MB, 7.3 MB compressed) serves both the graphics card and the processor. Vite puts it in the app's own files; nothing is loaded from a CDN (checked in the build output). It is only fetched when Upscale is first used.
- It runs inside a module Web Worker, which keeps the editor responsive and makes cancelling immediate (the worker is stopped).

## How the editor uses it

- The photo is cut into tiles: 224 pixels plus a 16-pixel margin on a graphics card, 96 plus 16 on the processor. Only the middle of each result is kept, so every output pixel is written once and there are no seams. Memory use does not grow with the size of the photo.
- 2 times larger is made by running the 4 times model and averaging each 2 by 2 block, tile by tile, so the 4 times picture never exists in memory.
- The model's output is not limited to the valid range, so it is clamped.
- The model works on colour only. A photo with transparency keeps it: the alpha channel is enlarged separately with a filter that cannot overshoot.
- The result is stored as a PNG under its own hash, next to the untouched original. Results larger than 8192 pixels on a side or 40 megapixels are not offered.
- If the model cannot be downloaded or cannot run, a plain resize (Lanczos) is offered and labelled as adding no new detail.

## Measurements

One machine: Apple M1 Pro, 16 GB, in the desktop app (Electron 45), graphics card through WebGPU ("apple metal-3"). The photo was a 1280 by 720 JPEG with gradients, shapes, noise and text. Time is from pressing Upscale to seeing the result, so it includes starting the worker and saving the PNG. Memory is the whole app (all its processes), sampled ten times a second.

| Run | Result | Time | Memory before | Peak |
|---|---|---|---|---|
| First ever, 4 times, graphics card (includes the 4.9 MB download) | 5120 × 2880 | 7.3 s | 501 MB | 1,048 MB |
| Again, 4 times, graphics card | 5120 × 2880 | 5.4 s and 5.8 s | about 1,000 MB | 1,181 and 1,241 MB |
| 2 times, graphics card | 2560 × 1440 | 5.3 s | 1,204 MB | 1,309 MB |
| 4 times, processor (graphics card switched off) | 5120 × 2880 | 149.6 s | 555 MB | 924 MB |
| 2 times, processor | 2560 × 1440 | 149.1 s | 466 MB | 735 MB |

Notes:

- 2 times takes as long as 4 times because the model does the same work; only the stored result is smaller.
- The app's memory did not fall back to its starting level between runs in one sitting. Whether that is memory waiting to be reclaimed or a slow leak was not established.
- On the processor the model runs on one thread. Several threads would need the page to be "cross-origin isolated". That was tried in the desktop app: the page became isolated, but the runtime then failed to start inside the worker, so it was backed out. This is the most valuable thing left to fix for computers without a usable graphics card.
- Expect a laptop with a basic built-in graphics card to take several times longer than this one. That is an estimate, not a measurement.

## Network hosts

The model download needs `huggingface.co` and the host it redirects to (`us.aws.cdn.hf.co` on the day; any `*.hf.co`). Both were contacted only on the first run. They are already on the allowed list of the project's cloud environment, and the desktop app's security policy now allows exactly these in addition to the two Google Fonts hosts.

## Not checked

- **Picture quality on real photographs.** Only a synthetic test picture was looked at: text edges came out crisp and JPEG blockiness was smoothed. No faces, hair, skin, foliage or screenshots were tried. Small text and fine regular patterns may be redrawn wrongly by this kind of model.
- **Other graphics cards, Windows and Linux.**
- **Firefox and Safari**, where WebGPU support differs.
- **Very large photos** near the size limits, and memory over many runs.
- The licence of `onnxruntime-web` was read from the npm registry, not from its repository.
