import { DEFAULT_SECTIONS, sectionAt } from './chart';

/**
 * 程序合成 BGM —— 免版权，节拍与谱面严格同源（共享 DEFAULT_SECTIONS 段落结构）。
 * 结构化编曲：intro（鼓点铺垫）→ verse（主歌 groove）→ chorus（副歌全开）→ outro。
 * 谱面按同一结构出砖，卡点天然对齐。
 */
export class BeatAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private timer: number | null = null;
  private nextNoteTime = 0;
  private step = 0; // 八分音符步进
  private bpm = 120;
  private started = false;
  private backing: AudioBuffer | null = null;
  private backingSrc: AudioBufferSourceNode | null = null;

  /** 歌曲起点对应的 AudioContext 时间 */
  songStart = 0;

  /** 设置自定义音乐（设置后合成 BGM 自动静音，仅保留判定音效） */
  loadBacking(buffer: AudioBuffer): void {
    this.backing = buffer;
  }

  clearBacking(): void {
    this.backing = null;
  }

  /** 解码音频文件 */
  async decode(data: ArrayBuffer): Promise<AudioBuffer> {
    if (!this.ctx) await this.init();
    return this.ctx!.decodeAudioData(data);
  }

  /** 自定义音乐时长（秒），无则 0 */
  get musicDuration(): number {
    return this.backing ? this.backing.duration : 0;
  }

  async init(): Promise<void> {
    if (this.ctx) return;
    type WindowWithWebkit = Window & { webkitAudioContext?: typeof AudioContext };
    const Ctor = window.AudioContext ?? (window as WindowWithWebkit).webkitAudioContext;
    if (!Ctor) throw new Error('AudioContext 不可用');
    this.ctx = new Ctor();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.55;
    this.master.connect(this.ctx.destination);
  }

  get now(): number {
    return this.ctx ? this.ctx.currentTime : 0;
  }

  get playing(): boolean {
    return this.started;
  }

  /** 开始播放；startDelay 秒后正式进入第 0 拍 */
  start(bpm: number, startDelay = 0.35): void {
    if (!this.ctx || !this.master) throw new Error('请先 init()');
    this.bpm = bpm;
    this.stop();
    this.started = true;
    this.songStart = this.ctx.currentTime + startDelay;
    this.nextNoteTime = this.songStart;
    this.step = 0;
    if (this.backing) {
      const src = this.ctx.createBufferSource();
      src.buffer = this.backing;
      src.connect(this.master);
      src.start(this.songStart);
      this.backingSrc = src;
    } else {
      this.timer = window.setInterval(() => this.scheduler(), 25);
      this.scheduler();
    }
  }

  stop(): void {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
    try {
      this.backingSrc?.stop();
    } catch {
      /* 已停止 */
    }
    this.backingSrc = null;
    this.started = false;
  }

  /** 判定命中音效（三档音高，自定义音乐下提供打击反馈） */
  hit(quality: 'perfect' | 'great' | 'good'): void {
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime;
    const tone = quality === 'perfect' ? [660, 990] : quality === 'great' ? [590, 880] : [520, 720];
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(tone[0], t);
    osc.frequency.exponentialRampToValueAtTime(tone[1], t + 0.07);
    g.gain.setValueAtTime(0.24, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + 0.18);
  }

  /** 金砖命中音效（上行双音） */
  goldHit(): void {
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime;
    for (const [f, d] of [[880, 0], [1320, 0.07]] as Array<[number, number]>) {
      const osc = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t + d);
      g.gain.exponentialRampToValueAtTime(0.22, t + d + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + d + 0.22);
      osc.connect(g).connect(this.master);
      osc.start(t + d);
      osc.stop(t + d + 0.24);
    }
  }

  /** 倒计时提示音（滴—滴—滴—嘟！） */
  beep(high = false): void {
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = high ? 1320 : 880;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(high ? 0.5 : 0.32, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + 0.2);
  }

  // ---------- 内部调度（段落化编曲） ----------
  private scheduler(): void {
    if (!this.ctx || this.backing) return; // 自定义音乐时不合成鼓组
    const lookahead = 0.12;
    while (this.nextNoteTime < this.ctx.currentTime + lookahead) {
      this.scheduleStep(this.step, this.nextNoteTime);
      this.nextNoteTime += 60 / this.bpm / 2; // 八分音符
      this.step++;
    }
  }

  private scheduleStep(step: number, time: number): void {
    const beat = step / 2;
    const kind = sectionAt(DEFAULT_SECTIONS, beat).kind;
    const s8 = step % 8; // 一小节 8 个八分音符
    const bar = Math.floor(step / 8);

    // kick
    if (kind === 'chorus' && s8 % 2 === 0) this.kick(time, s8 === 0 ? 1 : 0.85);
    else if (kind === 'verse' && (s8 === 0 || s8 === 4)) this.kick(time, s8 === 0 ? 0.95 : 0.75);
    else if ((kind === 'intro' || kind === 'outro') && s8 === 0) this.kick(time, 0.8);

    // snare
    if ((kind === 'verse' || kind === 'chorus') && (s8 === 2 || s8 === 6)) {
      this.snare(time, kind === 'chorus' ? 0.26 : 0.2);
    }

    // hat
    if (kind !== 'break') {
      const open = kind === 'chorus' && s8 === 7;
      const vol = open ? 0.14 : kind === 'chorus' ? 0.09 : 0.06;
      if (s8 % 2 === 1 || kind === 'chorus') this.hat(time, vol);
    }

    // bass
    const bassSeq = [55, 55, 65.4, 55, 73.4, 55, 65.4, 49];
    if (kind === 'break') {
      if (s8 === 0) this.bass(time, bassSeq[bar % 8] ?? 55, 1.6);
    } else if (s8 % 2 === 0) {
      const root = bassSeq[Math.floor(step / 2) % bassSeq.length];
      this.bass(time, kind === 'chorus' && (s8 === 2 || s8 === 6) ? root * 2 : root, 0.3);
    }

    // chorus 主旋律 arp（能量感）
    if (kind === 'chorus' && s8 % 2 === 1) {
      const arp = [220, 261.6, 329.6, 392, 329.6, 261.6];
      this.lead(time, arp[step % arp.length]);
    }
  }

  private kick(t: number, vol: number): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.frequency.setValueAtTime(150, t);
    osc.frequency.exponentialRampToValueAtTime(42, t + 0.11);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
    osc.connect(g).connect(this.master!);
    osc.start(t);
    osc.stop(t + 0.18);
  }

  private snare(t: number, vol = 0.22): void {
    const ctx = this.ctx!;
    const buf = ctx.createBuffer(1, ctx.sampleRate * 0.12, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const filter = ctx.createBiquadFilter();
    filter.type = 'highpass';
    filter.frequency.value = 1400;
    const g = ctx.createGain();
    g.gain.value = vol;
    src.connect(filter).connect(g).connect(this.master!);
    src.start(t);
  }

  private hat(t: number, vol: number): void {
    const ctx = this.ctx!;
    const buf = ctx.createBuffer(1, ctx.sampleRate * 0.05, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const filter = ctx.createBiquadFilter();
    filter.type = 'highpass';
    filter.frequency.value = 6500;
    const g = ctx.createGain();
    g.gain.value = vol;
    src.connect(filter).connect(g).connect(this.master!);
    src.start(t);
  }

  private bass(t: number, freq: number, dur = 0.28): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.value = freq;
    g.gain.setValueAtTime(0.16, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(this.master!);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  private lead(t: number, freq: number): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'square';
    osc.frequency.value = freq;
    g.gain.setValueAtTime(0.045, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
    osc.connect(g).connect(this.master!);
    osc.start(t);
    osc.stop(t + 0.16);
  }
}
