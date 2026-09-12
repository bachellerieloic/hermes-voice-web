// Copies the browser VAD runtime (Silero via @ricky0123/vad-web + onnxruntime-web) into public/vad/.
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..');
const target = join(projectRoot, 'public', 'vad');
const require = createRequire(import.meta.url);

const VAD_FILES = ['bundle.min.js', 'vad.worklet.bundle.min.js', 'silero_vad_v5.onnx', 'silero_vad_legacy.onnx', 'bundle.min.js.LICENSE.txt'];
const ORT_FILES = ['ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm'];

function locateVad() {
  try {
    return dirname(require.resolve('@ricky0123/vad-web/package.json'));
  } catch {
    return null;
  }
}

// onnxruntime-web hides package.json behind "exports", so look for its dist folder directly.
function locateOrt(vadRoot) {
  const candidates = [
    join(vadRoot, 'node_modules', 'onnxruntime-web'),
    resolve(vadRoot, '..', '..', 'onnxruntime-web'),
    join(projectRoot, 'node_modules', 'onnxruntime-web'),
  ];
  return candidates.find((dir) => existsSync(join(dir, 'dist', ORT_FILES[1]))) ?? null;
}

const vadRoot = locateVad();
if (!vadRoot) {
  console.warn('[vendor-vad] @ricky0123/vad-web is not installed; skipping (run npm install first)');
  process.exit(0);
}
const ortRoot = locateOrt(vadRoot);
if (!ortRoot) {
  console.warn('[vendor-vad] onnxruntime-web dist not found; skipping');
  process.exit(0);
}

mkdirSync(target, { recursive: true });
const copies = [
  ...VAD_FILES.map((f) => [join(vadRoot, 'dist', f), join(target, f)]),
  ...ORT_FILES.map((f) => [join(ortRoot, 'dist', f), join(target, f)]),
];
const copied = copies.filter(([from, to]) => {
  if (!existsSync(from)) {
    console.warn(`[vendor-vad] missing ${from}`);
    return false;
  }
  copyFileSync(from, to);
  return true;
});
console.log(`[vendor-vad] copied ${copied.length} files to public/vad/`);
