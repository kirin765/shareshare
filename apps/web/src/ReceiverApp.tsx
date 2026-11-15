import { useEffect, useRef, useState } from "react";
import type { ReceiverSession, ReceiverState } from "./lib/receiver-session.js";
import { ReceiverSession as Session } from "./lib/receiver-session.js";
import {
  Callout,
  ConnectionCodePanel,
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

interface Invite {
  roomId: string;
  inviteToken: string;
  transferId: string;
}

export function ReceiverApp({ invite, invalid }: { invite: Invite | null; invalid: boolean }) {
  const support = detectSupport();
  const [state, setState] = useState<ReceiverState | null>(null);
  const sessionRef = useRef<ReceiverSession | null>(null);

  useEffect(() => {
    if (!invite) return;
    const session = new Session({
      url: signalingUrl(),
      roomId: invite.roomId,
      inviteToken: invite.inviteToken,
      transferId: invite.transferId,
      onState: setState,
    });
    sessionRef.current = session;
    setState(session.state);
    void session.start();
    return () => {
      session.close();
      sessionRef.current = null;
    };
  }, [invite]);

  if (invalid) {
    return (
      <Panel title="초대 링크가 올바르지 않습니다" tone="danger">
        <p>링크에 방 ID, 초대 토큰, 전송 ID가 모두 포함되어야 합니다.</p>
        <p className="hint">송신자에게 새 초대 링크를 요청하세요.</p>
      </Panel>
    );
  }

  if (!invite) {
    return (
      <Panel title="초대 링크가 필요합니다">
        <p>송신자가 보낸 초대 링크로 접속해야 파일을 받을 수 있습니다.</p>
      </Panel>
    );
  }

  if (!support.secureContext) {
    return (
      <Panel title="보안 컨텍스트가 필요합니다" tone="danger">
        <p>
          저장 위치 선택과 WebRTC는 HTTPS 또는 <code>localhost</code>에서만 동작합니다.
        </p>
      </Panel>
    );
  }

  if (!support.webrtc || !support.dataChannel || !support.savePicker || !support.writableStream) {
    return (
      <Panel title="이 브라우저에서는 받을 수 없습니다" tone="danger">
        <p>
          데스크톱 Chrome 또는 Edge에서 파일 쓰기 스트림(File System Access API)을 지원해야
          합니다. 모바일 브라우저와 Firefox/Safari는 지원 대상이 아닙니다.
        </p>
        <SupportList
          items={[
            { ok: support.webrtc, label: "RTCPeerConnection" },
            { ok: support.dataChannel, label: "RTCDataChannel" },
            { ok: support.savePicker, label: "저장 위치 선택 API" },
            { ok: support.writableStream, label: "파일 쓰기 스트림" },
          ]}
        />
      </Panel>
    );
  }

  if (!state) {
    return (
      <Panel title="초대 확인 중" tone="accent">
        <div className="center">
          <Spinner />
          <p className="muted">방과 초대 토큰을 확인하고 있습니다.</p>
        </div>
      </Panel>
    );
  }

  if (state.phase === "joining") {
    return (
      <Panel title="방에 입장하는 중" tone="accent">
        <div className="center">
          <Spinner />
          <p className="muted">초대 토큰을 확인하는 중입니다.</p>
        </div>
      </Panel>
    );
  }

  if (state.phase === "awaiting-approval") {
    return (
      <div className="stack" aria-live="polite">
        {state.connectionCode ? <ConnectionCodePanel code={state.connectionCode} /> : null}
        <Panel title="송신자 승인 대기">
          <div className="center">
            <Spinner />
            <p className="muted">{state.notice}</p>
          </div>
          <p className="hint">
            송신자가 화면의 코드를 확인하고 승인해야 연결이 시작됩니다. 코드가 다르면 송신자가
            승인하지 않아야 합니다.
          </p>
        </Panel>
        <button type="button" className="button" onClick={() => sessionRef.current?.cancel()}>
          입장 취소
        </button>
      </div>
    );
  }

  if (
    state.phase === "negotiating" ||
    state.phase === "awaiting-offer" ||
    state.phase === "offer" ||
    state.phase === "reconnecting"
  ) {
    return (
      <div className="stack" aria-live="polite">
        {state.connectionCode && state.phase !== "offer" ? (
          <p className="hint">
            연결 확인 코드 <code>{state.connectionCode}</code>
          </p>
        ) : null}
        {state.phase === "negotiating" || state.phase === "awaiting-offer" ? (
          <Panel title="연결 설정 중">
            <div className="center">
              <Spinner />
              <p className="muted">{state.notice}</p>
            </div>
          </Panel>
        ) : null}
        {state.phase === "offer" ? (
          <Panel title="받을 파일" tone="accent">
            <div className="file-meta">
              <strong>{state.fileName}</strong>
              <span className="muted">
                {state.fileSize !== null ? formatBytes(state.fileSize) : ""}
              </span>
            </div>
            <p className="hint">
              파일 이름과 MIME 형식은 송신자가 보낸 값이며 신뢰하지 않습니다. 저장 위치와
              파일 이름은 직접 확인하세요.
            </p>
            {state.fileSize !== null && state.fileSize > 10n * 1024n * 1024n * 1024n ? (
              <Callout tone="warn" title="큰 파일">
                10 GiB는 검증 목표이며 아직 지원 보장이 아닙니다. 디스크 여유 공간과 절전
                설정을 확인하세요.
              </Callout>
            ) : null}
            <div className="button-row">
              <button
                type="button"
                className="button button-primary"
                disabled={!state.canChooseDestination}
                onClick={() => sessionRef.current?.chooseDestination()}
              >
                저장 위치 선택하고 받기
              </button>
              <button type="button" className="button" onClick={() => sessionRef.current?.cancel()}>
                거절
              </button>
            </div>
            <p className="hint">{state.notice}</p>
            {state.path ? <p className="hint">연결 경로가 확인되면 표시됩니다.</p> : null}
          </Panel>
        ) : null}
        {state.phase === "reconnecting" ? (
          <>
            <Panel title="연결 복구 중" tone="accent">
              <div className="center">
                <Spinner />
                <p className="muted">{state.notice}</p>
              </div>
              <p className="hint">
                페이지를 닫지 마세요. 이미 저장한 위치부터 이어받기를 시도합니다.
              </p>
            </Panel>
            {state.progress.total > 0n ? (
              <ProgressPanel
                mode="receiver"
                done={state.progress.done}
                total={state.progress.total}
                bytesPerSecond={state.progress.bytesPerSecond}
                etaMs={state.progress.etaMs}
                path={state.path}
                reconnecting
              />
            ) : null}
            <button type="button" className="button" onClick={() => sessionRef.current?.cancel()}>
              전송 취소
            </button>
          </>
        ) : null}
      </div>
    );
  }

  if (state.phase === "transferring" || state.phase === "verifying") {
    return (
      <div className="stack" aria-live="polite">
        <Panel title="받는 중">
          <div className="meta-row">
            <div className="file-meta">
              <strong>{state.savedName ?? state.fileName}</strong>
              {state.fileSize !== null ? (
                <span className="muted">{formatBytes(state.fileSize)}</span>
              ) : null}
            </div>
            {state.path ? (
              <span className={`badge ${state.path === "relay" ? "badge-warn" : "badge-ok"}`}>
                {state.path === "relay" ? "TURN 중계" : "직접 연결"}
              </span>
            ) : null}
          </div>
          <p className="hint">
            브라우저가 저장 위치에 직접 씁니다. 탭을 닫거나 절전 모드로 들어가지 마세요.
          </p>
        </Panel>
        {state.phase === "verifying" ? (
          <Panel title="무결성 확인 중" tone="accent">
            <div className="center">
              <Spinner />
              <p className="muted">{state.notice}</p>
            </div>
          </Panel>
        ) : null}
        <ProgressPanel
          mode="receiver"
          done={state.progress.done}
          total={state.progress.total}
          bytesPerSecond={state.progress.bytesPerSecond}
          etaMs={state.progress.etaMs}
          path={state.path}
        />
        <div className="button-row">
          <button
            type="button"
            className="button button-danger"
            onClick={() => {
              if (window.confirm("전송을 취소할까요? 부분 파일이 남을 수 있습니다.")) {
                sessionRef.current?.cancel();
              }
            }}
          >
            전송 취소
          </button>
        </div>
      </div>
    );
  }

  if (state.phase === "completed") {
    return (
      <div className="stack" aria-live="polite">
        <Panel title="저장하고 검증했습니다" tone="accent">
          <p className="large">
            파일 크기와 SHA-256이 송신자가 보낸 값과 일치하고, 쓰기 스트림을 닫았습니다.
          </p>
          <p className="muted">
            운영체제나 디스크 수준의 영구 저장까지 보장하는 것은 아닙니다. 저장된 파일을 직접
            열어 확인하세요.
          </p>
          <dl className="stats">
            <div>
              <dt>저장한 이름</dt>
              <dd>{state.savedName ?? state.fileName}</dd>
            </div>
            <div>
              <dt>크기</dt>
              <dd>{state.fileSize !== null ? formatBytes(state.fileSize) : "—"}</dd>
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
            확인
          </button>
        </Panel>
      </div>
    );
  }

  return (
    <div className="stack" aria-live="assertive">
      <Panel title={state.phase === "cancelled" ? "전송 취소됨" : "전송 실패"} tone="danger">
        <p>{state.error?.message ?? state.notice ?? "파일을 받지 못했습니다."}</p>
        {state.error ? (
          <p className="hint">
            오류 코드: <code>{state.error.code}</code>
          </p>
        ) : null}
        {state.partialBytes !== null && state.partialBytes > 0n ? (
          <p className="hint">
            확인된 저장 바이트: {formatBytes(state.partialBytes)}. 브라우저에 따라 부분 파일이
            남을 수 있으므로 저장 폴더를 확인하세요.
          </p>
        ) : null}
        <div className="button-row">
          <button type="button" className="button button-primary" onClick={() => window.location.reload()}>
            새로고침
          </button>
        </div>
      </Panel>
    </div>
  );
}
