export function formatBytes(value: bigint | number): string {
  const bytes = typeof value === "bigint" ? Number(value) : value;
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const scaled = bytes / 1024 ** exponent;
  const digits = exponent === 0 ? 0 : scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2;
  return `${scaled.toFixed(digits)} ${units[exponent]}`;
}

export function formatPercent(done: bigint, total: bigint): number {
  if (total <= 0n) return 100;
  if (done >= total) return 100;
  return Math.min(100, Math.max(0, Number((done * 1000n) / total) / 10));
}

export function formatSpeed(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return "—";
  return `${formatBytes(bytesPerSecond)}/s`;
}

export function formatEta(etaMs: number | null): string {
  if (etaMs === null || !Number.isFinite(etaMs) || etaMs < 0) return "추정 중";
  const seconds = Math.round(etaMs / 1000);
  if (seconds < 1) return "1초 미만";
  if (seconds < 60) return `약 ${seconds}초`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return `약 ${minutes}분 ${rest}초`;
  const hours = Math.floor(minutes / 60);
  return `약 ${hours}시간 ${minutes % 60}분`;
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}초`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return `${minutes}분 ${rest}초`;
  return `${Math.floor(minutes / 60)}시간 ${minutes % 60}분`;
}

export function sanitizeFileName(name: string): string {
  const cleaned = name
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[/\\]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
  return cleaned.length > 0 ? cleaned : "shareshare-download.bin";
}

export function shortHash(hash: string): string {
  return hash.length > 20 ? `${hash.slice(0, 12)}…${hash.slice(-8)}` : hash;
}

export function randomTransferId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function signalingUrl(): string {
  const configured = import.meta.env.VITE_SIGNALING_URL as string | undefined;
  if (configured) return configured;
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/ws`;
}

export interface SupportReport {
  secureContext: boolean;
  webrtc: boolean;
  dataChannel: boolean;
  savePicker: boolean;
  writableStream: boolean;
  chromelike: boolean;
}

export function detectSupport(): SupportReport {
  const chromelike = /Chrome\/|Edg\//.test(navigator.userAgent);
  return {
    secureContext: window.isSecureContext,
    webrtc: typeof RTCPeerConnection !== "undefined",
    dataChannel: typeof RTCDataChannel !== "undefined",
    savePicker: typeof window.showSaveFilePicker === "function",
    writableStream: typeof FileSystemFileHandle !== "undefined" &&
      typeof FileSystemFileHandle.prototype.createWritable === "function",
    chromelike,
  };
}
