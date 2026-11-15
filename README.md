# ShareShare

설치 없이 두 데스크톱 브라우저 사이에서 파일 하나를 WebRTC DataChannel로 전송하고,
수신 측이 저장한 결과의 크기와 SHA-256을 검증하는 기술 프로젝트입니다.

파일 본문은 시그널링 서버에 저장되지 않습니다. 연결 중단 시 확인된 위치부터 이어받기를
시도하고, 저장 실패·해시 불일치·상대 이탈을 완료로 표시하지 않습니다.

## 범위

- 송신자 1명, 수신자 1명, 파일 1개
- 양쪽 페이지가 열려 있는 동안만 동작
- 수신자는 사용자 동작으로 저장 위치를 선택하고, 브라우저가 파일 쓰기 스트림으로 저장
- 직접 연결 실패 시 TURN 중계 허용
- 10 GiB는 **검증 목표**이며 아직 지원 보장이 아닙니다.

제외: 폴더·다중 파일·다중 수신자·계정·클라우드 보관·모바일 보장·새로고침 후 복구·절전 복구.

## 구조

```text
apps/web/                React + Vite 화면, WebRTC/파일/Worker 어댑터, 세션 컨트롤러
apps/signaling/          Node WebSocket 시그널링, 방/토큰/레이트리밋, TURN 단기 자격
packages/protocol/       메시지 zod 스키마, 20바이트 바이너리 프레임, 버전/상한
packages/transfer/       전송 상태 머신, 청크/ACK/흐름 제어, 재개, SHA-256
infra/                   coturn, systemd, Caddy 예제
```

전송 코어는 `ChunkSource`, `ChunkSink`, `ControlTransport`, `Hasher`, `Clock`을 주입받습니다.
브라우저 구현과 테스트용 가짜 구현이 같은 코어를 사용합니다.

## 빠른 시작

요구 사항: Node.js 22+, pnpm 10+.

```bash
pnpm install
```

터미널 1:

```bash
pnpm dev:signaling
```

터미널 2:

```bash
pnpm dev:web
```

http://localhost:5173 을 데스크톱 Chrome/Edge로 엽니다. Vite가 `/ws`를
`ws://127.0.0.1:8787`로 프록시합니다.

TURN 없이도 같은 NAT/로컬 환경에서는 직접 연결을 시도합니다. 서로 다른 회선 테스트에는
아래 coturn 설정이 필요합니다.

## 테스트와 빌드

```bash
pnpm test        # protocol, transfer, signaling
pnpm typecheck
pnpm build       # signaling 번들 + web 정적 빌드
```

브라우저 E2E(선택): 시그널링 서버와 Vite 개발 서버를 띄운 뒤 실행합니다. 시스템
Chromium이 없으면 `CHROMIUM_PATH`를 지정하세요. 저장 위치 선택기는 자동화할 수 없어
페이지 안의 writable 스텁으로 대체하므로, OS 저장 권한·실제 피커 동작은 검증하지 않습니다.

```bash
pnpm dev:signaling   # 터미널 1
pnpm dev:web         # 터미널 2
pnpm test:e2e        # 터미널 3
```

E2E는 1 B·청크 경계·300 KiB 전송, DataChannel 강제 종료 후 이어받기,
RTCPeerConnection 종료 후 새 연결로 재개, 시그널링 WebSocket 재연결, `verified` 응답
1회 유실 후 `finish` 재시도까지 확인합니다. 개발 환경에서 Chromium 155 headless와
루프백 연결로 통과했습니다. 실제 GUI 피커, 권한 거절, NAT, 1 GiB/10 GiB는 별도 수동
검증이 필요합니다.

자동 테스트 범위:

- 프레임 파서: 버전/길이/플래그/오프셋/파일 크기 상한, 64비트 오프셋
- 메시지 스키마: 크기 문자열, 해시, 토큰, 상태
- 상태 머신: 허용/불가능 전이
- 전송: 0 B, 1 B, 청크 경계, 1 MiB+, 잘못된 프레임, 중복 프레임/ACK, ACK 유실,
  저장 실패, 취소, 해시 불일치, 미확인 바이트 상한
- 재개: 확인된 오프셋부터 재개, 원본 변경 시 해시 불일치
- 시그널링: 방 생성/입장/승인/릴레이, 토큰 분리, 정원, 만료, 재연결 유예,
  Origin 검증, 메시지 크기, 레이트리밋, TURN 자격 HMAC

브라우저 E2E, 실제 NAT, 5초/30초 단절, 1 GiB/10 GiB, 저장 권한 거절·디스크 부족은
자동 테스트로 대체하지 않습니다. 아래 수동 검증 표를 사용하세요.

## 브라우저 지원

구현은 Chromium 계열 데스크톱 API를 기준으로 합니다. 개발 환경의 **Chromium 155
headless**에서 아래 E2E를 통과했지만, 안정 채널 Chrome/Edge의 GUI·네이티브 저장
피커·실제 네트워크는 아직 수동 검증하지 않았습니다. 현재 화면은 다음 기능을 감지해
미지원 시 차단합니다.

- `RTCPeerConnection`, `RTCDataChannel` (송신·수신)
- `window.showSaveFilePicker` (수신)
- `FileSystemFileHandle.prototype.createWritable` (수신)
- 보안 컨텍스트(HTTPS 또는 localhost)

수동 검증 후 `apps/web/src/lib/format.ts`의 안내 문구와 이 문서에 실제 통과 버전을
기록해야 합니다. Firefox/Safari/모바일은 수신 저장 경로가 없으므로 지원 대상이 아닙니다.

## 데이터 경로와 신뢰 모델

1. 송신자가 파일을 고르면 서버가 방, 송신자 세션 자격, 초대 토큰, 6자리 연결 확인 코드를
   만듭니다.
2. 초대 토큰은 URL fragment(`#r=…&t=…&x=…`)로만 전달됩니다. fragment는 HTTP 요청과
   접근 로그에 전송되지 않습니다. 서버는 토큰 원문이 아니라 SHA-256 해시를 저장합니다.
3. 수신자가 입장하면 양쪽에 연결 확인 코드가 표시됩니다. 송신자만 코드를 확인해 승인할 수
   있습니다.
4. 승인 후 SDP/ICE만 WebSocket으로 중계합니다. 파일 이름·크기·바이트는 DataChannel로만
   이동합니다.
5. 수신자는 파일 쓰기를 마친 뒤 크기와 SHA-256을 검사하고, 일치할 때만 `verified`를
   보냅니다. 송신자는 이 응답 뒤에만 완료를 표시합니다.

WebRTC는 전송 구간을 암호화합니다. SHA-256 일치는 전송된 내용의 무결성 확인이며 송신자
신원 증명은 아닙니다. TURN 중계 시 접속 IP와 트래픽 양은 TURN 서버에서 관찰 가능하며,
IP 은닉은 목표가 아닙니다.

### 서버가 보관하는 것

- 메모리의 방 메타데이터, 토큰 해시, 승인 상태, 연결 확인 코드
- 익명 오류 코드와 활성 방 수 수준의 운영 로그 (SDP, 파일 이름, 토큰 원문은 기록하지 않음)
- 짧은 TTL의 TURN 자격 증명 (coturn 공유 비밀에서 HMAC으로 발급)

파일 본문, 파일 이름, SDP는 저장소에 쓰지 않습니다.

## 프로토콜 v1

### 바이너리 데이터 프레임

20바이트 빅엔디언 헤더:

| 오프셋 | 크기 | 필드 |
|---|---|---|
| 0 | 1 | protocolVersion (=1) |
| 1 | 1 | frameType (1 = DATA) |
| 2 | 2 | flags (0) |
| 4 | 4 | sequence (uint32) |
| 8 | 8 | offset (uint64) |
| 16 | 4 | payloadLength (uint32) |

- 기본 페이로드 16 KiB, 협상된 DataChannel 메시지 한도에서 헤더를 뺀 값으로 제한
- 수신자는 길이·오프셋·파일 크기 범위와 프레임 간 연속성을 검사
- 전송 계층은 ordered/reliable DataChannel이며, 패킷별 애플리케이션 재전송은 하지 않음

### 제어 메시지

모든 DataChannel 제어 메시지는 `protocolVersion`, `transferId`와 zod 런타임 검증을
갖습니다. 크기·오프셋은 JSON에서 10진 문자열로 표현합니다. 초기 파싱 실패처럼 전송 ID를
알 수 없는 서버 오류만 예외적으로 `transferId`를 생략합니다.

- `file-offer`, `accept`, `reject`, `ready`, `ack`, `finish`, `verified`, `cancel`,
  `resume-request`, `resume-ready`, `error`
- 시그널링: `create-room`, `join-room`, `resume-session`, `approve-peer`, `offer`,
  `answer`, `ice-candidate`, `heartbeat`, `leave-room`(명시적 취소/종료)

### 흐름 제어와 무결성

- 송신자는 `bufferedAmount` 상한과 미확인 바이트 상한을 모두 지킴
- 수신자는 쓰기를 직렬화하고, 디스크에 반영된 연속 오프셋만 ACK
- ACK 오프셋은 단조 증가하며, 중복/오래된 ACK는 무시
- 수신 해시에는 저장이 끝난 연속 바이트만 반영
- SHA-256은 `@noble/hashes`를 Web Worker에서 증분 실행
- 해시 불일치·쓰기 실패·크기 불일치 시 완료 표시를 하지 않고 쓰기 스트림을 abort 시도

### 재개

1. `disconnected`를 즉시 실패로 보지 않고 유예
2. ICE restart, 실패 시 새 PeerConnection
3. 같은 `transferId`와 승인된 세션 확인
4. 수신자가 마지막 연속 쓰기 완료 오프셋을 `resume-request`로 전달
5. 송신자는 그 위치까지 파일을 다시 읽어 해시 상태를 재구성한 뒤 `resume-ready`
6. 수신자는 같은 파일 스트림에 해당 위치부터 덮어쓰기
7. 유예 초과 시 실패 및 자원 정리

증분 SHA-256은 되감을 수 없으므로 송신자는 재개 시 접두 구간을 다시 해시합니다. 이는
"해시는 실제로 전송·저장된 연속 바이트만 반영한다"는 불변식을 지키기 위한 선택입니다.
원본이 바뀌면 최종 해시가 달라져 완료되지 않습니다.

## 시그널링 서버 운영

`apps/signaling`은 기본적으로 다음을 적용합니다.

- 방 유휴 만료 15분, 재연결 유예 2분, heartbeat 60초
- Origin 허용 목록 검증, 메시지 크기 제한, IP별 입장 시도 및 소켓별 메시지 레이트리밋
- 방 최대 개수 제한, 만료 방 메모리 제거
- 승인 전 수신자 1명, 승인 후 초대 토큰 재사용 금지
- 송신자/수신자 자격 분리, 재연결 세션 자격 별도 발급
- TURN 단기 자격(HMAC-SHA1, coturn REST API)

주요 환경 변수:

```bash
PORT=8787
HOST=127.0.0.1
ALLOWED_ORIGINS=https://shareshare.example.com
ROOM_TTL_MS=900000
RECONNECT_GRACE_MS=120000
HEARTBEAT_TIMEOUT_MS=60000
MAX_MESSAGE_BYTES=65536
MAX_ROOMS=1000
MAX_MESSAGES_PER_MINUTE=600
MAX_ATTACH_ATTEMPTS_PER_MINUTE=30
STUN_URLS=stun:stun.l.google.com:19302
TURN_URLS=turn:turn.example.com:3478?transport=udp,turn:turn.example.com:3478?transport=tcp
TURN_SECRET=<coturn static-auth-secret과 동일한 32바이트 이상 값>
TURN_TTL_SECONDS=600
TRUST_PROXY=false
```

`TURN_URLS`를 설정하면 `TURN_SECRET`이 반드시 필요합니다. 리버스 프록시 뒤에서 실제
클라이언트 IP로 레이트리밋을 하려면 `TRUST_PROXY=true`를 설정하고 프록시가
`X-Forwarded-For`를 덮어쓰도록 구성하세요.

강제 TURN 테스트는 웹 개발 서버를 `VITE_FORCE_RELAY=true`로 띄웁니다. 이 경우
`iceTransportPolicy: "relay"`가 적용되어 직접 후보를 사용하지 않습니다. TURN/TCP 경로는
`TURN_URLS`에 `?transport=tcp`만 넣고 UDP 3478을 막아 확인합니다.

`infra/`에 systemd, Caddy, coturn 예제가 있습니다.

### 배포 예시

```bash
pnpm install --frozen-lockfile
pnpm build

sudo install -d -o shareshare -g shareshare /srv/shareshare/apps/signaling
sudo cp -a apps/signaling/dist /srv/shareshare/apps/signaling/
sudo install -m 0644 infra/systemd/shareshare-signaling.service /etc/systemd/system/
sudo install -m 0600 infra/signaling.env.example /etc/shareshare/signaling.env
# /etc/shareshare/signaling.env 편집 후
sudo systemctl daemon-reload
sudo systemctl enable --now shareshare-signaling
```

웹은 `apps/web/dist`를 정적 서버에 두고 `/ws`를 시그널링 포트로 프록시합니다
(`infra/Caddyfile.example`). `ALLOWED_ORIGINS`는 실제 공개 origin과 정확히 일치해야
하며, 프록시가 `X-Forwarded-For`를 덮어쓸 때만 `TRUST_PROXY=true`를 사용하세요.
배포 후 `/healthz`와 두 브라우저 전송을 확인합니다.

## 수동 검증 표

| 분류 | 사례 | 상태 |
|---|---|---|
| 파일 | 0 B, 1 B, 청크 경계 | 자동 + headless Chromium 통과 |
| 파일 | 1 GiB, 10 GiB | 수동 필요 |
| 이름 | 한글, 공백, 이모지, 긴 이름 | 한글·이모지 E2E, 긴 이름 수동 필요 |
| 네트워크 | 로컬 직접 연결 | headless Chromium 루프백 통과, GUI 수동 필요 |
| 네트워크 | 서로 다른 회선 / 강제 TURN | 수동 필요 |
| 단절 | 전송 중 5초/30초 단절, 유예 초과 | 재개 자동 단위 테스트 + DataChannel 종료 E2E, 실제 네트워크 수동 필요 |
| 저장 | 권한 거절, 디스크 부족, 쓰기 오류 | 쓰기 오류 자동, 피커/권한 수동 필요 |
| 수명 | 탭 닫기, 새로고침, 절전 | 수동 필요 |
| 프로토콜 | 잘못된 길이/오프셋, 중복 ACK, 잘못된 상태 | 자동 테스트 통과 |
| 인증 | 만료 링크, 다른 수신자, 잘못된 재접속 자격 | 자동 테스트 통과 |
| 완료 | 해시 불일치, verified 응답 유실 | 자동 + verified 유실 E2E 통과 |

수동 테스트 시 기록할 항목: 브라우저·버전, OS, 파일 크기, 연결 경로(직접/TURN/프로토콜),
최대 메모리, 전송 시간, 최종 SHA-256, 부분 파일 동작.

## 의존성과 번들

- `@noble/hashes` 2.4.0 — MIT, audited, 무의존성, 증분 SHA-256. 해시 Worker 청크 약 5.8 KiB.
- `zod` 4 — 메시지 런타임 검증, `ws` 8 — Node WebSocket, React 19, Vite 8, TypeScript 5.9.
- 웹 프로덕션 JS 약 387 KiB(gzip 114 KiB), 시그널링 ESM 번들 약 903 KiB(의존성 포함).

버전·라이선스는 설치 시점 기준이며, 배포 전 `pnpm licenses list`로 다시 확인하세요.

## 알려진 한계

- 새로고침·탭 재시작 후 세션/해시 상태 복구 없음
- 수신자가 저장 위치를 고르기 전에는 전송을 시작하지 않음
- 취소/실패 후 부분 파일의 보존·삭제는 브라우저 구현에 따라 다름. 앱은 abort를 시도하고
  부분 파일이 남을 수 있음을 표시
- 10 GiB 및 실제 인터넷/TURN 경로는 아직 검증되지 않음
- 서버는 파일 본문을 보관하지 않지만 TURN/시그널링 메타데이터와 트래픽 양은 운영상 관찰 가능
