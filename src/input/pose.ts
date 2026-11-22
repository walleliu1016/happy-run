import {
  FilesetResolver,
  PoseLandmarker,
  type NormalizedLandmark,
} from '@mediapipe/tasks-vision';

export type PoseFrameHandler = (landmarks: NormalizedLandmark[] | null, fps: number, numPoses?: number) => void;

/**
 * MediaPipe PoseLandmarker 封装。
 * WASM 运行时与模型均走本地资源（离线可用）。
 */
export class PoseInput {
  private landmarker: PoseLandmarker | null = null;
  private raf = 0;
  private lastVideoTime = -1;
  private fpsSamples: number[] = [];
  private lastTs = 0;

  private constructor(private video: HTMLVideoElement, private onFrame: PoseFrameHandler) {}

  static async create(video: HTMLVideoElement, onFrame: PoseFrameHandler): Promise<PoseInput> {
    // public/ 资产相对页面根路径解析（dev 与部署同构）
    const base = new URL('wasm/', document.baseURI).href;
    const model = new URL('models/pose_landmarker_lite.task', document.baseURI).href;
    const fileset = await FilesetResolver.forVisionTasks(base);
    // 电视浏览器 GPU 代理经常不可用，失败自动回退 CPU
    let landmarker: PoseLandmarker;
    try {
      landmarker = await PoseLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: model, delegate: 'GPU' },
        runningMode: 'VIDEO',
        numPoses: 2,
      });
    } catch {
      landmarker = await PoseLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: model, delegate: 'CPU' },
        runningMode: 'VIDEO',
        numPoses: 2,
      });
    }
    const input = new PoseInput(video, onFrame);
    input.landmarker = landmarker;
    return input;
  }

  /** 打开摄像头并开始识别循环 */
  async startCamera(constraints?: MediaStreamConstraints): Promise<void> {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
      audio: false,
      ...constraints,
    });
    this.video.srcObject = stream;
    await this.video.play();
    this.loop();
  }

  /** 外部已给 video 配好流时（双端/复用）直接跑循环 */
  startLoop(): void {
    this.loop();
  }

  stop(): void {
    cancelAnimationFrame(this.raf);
    const stream = this.video.srcObject as MediaStream | null;
    stream?.getTracks().forEach((t) => t.stop());
    this.video.srcObject = null;
    this.landmarker?.close();
    this.landmarker = null;
  }

  get avgFps(): number {
    if (this.fpsSamples.length === 0) return 0;
    return this.fpsSamples.reduce((a, b) => a + b, 0) / this.fpsSamples.length;
  }

  private loop = (): void => {
    this.raf = requestAnimationFrame(this.loop);
    const lm = this.landmarker;
    if (!lm || this.video.readyState < 2) return;
    if (this.video.currentTime === this.lastVideoTime) return;
    this.lastVideoTime = this.video.currentTime;

    const now = performance.now();
    if (this.lastTs > 0) {
      const fps = 1000 / (now - this.lastTs);
      if (fps < 200) {
        this.fpsSamples.push(fps);
        if (this.fpsSamples.length > 60) this.fpsSamples.shift();
      }
    }
    this.lastTs = now;

    const result = lm.detectForVideo(this.video, now);
    this.onFrame(result.landmarks[0] ?? null, this.avgFps, result.landmarks.length);
  };
}

/** 计算两点像素归一化距离 */
export function dist(a: NormalizedLandmark, b: NormalizedLandmark): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
