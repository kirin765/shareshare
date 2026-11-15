export interface Logger {
  info(event: string, fields?: Record<string, string | number | boolean>): void;
  warn(event: string, fields?: Record<string, string | number | boolean>): void;
  error(event: string, fields?: Record<string, string | number | boolean>): void;
}

export interface SignalingConfig {
  host: string;
  port: number;
  allowedOrigins: string[];
  allowMissingOrigin: boolean;
  trustProxy: boolean;
  roomTtlMs: number;
  reconnectGraceMs: number;
  heartbeatTimeoutMs: number;
  maxMessageBytes: number;
  maxRooms: number;
  maxMessagesPerMinute: number;
  maxAttachAttemptsPerMinute: number;
  sweepIntervalMs: number;
  stunUrls: string[];
  turnUrls: string[];
  turnSecret: string;
  turnTtlSeconds: number;
  turnRealm: string;
  now: () => number;
  logger: Logger;
}

function intEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!/^[0-9]+$/.test(raw)) throw new Error(`${name} must be a positive integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be between ${min} and ${max}`);
  }
  return value;
}

function boolEnv(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  throw new Error(`${name} must be true or false`);
}

function listEnv(env: NodeJS.ProcessEnv, name: string, fallback: string[]): string[] {
  const raw = env[name];
  if (raw === undefined) return fallback;
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

export const consoleLogger: Logger = {
  info: (event, fields) => console.log(`[signaling] ${event}`, fields ?? ""),
  warn: (event, fields) => console.warn(`[signaling] ${event}`, fields ?? ""),
  error: (event, fields) => console.error(`[signaling] ${event}`, fields ?? ""),
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): SignalingConfig {
  const turnUrls = listEnv(env, "TURN_URLS", []);
  const turnSecret = env.TURN_SECRET ?? "";
  if (turnUrls.length > 0 && turnSecret.length < 16) {
    throw new Error("TURN_SECRET must be set (16+ chars) when TURN_URLS is configured");
  }
  return {
    host: env.HOST ?? "0.0.0.0",
    port: intEnv(env, "PORT", 8787, 0, 65535),
    allowedOrigins: listEnv(env, "ALLOWED_ORIGINS", [
      "http://localhost:5173",
      "http://127.0.0.1:5173",
    ]),
    allowMissingOrigin: boolEnv(env, "ALLOW_MISSING_ORIGIN", false),
    trustProxy: boolEnv(env, "TRUST_PROXY", false),
    roomTtlMs: intEnv(env, "ROOM_TTL_MS", 15 * 60 * 1000, 1_000, 24 * 60 * 60 * 1000),
    reconnectGraceMs: intEnv(env, "RECONNECT_GRACE_MS", 2 * 60 * 1000, 0, 10 * 60 * 1000),
    heartbeatTimeoutMs: intEnv(env, "HEARTBEAT_TIMEOUT_MS", 60 * 1000, 5_000, 10 * 60 * 1000),
    maxMessageBytes: intEnv(env, "MAX_MESSAGE_BYTES", 64 * 1024, 1024, 1024 * 1024),
    maxRooms: intEnv(env, "MAX_ROOMS", 1000, 1, 100_000),
    maxMessagesPerMinute: intEnv(env, "MAX_MESSAGES_PER_MINUTE", 600, 10, 100_000),
    maxAttachAttemptsPerMinute: intEnv(
      env,
      "MAX_ATTACH_ATTEMPTS_PER_MINUTE",
      30,
      1,
      10_000,
    ),
    sweepIntervalMs: intEnv(env, "SWEEP_INTERVAL_MS", 30_000, 50, 10 * 60 * 1000),
    stunUrls: listEnv(env, "STUN_URLS", ["stun:stun.l.google.com:19302"]),
    turnUrls,
    turnSecret,
    turnTtlSeconds: intEnv(env, "TURN_TTL_SECONDS", 600, 60, 86_400),
    turnRealm: env.TURN_REALM ?? "shareshare",
    now: () => Date.now(),
    logger: consoleLogger,
  };
}
