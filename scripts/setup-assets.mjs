// 拷贝 MediaPipe WASM 运行时到 public/，并下载姿态模型（离线可用）
import { cpSync, mkdirSync, existsSync, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const wasmSrc = join(root, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm');
const wasmDst = join(root, 'public', 'wasm');
const modelDst = join(root, 'public', 'models', 'pose_landmarker_lite.task');
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';

mkdirSync(join(root, 'public', 'models'), { recursive: true });
if (existsSync(wasmSrc)) {
  cpSync(wasmSrc, wasmDst, { recursive: true });
  console.log('[assets] mediapipe wasm -> public/wasm');
}

if (!existsSync(modelDst)) {
  console.log('[assets] downloading pose landmarker model...');
  const res = await fetch(MODEL_URL);
  if (!res.ok) throw new Error(`model download failed: ${res.status}`);
  await pipeline(res.body, createWriteStream(modelDst));
  console.log('[assets] model saved ->', modelDst);
} else {
  console.log('[assets] model already present');
}
