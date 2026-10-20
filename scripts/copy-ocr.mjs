import { copyFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "public", "ocr");
await mkdir(out, { recursive: true });

const files = [
  [
    "node_modules/tesseract.js/dist/worker.min.js",
    "worker.min.js",
  ],
  [
    "node_modules/tesseract.js-core/tesseract-core-simd-lstm.wasm.js",
    "tesseract-core-simd-lstm.wasm.js",
  ],
];

for (const [from, name] of files) {
  await copyFile(path.join(root, from), path.join(out, name));
}

const trained = path.join(out, "eng.traineddata.gz");
let needsDownload = true;
try {
  const info = await stat(trained);
  needsDownload = info.size < 100_000;
} catch {
  needsDownload = true;
}

if (needsDownload) {
  const url = "https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng/4.0.0/eng.traineddata.gz";
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Could not download the English scanner data (${response.status}).`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const { writeFile } = await import("node:fs/promises");
  await writeFile(trained, bytes);
  console.log(`Saved scanner data (${bytes.length} bytes).`);
} else {
  console.log("Scanner data already present.");
}
