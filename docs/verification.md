# 검증 보고서

작성일: 2026-11-15

## 환경

- Linux (Arch), Node.js 22.23.2, pnpm 12.4.2
- 자동 브라우저 검증: Chromium 155.0.8059.84, headless, 루프백
- 저장 위치 선택: 페이지 내 in-memory writable 스텁 (네이티브 피커 자동화 불가)

## 실행한 검증

```bash
pnpm typecheck
pnpm test          # 41 tests
pnpm build
pnpm test:e2e      # 시그널링 + Vite dev server 필요
```

결과:

- TypeScript strict typecheck 통과
- protocol/transfer/signaling 단위·통합 테스트 45개 통과
- signaling production ESM 번들 실행 및 `/healthz` 응답 확인
- web production 빌드 통과
- 브라우저 E2E 통과:
  - 1 B, 16,385 B, 307,213 B 전송·SHA-256 일치
  - DataChannel 강제 종료 후 확인된 위치부터 이어받기 (4 MiB)
  - RTCPeerConnection 강제 종료 후 새 연결로 이어받기 (4 MiB)
  - 시그널링 WebSocket 재연결 중 DataChannel 전송 지속 (4 MiB)
  - `verified` 응답 1회 유실 후 `finish` 재전송으로 완료 (300 KiB)

E2E가 확인하지 않는 것: 네이티브 저장 피커, 권한 거절/디스크 부족, 실제 NAT/TURN,
TURN/TCP/TLS, 1 GiB/10 GiB, 절전, 실제 5초/30초 네트워크 단절.

## 자동 테스트가 확인한 항목

- 프레임: 버전·플래그·길이·오프셋·파일 상한, 64비트 오프셋
- 메시지: zod 스키마, 10진 크기, SHA-256 형식, 토큰/방 ID 형식
- 상태 머신: 허용 전이와 불가능 전이
- 전송: 0 B/1 B/청크 경계/1 MiB+, 빈 파일, 잘못된 프레임, 갭, 중복 프레임·ACK,
  ACK 유실, 저장 실패, 취소, 해시 불일치, 미확인 바이트 상한, send 실패 후 재개
- 재개: 수신 확인 오프셋부터 재개, 원본 변경 시 해시 불일치
- 시그널링: 생성/입장/승인/릴레이, 자격 분리, 정원, 초대 재사용 금지, 만료,
  재연결 유예, Origin 거부, 메시지 크기, 레이트리밋, TURN HMAC 자격

## 수동 검증 절차 (남은 항목)

1. `pnpm dev:signaling`, `pnpm dev:web` 실행.
2. 실제 GUI Chrome/Edge 두 PC에서 직접 연결 전송.
3. `VITE_FORCE_RELAY=true`로 relay-only 전송.
4. TURN UDP를 막고 `?transport=tcp` URL로 TURN/TCP 확인.
5. TURN TLS(5349) 인증서 구성 후 TURN/TLS 확인.
6. 1 GiB, 10 GiB 전송 중 메모리 사용량·시간·SHA-256 기록.
7. 전송 중 5초/30초 네트워크 차단, 유예 초과, 취소.
8. 저장 권한 거절, 디스크 부족, 저장 위치 선택 취소.
9. 탭 닫기·새로고침·절전에서 상대 상태와 자원 정리 확인.
10. 한글·공백·이모지·매우 긴 파일 이름의 표시와 저장 이름 확인.

기록 항목: 브라우저·버전, OS, 파일 크기, 연결 경로, 최대 메모리, 전송 시간, 최종
SHA-256, 부분 파일 동작, 오류 코드.
