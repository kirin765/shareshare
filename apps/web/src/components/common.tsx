import { useState, type ReactNode } from "react";
import type { ConnectionPath } from "../lib/webrtc.js";
import {
  formatBytes,
  formatEta,
  formatPercent,
  formatSpeed,
} from "../lib/format.js";

export function Panel({
  title,
  subtitle,
  children,
  tone = "default",
}: {
  title?: string;
  subtitle?: string;
  children: ReactNode;
  tone?: "default" | "accent" | "danger";
}) {
  return (
    <section className={`panel panel-${tone}`}>
      {title ? (
        <header className="panel-head">
          <h2>{title}</h2>
          {subtitle ? <p>{subtitle}</p> : null}
        </header>
      ) : null}
      {children}
    </section>
  );
}

export function PathBadge({ path }: { path: ConnectionPath }) {
  if (!path) return <span className="badge badge-muted">경로 확인 중</span>;
  if (path === "relay") {
    return (
      <span className="badge badge-warn" title="TURN 서버를 통해 중계됩니다.">
        TURN 중계
      </span>
    );
  }
  return (
    <span className="badge badge-ok" title="피어 간 직접 연결입니다.">
      직접 연결
    </span>
  );
}

export function ConnectionCodePanel({ code }: { code: string }) {
  return (
    <Panel title="연결 확인 코드" tone="accent">
      <p className="muted">
        수신자 화면과 아래 6자리 코드가 같은지 확인하세요. 다르면 승인하지 마세요.
      </p>
      <div className="code" aria-label={`연결 확인 코드 ${code.split("").join(" ")}`}>
        {code}
      </div>
    </Panel>
  );
}

export function InvitePanel({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };
  return (
    <Panel title="수신자 초대 링크" subtitle="초대 토큰은 링크의 # 뒤에만 들어갑니다.">
      <div className="copy-row">
        <input
          className="invite-input"
          value={url}
          readOnly
          aria-label="수신자 초대 링크"
          onFocus={(event) => event.currentTarget.select()}
        />
        <button type="button" className="button" onClick={() => void copy()}>
          {copied ? "복사됨" : "링크 복사"}
        </button>
      </div>
      <p className="hint">
        링크를 메신저로 보내세요. 이 링크를 가진 사람은 누구나 수신자로 입장을 요청할 수
        있으므로, 승인 전에 상대를 확인하세요.
      </p>
    </Panel>
  );
}

export function ProgressPanel({
  done,
  total,
  confirmed,
  bytesPerSecond,
  etaMs,
  path,
  mode,
  reconnecting,
}: {
  done: bigint;
  total: bigint;
  confirmed?: bigint;
  bytesPerSecond: number;
  etaMs: number | null;
  path: ConnectionPath;
  mode: "sender" | "receiver";
  reconnecting?: boolean;
}) {
  const percent = formatPercent(done, total);
  return (
    <Panel title={reconnecting ? "연결 복구 중" : "전송 중"}>
      <div className="progress-head">
        <div>
          <span className="progress-percent">{percent.toFixed(1)}%</span>
          <span className="muted">
            {" "}
            {formatBytes(done)} / {formatBytes(total)}
          </span>
        </div>
        <PathBadge path={path} />
      </div>
      <div
        className="progress-track"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(percent)}
        aria-label="파일 전송 진행률"
      >
        <div className="progress-fill" style={{ width: `${percent}%` }} />
      </div>
      <dl className="stats">
        <div>
          <dt>속도</dt>
          <dd>{formatSpeed(bytesPerSecond)}</dd>
        </div>
        <div>
          <dt>남은 시간(추정)</dt>
          <dd>{formatEta(etaMs)}</dd>
        </div>
        {mode === "sender" && confirmed !== undefined ? (
          <div>
            <dt>수신 저장 확인</dt>
            <dd>{formatBytes(confirmed)}</dd>
          </div>
        ) : null}
      </dl>
      {reconnecting ? (
        <p className="hint" role="status">
          연결이 끊겨도 페이지를 닫지 마세요. 확인된 위치부터 이어받기를 시도합니다.
        </p>
      ) : null}
    </Panel>
  );
}

export function SupportList({ items }: { items: Array<{ ok: boolean; label: string }> }) {
  return (
    <ul className="support-list">
      {items.map((item) => (
        <li key={item.label} className={item.ok ? "ok" : "missing"}>
          <span aria-hidden="true">{item.ok ? "✓" : "✕"}</span> {item.label}
        </li>
      ))}
    </ul>
  );
}

export function Callout({
  tone = "info",
  title,
  children,
}: {
  tone?: "info" | "warn" | "danger" | "ok";
  title?: string;
  children: ReactNode;
}) {
  return (
    <div className={`callout callout-${tone}`} role={tone === "danger" ? "alert" : undefined}>
      {title ? <strong>{title}</strong> : null}
      <div>{children}</div>
    </div>
  );
}

export function Spinner() {
  return <span className="spinner" aria-hidden="true" />;
}
