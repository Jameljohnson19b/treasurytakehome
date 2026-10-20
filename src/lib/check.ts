import { prepareFile } from "./image";
import { recognizeCanvas, signalsFrom } from "./ocr";
import type { LabelApplication, VerificationResult } from "./types";
import { verifyDocument } from "./verifier";

export async function checkLabel(
  file: Blob,
  application: LabelApplication,
  filename: string,
): Promise<VerificationResult> {
  const started = performance.now();
  const canvas = await prepareFile(file);
  const document = await recognizeCanvas(canvas);
  const elapsed = Math.round(performance.now() - started);
  return verifyDocument(document, application, {
    filename,
    elapsedMs: elapsed,
    signals: signalsFrom(document),
  });
}
