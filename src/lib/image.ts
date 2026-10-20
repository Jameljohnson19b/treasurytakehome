import { MAX_FILE_BYTES } from "./constants";

const IMAGE_NAME = /\.(png|jpe?g|webp|gif|bmp|tif|tiff)$/i;

export function isImageFile(file: File): boolean {
  if (file.type.startsWith("image/")) return true;
  return IMAGE_NAME.test(file.name);
}

export async function prepareFile(file: Blob): Promise<HTMLCanvasElement> {
  if (file.size > MAX_FILE_BYTES) {
    throw new Error("This image is larger than 8 MB. Export a smaller JPG or PNG.");
  }
  if (file.type && !file.type.startsWith("image/")) {
    throw new Error("This file doesn't look like an image. Use a JPG or PNG photo.");
  }
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error("This file doesn't look like an image. Use a JPG or PNG photo.");
  }
  try {
    return prepareBitmap(bitmap);
  } finally {
    bitmap.close();
  }
}

function prepareBitmap(bitmap: ImageBitmap): HTMLCanvasElement {
  const scale = Math.min(1, 1400 / bitmap.width, 1800 / bitmap.height);
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("This browser could not open the picture.");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  context.drawImage(bitmap, 0, 0, width, height);
  const angle = estimateSkew(canvas);
  const straightened = angle === 0 ? canvas : rotateCanvas(canvas, angle);
  enhance(straightened);
  return straightened;
}

function estimateSkew(canvas: HTMLCanvasElement): number {
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return 0;
  const width = 320;
  const height = Math.max(1, Math.round((canvas.height / canvas.width) * width));
  const small = document.createElement("canvas");
  small.width = width;
  small.height = height;
  const smallContext = small.getContext("2d", { willReadFrequently: true });
  if (!smallContext) return 0;
  smallContext.drawImage(canvas, 0, 0, width, height);
  const pixels = smallContext.getImageData(0, 0, width, height).data;
  const gray = new Uint8Array(width * height);
  for (let index = 0; index < gray.length; index += 1) {
    gray[index] = pixels[index * 4] * 0.299 + pixels[index * 4 + 1] * 0.587 + pixels[index * 4 + 2] * 0.114;
  }
  const upright = projectionScore(gray, width, height, 0);
  let bestAngle = 0;
  let bestScore = upright;
  for (let angle = -12; angle <= 12; angle += 1) {
    if (angle === 0) continue;
    const score = projectionScore(gray, width, height, angle);
    if (score > bestScore) {
      bestScore = score;
      bestAngle = angle;
    }
  }
  if (bestAngle === 0 || bestScore < upright * 1.08) return 0;
  return bestAngle;
}

function projectionScore(gray: Uint8Array, width: number, height: number, angle: number): number {
  const radians = (angle * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const centerX = width / 2;
  const centerY = height / 2;
  const rows = new Float64Array(height);
  for (let y = 0; y < height; y += 2) {
    for (let x = 0; x < width; x += 2) {
      if (gray[y * width + x] > 165) continue;
      const row = Math.round(
        sin * (x - centerX) + cos * (y - centerY) + centerY,
      );
      if (row >= 0 && row < height) rows[row] += 1;
    }
  }
  let total = 0;
  for (let index = 0; index < height; index += 1) total += rows[index];
  const mean = total / height;
  let variance = 0;
  for (let index = 0; index < height; index += 1) {
    const delta = rows[index] - mean;
    variance += delta * delta;
  }
  return variance;
}

function rotateCanvas(source: HTMLCanvasElement, angle: number): HTMLCanvasElement {
  const radians = (angle * Math.PI) / 180;
  const sin = Math.abs(Math.sin(radians));
  const cos = Math.abs(Math.cos(radians));
  const width = Math.ceil(source.width * cos + source.height * sin);
  const height = Math.ceil(source.width * sin + source.height * cos);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) return source;
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  context.translate(width / 2, height / 2);
  context.rotate(radians);
  context.drawImage(source, -source.width / 2, -source.height / 2);
  return canvas;
}

function enhance(canvas: HTMLCanvasElement): void {
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return;
  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  const { data } = image;
  const gray = new Uint8Array(data.length / 4);
  const histogram = new Uint32Array(256);
  for (let index = 0; index < gray.length; index += 1) {
    const value = Math.round(
      data[index * 4] * 0.299 + data[index * 4 + 1] * 0.587 + data[index * 4 + 2] * 0.114,
    );
    gray[index] = value;
    histogram[value] += 1;
  }
  const total = gray.length;
  let low = 0;
  let high = 255;
  let seen = 0;
  for (let value = 0; value < 256; value += 1) {
    seen += histogram[value];
    if (seen / total >= 0.02) {
      low = value;
      break;
    }
  }
  seen = 0;
  for (let value = 255; value >= 0; value -= 1) {
    seen += histogram[value];
    if (seen / total >= 0.02) {
      high = value;
      break;
    }
  }
  if (high <= low + 12) {
    low = 0;
    high = 255;
  }
  const scale = 255 / Math.max(1, high - low);
  for (let index = 0; index < gray.length; index += 1) {
    const value = Math.max(0, Math.min(255, Math.round((gray[index] - low) * scale)));
    data[index * 4] = value;
    data[index * 4 + 1] = value;
    data[index * 4 + 2] = value;
    data[index * 4 + 3] = 255;
  }
  context.putImageData(image, 0, 0);
}
