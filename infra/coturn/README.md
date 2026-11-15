# coturn

`turnserver.conf`는 REST API 단기 자격(`use-auth-secret`)만 허용하는 예제입니다.
`static-auth-secret`은 compose가 `TURN_SECRET` 환경 변수로 주입합니다.

```bash
cd infra/coturn
TURN_SECRET="$(openssl rand -base64 48)" \
TURN_EXTERNAL_IP="203.0.113.10" \
docker compose up -d
```

시그널링 서버에도 같은 비밀을 설정합니다.

```bash
TURN_URLS="turn:turn.example.com:3478?transport=udp,turn:turn.example.com:3478?transport=tcp"
TURN_SECRET="<위와 동일>"
TURN_TTL_SECONDS=600
```

확인:

```bash
docker compose logs -f coturn
# 다른 회선의 브라우저에서 relay-only 테스트를 하거나
# https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/ 사용
```

운영 전 확인:

- 방화벽에서 3478/udp, 3478/tcp, 49160-49200/udp 허용
- `TURN_EXTERNAL_IP`가 공인 IP인지 확인 (NAT 뒤 서버라면 필수)
- TLS(5349)를 사용할 경우 인증서 마운트 후 `cert`/`pkey` 주석 해제
- `max-bps`, `user-quota`, `total-quota`를 회선 용량에 맞게 조정
- 공개 릴레이가 되지 않도록 사설/루프백 대역 거부 유지
- 시그널링 서버와 coturn의 시계를 NTP로 맞춤 (만료 username 검증)
