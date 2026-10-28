# NScribe by Nubicor — multi-bed, fully offline ED scribe

Speak or type; NScribe files each update into the right bed of your ED and builds the note. After a one-time
download of the speech model, it needs **no internet, no API keys and no server**. Patient data never leaves the device.

## What's in it

- **20 pre-created slots**: REDZONE R1–R6 and HDU H1A/H1B … H7A/H7B (7 beds shared by up to 2 patients each).
  Change the layout in `public/js/config.js` (`LAYOUT_DEFAULT`) or in the app: Settings > Beds.
- **Bed chips** with status colours (Empty, Occupied, Reassessment due, Posted/Shifted) and a dot for new/undecoded content,
  HDU chips grouped in pairs, an **All beds** overview, and one-tap switching that never mixes data.
- **One big mic** pinned to the bottom: "Recording → H3B". Audio goes to the selected bed; switching beds mid-speech finalises the
  running chunk under the old bed, then continues in the new one. Saying "bed R2 …", "H three B …", "reassess H2A …" routes
  the utterance (ambiguous or unknown beds ask you).
- **On-device speech**: Whisper (Tiny/Base/Small, quantised) running in a Web Worker via WebAssembly, with the *translate* task
  so Tamil, Hindi and mixed speech come out as English. Optional original-language transcript. Voice-activity detection cuts
  chunks at pauses; decoding is queued, non-blocking, and tagged with the bed it was recorded in.
- **On-device structuring**: rule-based parser (vitals, complaints with durations, denials, past history, drugs, investigations,
  impression, plan, disposition) with Tamil/Hindi vocabulary. It only copies what was said; anything unclear is flagged.
- **Timeline + vitals trend** per bed; **manual edits are never overwritten** by later auto-fill.
- **Export**: copy / .txt / Print-to-PDF per bed, a **handover sheet** for all occupied beds, JSON backup.
- **Privacy**: IndexedDB on the device, no analytics, no CDNs (fonts, runtime and WASM are bundled), optional PIN screen lock.

## Run and deploy

```
npm install          # only needed to refresh vendored files or run tests
npm start            # http://localhost:8080
npm run build        # regenerates public/sw.js (the offline file list) after you change anything in public/
npm test             # end-to-end tests (needs Playwright/Chromium)
```

Deploy: Netlify > Add new site > Deploy manually > drag the **`public`** folder in (or connect the Git repo; `netlify.toml`
publishes `public`). No build command is required. Details: see the deployment steps in the hand-over notes.

## Offline use

1. Open the site once with internet. The app files (about 16 MB) cache automatically.
2. Settings > Speech model > **Download** (Base is about 80 MB, one time, Wi-Fi recommended). The header then shows
   **Model ready – offline mode**.
3. Add to home screen / install. After that it works in airplane mode, including after a phone restart.
4. To verify: switch on airplane mode, force-close and reopen the app, record into a bed. In a desktop browser, open DevTools >
   Network while using it: you will see only requests to your own site, and none once everything is cached.

The only network request the app can ever make is the one-time model download from `huggingface.co` (or from your own site if you
place the model files under `public/models/`, see below). No patient data is included in it.

### Self-hosting the model (optional)

Put the Hugging Face files for e.g. `Xenova/whisper-base` under `public/models/Xenova/whisper-base/` (same folder layout as on
Hugging Face, including `onnx/*_quantized.onnx`), then deploy. The app finds them locally first, so no external host is needed.
Remember to run `npm run build` (model files are cached by the browser, not by the service worker).

## Code map (`public/js`)

| File | Role |
| --- | --- |
| `config.js` | Layout, defaults, note columns |
| `db.js`, `store.js` | IndexedDB; all bed changes; auto-fill rules (manual edits win) |
| `parser.js` | On-device text → vitals, symptoms, history, plan, disposition |
| `router.js` | Spoken bed names → slot |
| `vad.js`, `vad-worklet.js` | Mic capture, pause-based chunking, wake lock, auto-recover |
| `asr.js`, `asr-worker.js` | Decode queue (ids, retry, no double processing); Whisper in a worker |
| `asr-worker-stub.js` | **Test only** scripted decoder, used with `?stub=1` |
| `ui.js`, `settings.js`, `lock.js`, `export.js`, `main.js` | Screens, settings, PIN, exports, wiring |

## Honest limits

- Whisper *translate* is strongest for Hindi, weaker for Tamil, and weakest on code-switched Tamil/English/Hindi medical speech
  and drug names. Always read the English text and the filled fields. Pick the language in Settings when you can.
- The parser knows a fixed word list (about 25 symptoms, common drugs and illnesses). It misses what it does not know; it does not guess.
- The PIN hides the screen only; stored data is not encrypted.
- Drafts are for clinician review and signature.
