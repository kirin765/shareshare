import { useEffect, useRef, useState } from "react";
import type { SenderSession, SenderState } from "./lib/sender-session.js";
import { SenderSession as Session } from "./lib/sender-session.js";
import {
  Callout,
  ConnectionCodePanel,
  InvitePanel,
  Panel,
  ProgressPanel,
  Spinner,
  SupportList,
} from "./components/common.js";
import {
  detectSupport,
  formatBytes,
  formatDuration,
  signalingUrl,
} from "./lib/format.js";

export function SenderApp() {
  const support = detectSupport();
  const [state, setState] = useState<SenderState | null>(null);
  const [dragging, setDragging] = useState(false);
  const sessionRef = useRef<SenderSession | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    return () => {
      sessionRef.current?.close();
      sessionRef.current = null;
    };
  }, []);

  const startFile = (file: File) => {
    if (!support.webrtc || !support.dataChannel) return;
    sessionRef.current?.close();
    const session = new Session({
      url: signalingUrl(),
      file,
      onState: setState,
    });
    sessionRef.current = session;
    setState(session.state);
    void session.start();
  };

  const cancel = () => {
    if (!sessionRef.current) return;
    if (!window.confirm("전송을 취소할까요? 수신 측의 부분 파일은 남을 수 있습니다.")) return;
    sessionRef.current.cancel();
  };

  if (!support.secureContext) {
    return (
      <Panel title="보안 컨텍스트가 필요합니다" tone="danger">
        <p>
          이 앱은 HTTPS 또는 <code>localhost</code>에서만 동작합니다. 현재 주소는{" "}
          <code>{window.location.origin}</code>입니다.
        </p>
      </Panel>
    );
  }

  if (!support.webrtc || !support.dataChannel) {
    return (
      <Panel title="이 브라우저에서는 전송할 수 없습니다" tone="danger">
        <p>WebRTC DataChannel을 지원하는 데스크톱 Chrome 또는 Edge가 필요합니다.</p>
        <SupportList
          items={[
            { ok: support.webrtc, label: "RTCPeerConnection" },
            { ok: support.dataChannel, label: "RTCDataChannel" },
          ]}
        />
      </Panel>
    );
  }

  if (!state) {
    return (
      <div className="stack">
        <Panel title="파일 하나를 설치 없이 전송" subtitle="서버에는 파일 본문을 저장하지 않습니다.">
          <div
            className={`dropzone${dragging ? " dragging" : ""}`}
            onDragOver={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => {
              event.preventDefault();
              setDragging(false);
              const file = event.dataTransfer.files[0];
              if (file) startFile(file);
            }}
          >
            <p className="drop-title">보낼 파일을 선택하세요</p>
            <p className="muted">한 번에 파일 1개, 수신자 1명만 지원합니다.</p>
            <button type="button" className="button button-primary" onClick={() => inputRef.current?.click()}>
              파일 선택
            </button>
            <input
              ref={inputRef}
              type="file"
              className="visually-hidden"
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                if (file) startFile(file);
              }}
            />
          </div>
          <div className="grid-two">
            <div>
              <h3>이용 순서</h3>
              <ol className="steps">
                <li>파일을 선택하면 만료 시간이 있는 초대 링크가 만들어집니다.</li>
                <li>수신자가 입장하면 양쪽에 연결 확인 코드가 표시됩니다.</li>
                <li>코드가 같은지 확인하고 승인하면 전송이 시작됩니다.</li>
                <li>수신 측이 크기와 SHA-256을 확인한 뒤에만 완료로 표시됩니다.</li>
              </ol>
            </div>
            <div>
              <h3>지원 범위</h3>
              <SupportList
                items={[
                  { ok: support.secureContext, label: "보안 컨텍스트(HTTPS/localhost)" },
                  { ok: support.webrtc, label: "WebRTC" },
                  { ok: support.dataChannel, label: "DataChannel" },
                  { ok: support.chromelike, label: "Chromium 계열 브라우저(권장)" },
                ]}
              />
              <p className="hint">
                실제 지원 브라우저 버전은 수동 검증 전입니다. 10 GiB는 검증 목표이며 아직
                지원 보장이 아닙니다.
              </p>
            </div>
          </div>
        </Panel>
        <Callout tone="warn" title="알아두세요">
          송신·수신 페이지가 모두 열려 있어야 합니다. 탭 종료, 새로고침, 절전 후 복구는
          보장하지 않습니다.
        </Callout>
      </div>
    );
  }

  const fileMeta = (
    <div className="file-meta">
      <strong>{state.fileName}</strong>
      <span className="muted">{formatBytes(state.fileSize)}</span>
    </div>
  );

  if (state.phase === "starting" || state.phase === "creating") {
    return (
      <Panel title="방을 만드는 중" tone="accent">
        <div className="center">
          <Spinner />
          <p className="muted">시그널링 서버에 초대 링크를 요청하고 있습니다.</p>
        </div>
      </Panel>
    );
  }

  if (state.phase === "waiting" || state.phase === "awaiting-approval" || state.phase === "negotiating") {
    return (
      <div className="stack" aria-live="polite">
        {state.inviteUrl ? <InvitePanel url={state.inviteUrl} /> : null}
        {state.phase === "waiting" ? (
          <Panel title="수신자 입장을 기다리는 중">
            <div className="center">
              <Spinner />
              <p className="muted">{state.notice ?? "초대 링크를 전달하세요."}</p>
            </div>
            <div className="meta-row">{fileMeta}</div>
          </Panel>
        ) : null}
        {state.connectionCode && state.phase !== "waiting" ? (
          <ConnectionCodePanel code={state.connectionCode} />
        ) : null}
        {state.phase === "awaiting-approval" ? (
          <Panel title="수신자 승인">
            <p>{state.notice}</p>
            <div className="button-row">
              <button
                type="button"
                className="button button-primary"
                disabled={!state.canApprove}
                onClick={() => sessionRef.current?.approve()}
              >
                코드가 같습니다 — 승인
              </button>
              <button type="button" className="button" onClick={cancel}>
                거절하고 닫기
              </button>
            </div>
            <div className="meta-row">{fileMeta}</div>
          </Panel>
        ) : null}
        {state.phase === "negotiating" ? (
          <Panel title="보안 연결 설정 중">
            <div className="center">
              <Spinner />
              <p className="muted">{state.notice}</p>
            </div>
            <div className="meta-row">{fileMeta}</div>
          </Panel>
        ) : null}
        {state.path ? <p className="hint">연결 경로: {state.path === "relay" ? "TURN 중계" : "직접 연결"}</p> : null}
      </div>
    );
  }

  if (
    state.phase === "awaiting-accept" ||
    state.phase === "transferring" ||
    state.phase === "verifying" ||
    state.phase === "reconnecting"
  ) {
    return (
      <div className="stack" aria-live="polite">
        <Panel title="전송 세션">
          <div className="meta-row">
            {fileMeta}
            <span className="badge badge-muted">{state.connectionCode ?? "—"}</span>
          </div>
          <p className="muted">{state.notice}</p>
        </Panel>
        {state.phase === "awaiting-accept" ? (
          <Panel title="수신자 확인 대기">
            <div className="center">
              <Spinner />
              <p className="muted">수신자가 파일 정보와 저장 공간을 확인하고 있습니다.</p>
            </div>
          </Panel>
        ) : null}
        {state.phase === "verifying" ? (
          <Panel title="무결성 확인 중">
            <div className="center">
              <Spinner />
              <p className="muted">수신 측이 크기와 SHA-256을 검사하고 있습니다.</p>
            </div>
          </Panel>
        ) : null}
        {state.phase !== "awaiting-accept" ? (
          <ProgressPanel
            mode="sender"
            done={state.progress.done}
            confirmed={state.progress.confirmed}
            total={state.progress.total}
            bytesPerSecond={state.progress.bytesPerSecond}
            etaMs={state.progress.etaMs}
            path={state.path}
            reconnecting={state.phase === "reconnecting"}
          />
        ) : null}
        <div className="button-row">
          <button type="button" className="button button-danger" onClick={cancel}>
            전송 취소
          </button>
        </div>
      </div>
    );
  }

  if (state.phase === "completed") {
    return (
      <div className="stack" aria-live="polite">
        <Panel title="수신 확인 완료" tone="accent">
          <p className="large">
            수신 측이 파일 크기와 SHA-256을 확인하고 쓰기를 닫았습니다.
          </p>
          <p className="muted">
            운영체제나 디스크 수준의 영구 저장까지 보장하는 것은 아닙니다. 수신자가 저장한
            파일을 직접 확인하도록 안내하세요.
          </p>
          <dl className="stats">
            <div>
              <dt>파일</dt>
              <dd>{state.fileName}</dd>
            </div>
            <div>
              <dt>크기</dt>
              <dd>{formatBytes(state.fileSize)}</dd>
            </div>
            <div>
              <dt>소요</dt>
              <dd>
                {state.finishedAt && state.startedAt
                  ? formatDuration(state.finishedAt - state.startedAt)
                  : "—"}
              </dd>
            </div>
          </dl>
          <div className="hash-box">
            <span>SHA-256</span>
            <code>{state.sha256}</code>
          </div>
          <button type="button" className="button button-primary" onClick={() => window.location.reload()}>
            새 파일 보내기
          </button>
        </Panel>
      </div>
    );
  }

  return (
    <div className="stack" aria-live="assertive">
      <Panel title={state.phase === "cancelled" ? "전송 취소됨" : "전송 실패"} tone="danger">
        <p>{state.error?.message ?? state.notice ?? "전송을 완료하지 못했습니다."}</p>
        {state.error ? (
          <p className="hint">
            오류 코드: <code>{state.error.code}</code>
          </p>
        ) : null}
        {state.partialBytes !== null ? (
          <p className="hint">
            수신 측에서 확인된 바이트: {formatBytes(state.partialBytes)}. 브라우저에 따라
            부분 파일이 남을 수 있습니다.
          </p>
        ) : null}
        <div className="button-row">
          <button type="button" className="button button-primary" onClick={() => window.location.reload()}>
            다시 시작
          </button>
        </div>
      </Panel>
    </div>
  );
}
