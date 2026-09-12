Vendored at install time by `scripts/vendor-vad.mjs` (run `npm run vendor-vad` to refresh):

- `bundle.min.js`, `vad.worklet.bundle.min.js`, `silero_vad_v5.onnx`, `silero_vad_legacy.onnx` from `@ricky0123/vad-web` (ISC, Silero VAD model under MIT)
- `ort-wasm-simd-threaded.mjs`, `ort-wasm-simd-threaded.wasm` from `onnxruntime-web` (MIT)

These files are not committed; the page loads them from this folder so nothing is fetched from a CDN at runtime.
