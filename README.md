# NScribe

Offline emergency-department note builder by Nubicor. No server, no API key. Vitals flags, derived scores (MAP, shock index, qSOFA), a live structured note, copy / save as .txt, and saved encounters (browser storage).

## Use

Open `public/index.html` in a browser. That's it.

To install it as an app on a phone or desktop, serve the `public/` folder over HTTPS (any static host) or localhost (`python3 -m http.server -d public`), then use the browser's "Install" / "Add to Home Screen". After the first load it works with no connection.

## Voice and decoding

- **Start mic** uses the browser's speech recognition (Chrome, Edge, Android Chrome, Safari). Pick Tamil, Hindi or English first; it cannot auto-detect. In Chrome and Edge this is an online service, so it needs internet. Offline, use the phone keyboard's mic instead.
- **Decode and fill note** runs on the device with word lists (Tamil, Hindi, English, native script or romanised). It fills age, sex, arrival, MLC, triage, vitals (BP, HR, RR, SpO2, temp, GCS, RBS), allergies, past history, known medicines, chief complaint and history, with durations, denied symptoms and who said what. It never overwrites a field you already filled. It only knows common symptoms and drug names, so always check the result.

## Notes

- Encounters are stored in the browser only; clearing site data removes them.
- Output is a draft for clinician review. Do not enter patient names or hospital numbers.
- Fonts load from Google Fonts when online and fall back to system fonts offline.
