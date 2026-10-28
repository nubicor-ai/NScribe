# Optional: faster decoding with multiple CPU threads

Whisper decodes 2-3x faster when the browser may use several threads. That needs two extra response headers:

    Cross-Origin-Opener-Policy: same-origin
    Cross-Origin-Embedder-Policy: require-corp

They are OFF by default because they change how the browser treats every request, and the one-time model download
from huggingface.co could not be tested in the build environment. To try it:

1. Add the two lines under `[headers.values]` for `/*` in `netlify.toml` (and to `public/_headers`), redeploy.
2. Open the app online, tap Settings > Speech model > Download, and confirm the download completes.
3. If the download fails, remove the two lines again. Nothing else changes.

Setting COI=1 when running `npm start` sends the same headers locally for testing.
