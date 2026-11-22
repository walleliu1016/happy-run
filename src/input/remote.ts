import Peer, { type DataConnection } from 'peerjs';
import type { GameAction } from '../types';

const PREFIX = 'warmingup-run-';

/** 国内可达的 STUN 优先（Google STUN 在境内常不可达），同局域网时 LAN 候选即可直连 */
const RTC_CONFIG: RTCConfiguration = {
  iceServers: [
    { urls: ['stun:stun.miwifi.com:3478', 'stun:stun.l.google.com:19302'] },
  ],
};

const PAIR_TIMEOUT_MS = 15000;

export interface RemoteMessage {
  type: 'hello' | 'action';
  action?: GameAction;
  at?: number;
}

export interface PairingStatus {
  connected: boolean;
  detail: string;
}

/**
 * 双端配对：电视端建房（peer id = PREFIX + code），手机端加入并推送动作事件。
 * 走 PeerJS 公共信令 + WebRTC 数据通道；同一 WiFi 下延迟约 20-80ms。
 */
export class Pairing {
  private peer: Peer | null = null;
  private conn: DataConnection | null = null;
  private watchdog = 0;

  constructor(private onStatus: (s: PairingStatus) => void, private onAction: (a: GameAction, at: number) => void) {}

  /** 电视端：开房 */
  host(code: string): void {
    this.teardown();
    const peer = new Peer(PREFIX + code, { debug: 0, config: RTC_CONFIG });
    this.peer = peer;
    peer.on('open', () => {
      console.log('[pairing] host open', code);
      this.onStatus({ connected: false, detail: '等待手机连接…' });
      this.armWatchdog('连接超时：请确认手机和电视在同一 WiFi（也可改用本机摄像头）');
    });
    peer.on('connection', (conn) => {
      console.log('[pairing] host incoming connection');
      this.conn = conn;
      conn.on('open', () => {
        window.clearTimeout(this.watchdog);
        this.onStatus({ connected: true, detail: '手机已连接 ✓' });
      });
      conn.on('data', (raw) => this.handleData(raw));
      conn.on('close', () => this.onStatus({ connected: false, detail: '手机断开了，等待重连…' }));
    });
    peer.on('error', (err) => { console.log('[pairing] host error', err.type, err.message); this.onStatus({ connected: false, detail: `配对异常：${err.message}` }); });
    peer.on('disconnected', () => console.log('[pairing] host disconnected from signaling'));
  }

  /** 手机端：加入房间 */
  join(code: string): void {
    this.teardown();
    const peer = new Peer({ debug: 0, config: RTC_CONFIG });
    this.peer = peer;
    peer.on('open', () => {
      console.log('[pairing] sensor peer open');
      const conn = peer.connect(PREFIX + code, { reliable: true });
      this.conn = conn;
      this.armWatchdog('连接超时：请确认手机和电视在同一 WiFi');
      conn.on('open', () => {
        console.log('[pairing] sensor conn open');
        window.clearTimeout(this.watchdog);
        this.onStatus({ connected: true, detail: '已连接电视 ✓' });
        conn.send({ type: 'hello' } satisfies RemoteMessage);
      });
      conn.on('data', (raw) => this.handleData(raw));
      conn.on('close', () => this.onStatus({ connected: false, detail: '与电视断开' }));
      conn.on('error', (err) => console.log('[pairing] sensor conn error', err));
    });
    peer.on('error', (err) => { console.log('[pairing] sensor error', err.type, err.message); this.onStatus({ connected: false, detail: `连接失败：${err.message}` }); });
    peer.on('disconnected', () => console.log('[pairing] sensor disconnected from signaling'));
  }

  private armWatchdog(message: string): void {
    window.clearTimeout(this.watchdog);
    this.watchdog = window.setTimeout(() => {
      if (!this.isConnected) this.onStatus({ connected: false, detail: message });
    }, PAIR_TIMEOUT_MS);
  }

  /** 手机端：发送动作 */
  sendAction(action: GameAction, at: number): void {
    if (this.conn?.open) {
      this.conn.send({ type: 'action', action, at } satisfies RemoteMessage);
    }
  }

  get isConnected(): boolean {
    return this.conn?.open === true;
  }

  teardown(): void {
    window.clearTimeout(this.watchdog);
    this.conn?.close();
    this.peer?.destroy();
    this.conn = null;
    this.peer = null;
  }

  private handleData(raw: unknown): void {
    const msg = raw as RemoteMessage;
    if (msg && msg.type === 'action' && msg.action) {
      // 手机侧时间戳不可直接对齐电视时钟，以到达时间为准（局域网延迟可接受）
      this.onAction(msg.action, performance.now() / 1000);
    }
  }
}

export function randomCode(): string {
  return Math.random().toString(36).slice(2, 6).toUpperCase();
}
