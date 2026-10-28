# NScribe

Offline emergency-department note builder by Nubicor. No server, no API key, no network calls. Vitals flags, derived scores (MAP, shock index, qSOFA), a live structured note, copy / save as .txt, and saved encounters (browser storage).

## Use

Open `public/index.html` in a browser. That's it.

To install it as an app on a phone or desktop, serve the `public/` folder over HTTPS (any static host) or localhost (`python3 -m http.server -d public`), then use the browser's "Install" / "Add to Home Screen". After the first load it works with no connection.

## Notes

- Encounters are stored in the browser only; clearing site data removes them.
- Output is a draft for clinician review. Do not enter patient names or hospital numbers.
- Fonts load from Google Fonts when online and fall back to system fonts offline.
