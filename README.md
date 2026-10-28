# NScribe

Emergency-department scribe by Nubicor. Paste or load a Tamil, Hindi or English conversation, and Claude decodes the history and fills a structured ED note. Installable as a PWA, works offline for manual entry.

## Run

```
ANTHROPIC_API_KEY=sk-ant-... npm start
```

Open http://localhost:3000. No dependencies; Node 18+.

| Env var | Purpose |
| --- | --- |
| `ANTHROPIC_API_KEY` | Required for Decode / Fill. The key stays on the server. |
| `ACCESS_CODE` | Optional. If set, the app asks for this code before calling Claude. Set it on any public deployment. |
| `NSCRIBE_MODEL` | Optional. Defaults to `claude-sonnet-5-5`. |
| `PORT` | Optional. Defaults to 3000. |

## Layout

- `public/` the app (single-page `index.html`, manifest, service worker, icons)
- `server/index.js` static server plus `POST /api/sample`, a rate-limited proxy to the Anthropic Messages API

## Notes

- Encounters are saved in the browser's localStorage only. Nothing is stored server-side, and conversation text is sent to Anthropic only when Decode or Fill is tapped.
- Output is a draft for clinician review. Do not enter patient names or hospital numbers.
- Serve over HTTPS in production (required for install and the service worker off localhost).
