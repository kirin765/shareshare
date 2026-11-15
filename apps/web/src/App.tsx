import { useState } from "react";
import { SenderApp } from "./SenderApp.js";
import { ReceiverApp } from "./ReceiverApp.js";

interface Invite {
  roomId: string;
  inviteToken: string;
  transferId: string;
}

interface ParsedLink {
  invite: Invite | null;
  invalid: boolean;
}

function parseInvite(): ParsedLink {
  const raw = window.location.hash.replace(/^#/, "");
  if (!raw) return { invite: null, invalid: false };
  const params = new URLSearchParams(raw);
  const roomId = params.get("r");
  const inviteToken = params.get("t");
  const transferId = params.get("x");
  if (!roomId || !inviteToken || !transferId) return { invite: null, invalid: true };
  return { invite: { roomId, inviteToken, transferId }, invalid: false };
}

export default function App() {
  const [parsed] = useState<ParsedLink>(parseInvite);
  const isReceiver = parsed.invite !== null || parsed.invalid;

  return (
    <div className="app">
      <header className="page-header">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          <div>
            <h1>ShareShare</h1>
            <p>파일 하나를 브라우저에서 브라우저로, 서버 보관 없이.</p>
          </div>
        </div>
        <div className="header-meta">
          <span className={`badge ${isReceiver ? "badge-ok" : "badge-muted"}`}>
            {isReceiver ? "수신 모드" : "송신 모드"}
          </span>
          <span className="badge badge-muted">프로토콜 v1</span>
        </div>
      </header>

      <main>{isReceiver ? <ReceiverApp invite={parsed.invite} invalid={parsed.invalid} /> : <SenderApp />}</main>

      <footer className="site-footer">
        <p>
          파일 본문과 파일 이름은 WebRTC DataChannel로만 이동합니다. 시그널링 서버는 방 정보,
          토큰 해시, 짧은 TURN 자격 증명만 메모리에 보관하며 파일 내용을 기록하지 않습니다.
        </p>
        <p>
          SHA-256 일치는 전송된 내용의 무결성 확인이며, 송신자의 신원을 증명하지는 않습니다.
          TURN을 쓰면 접속 IP와 트래픽 양은 중계 서버에서 관찰될 수 있습니다.
        </p>
      </footer>
    </div>
  );
}
