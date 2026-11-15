import { createHmac } from "node:crypto";
import type { IceServerConfig } from "@shareshare/protocol";

export interface TurnSettings {
  urls: string[];
  secret: string;
  ttlSeconds: number;
  realm: string;
}

/**
 * coturn REST API credential ("turn_static_auth_secret" / use-auth-secret).
 * The username embeds the expiry so coturn can reject stale credentials
 * without the signaling server keeping TURN state.
 */
export function createTurnCredential(
  settings: TurnSettings,
  nowMs: number,
): { username: string; credential: string } {
  const expiresAt = Math.floor(nowMs / 1000) + settings.ttlSeconds;
  const username = `${expiresAt}:${settings.realm}`;
  const credential = createHmac("sha1", settings.secret).update(username).digest("base64");
  return { username, credential };
}

export function buildIceServers(
  options: { stunUrls: string[]; turn: TurnSettings | null },
  nowMs: number,
): IceServerConfig[] {
  const servers: IceServerConfig[] = [];
  if (options.stunUrls.length > 0) {
    servers.push({ urls: options.stunUrls });
  }
  if (options.turn) {
    const { username, credential } = createTurnCredential(options.turn, nowMs);
    servers.push({
      urls: options.turn.urls,
      username,
      credential,
    });
  }
  return servers;
}
