# hermes-voice-web

Talk to your [Hermes Agent](https://hermes-agent.nousresearch.com) like Jarvis, from a browser or a phone.

Tap an orb, speak, hear the answer, cut it off mid-sentence and keep going. One small Node gateway
sits between the browser and three things you already have or can get for free: the Hermes API
server, Nari Labs speech-to-text and Nari Labs text-to-speech.

- Hands-free after one tap: the browser runs a Silero VAD, so you never hold a button.
- Barge-in: start talking while it speaks and it stops instantly. The next turn tells Hermes exactly
  how much of its previous answer you actually heard.
- Streams everything: partial transcripts appear as you speak, the answer is spoken sentence by
  sentence while Hermes is still writing, tool progress shows on screen, and a short "On it." fills
  the gap when a tool call takes a few seconds.
- Works on an iPhone as a home-screen app over HTTPS.
- No framework, one runtime dependency on the server (`ws`), plain AudioWorklets in the browser.

## How it works

```
  Browser (phone or desktop)                 Gateway (Node 22)                   Services
 ┌───────────────────────────┐   WebSocket   ┌────────────────────────┐
 │ mic ─► AudioWorklet 16 kHz├──── PCM16 ───►│ nari-stt.mjs           │──WS──► Nari realtime STT
 │        Silero VAD (local) │  speech_end   │   partial / final      │
 │        interrupt on speech├──────────────►│ session.mjs            │
 │                           │   partial     │   IDLE LISTENING       │
 │ live transcript ◄─────────┤   final       │   THINKING SPEAKING    │
 │                           │   status      │                        │
 │ assistant text ◄──────────┤assistant_text │ hermes.mjs (SSE) ──────│──HTTP─► Hermes /v1/chat/completions
 │                           │               │   sentences.mjs        │          X-Hermes-Session-Id
 │ player worklet 24 kHz ◄───┤◄── PCM16 ─────│ nari-tts.mjs (stream) ─│──HTTP─► Nari /v1/audio/speech
 │   ► WebRTC loopback ► <audio> (so AEC works)                       │
 │ interrupt + heard_ms ─────►│  flush        │ abort Hermes + TTS,    │
 │ ring buffer emptied       │◄──────────────│ note what was heard    │
 └───────────────────────────┘               └────────────────────────┘
```

Turn flow: mic frames stream to Nari while you talk; the browser VAD sends `speech_end`, the gateway
commits the utterance, Nari returns the final transcript, the gateway posts it to Hermes with the
persistent session id, buffers deltas into sentences, synthesises each one as soon as it is complete
and streams the audio down. If you talk over it, the browser sends `interrupt` before any server
round trip, drops its audio queue, and reports how many milliseconds were played; the gateway aborts
both upstream streams and prefixes the next user turn with a system note such as
"The assistant was interrupted by the user. Of its previous reply the user heard only: ...".

## 5-minute setup (one user, one VPS)

### 1. Enable the Hermes API server

On the machine running Hermes, in its environment (or `~/.hermes/config.yaml`):

```bash
API_SERVER_ENABLED=true
API_SERVER_KEY=pick-a-long-random-string
# defaults: API_SERVER_HOST=127.0.0.1 API_SERVER_PORT=8642
```

Restart Hermes and check `curl -H "Authorization: Bearer $API_SERVER_KEY" http://127.0.0.1:8642/v1/models`
returns a model named `hermes-agent`.

### 2. Get a Nari Labs key

Sign up at https://narilabs.com and create an API key. The free models used by default
(`qwen3-asr:free` and `qwen3-tts:free`) cost nothing.

### 3. Install and configure

```bash
git clone https://github.com/bachellerieloic/hermes-voice-web.git ~/hermes-voice-web
cd ~/hermes-voice-web
npm install            # also copies the VAD runtime into public/vad/
cp .env.example .env
$EDITOR .env           # HERMES_API_KEY, NARI_API_KEY, VOICE_TOKEN at minimum
npm start
```

`npm start` validates the config and prints every missing or invalid value at once. The gateway
binds to `127.0.0.1:8765`; put HTTPS in front of it, the browser will not open a microphone on plain
HTTP from anywhere but localhost.

Generate a good token with `openssl rand -hex 24`.

### 4a. HTTPS with nginx on a domain you already have (first choice)

If the VPS already serves a domain over HTTPS, mount the app under a path. Set `BASE_PATH=/voice`
in `.env` and add the block from [`deploy/nginx-location.conf`](deploy/nginx-location.conf) inside
your `server { }`:

```nginx
location /voice/ {
    proxy_pass http://127.0.0.1:8765;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_buffering off;
    proxy_read_timeout 3600s;
}
```

Then `sudo nginx -t && sudo systemctl reload nginx` and open `https://your-domain/voice/`.
Set `TRUST_PROXY=true` so the failed-token rate limit is counted per visitor rather than per proxy.
The page, its worklets, the VAD files and the WebSocket endpoint are all relative to the mount, so
any prefix works; the bare `/voice` is redirected to `/voice/`.

### 4b. HTTPS with Tailscale Serve (second choice, no public exposure)

```bash
tailscale serve --bg https:8443 http://127.0.0.1:8765
```

Enable HTTPS once for your tailnet in the admin console (DNS page, "Enable HTTPS"). The app is
then at `https://<node>.<tailnet>.ts.net:8443/` for devices on the tailnet only. Leave `BASE_PATH`
empty. Any other reverse proxy (Caddy, Traefik) works the same way as the nginx block: forward the
WebSocket upgrade and do not buffer.

### 5. Keep it running

systemd user unit (recommended):

```bash
mkdir -p ~/.config/systemd/user
cp deploy/hermes-voice-web.service ~/.config/systemd/user/
# edit ExecStart if your node lives elsewhere: nvm which 22
systemctl --user daemon-reload
systemctl --user enable --now hermes-voice-web
loginctl enable-linger $USER
journalctl --user -u hermes-voice-web -f
```

Or a tmux one-liner: `tmux new -d -s voice 'cd ~/hermes-voice-web && npm start'`.

### 6. iPhone

1. If you used Tailscale Serve, open the Tailscale app and connect. With nginx on a public domain
   there is nothing to do.
2. Open the URL in Safari, tap Share, then "Add to Home Screen". Launch it from the icon so it runs
   full screen.
3. Tap the orb, paste the `VOICE_TOKEN` when asked (stored in that browser only), allow the
   microphone. From then on it is hands-free: speak, wait, interrupt at will.
4. Headphones are recommended. Echo cancellation is good but not perfect on a phone speaker, and
   the VAD can trigger on loud playback.

Desktop Chrome, Edge, Safari and Firefox work the same way at the same URL.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `HERMES_API_URL` | `http://127.0.0.1:8642` | Hermes API server |
| `HERMES_API_KEY` | required | Its `API_SERVER_KEY` |
| `HERMES_MODEL` | `hermes-agent` | Model name sent with each request |
| `NARI_API_KEY` | required | Nari Labs key |
| `NARI_API_URL` | `https://api.narilabs.com` | Nari base URL (both STT and TTS derive from it) |
| `NARI_TTS_MODEL` | `qwen3-tts:free` | `qwen3-tts-fast:free` is quicker |
| `NARI_VOICE` | `leon` | Any voice id from Nari's list, case sensitive |
| `NARI_STT_MODEL` | `qwen3-asr:free` | `qwen3-asr-fast:free` is quicker |
| `NARI_LANGUAGE` | `en` | Empty for automatic detection |
| `NARI_TURN_DETECTION` | `client` | `client`: browser VAD ends the turn. `server_vad`: Nari's `{"type":"server_vad"}` |
| `VOICE_TOKEN` | required | Shared secret the browser presents on the WebSocket upgrade (16+ chars) |
| `HOST` / `PORT` | `127.0.0.1` / `8765` | Bind address |
| `ALLOWED_ORIGINS` | empty | Comma list of allowed browser origins. Empty means same host as the request |
| `BASE_PATH` | empty | Mount prefix behind a reverse proxy, for example `/voice` |
| `TRUST_PROXY` | `false` | Read `X-Forwarded-For` for the rate limiter |
| `ACK_DELAY_MS` / `ACK_TEXT` | `1500` / `On it.` | Spoken filler when the first token is slow |

Security model: the page itself is public and static; every WebSocket upgrade needs `?token=` to
match `VOICE_TOKEN` (constant-time compare) and an allowed `Origin`. Five bad tokens from one client
inside a minute block it for the rest of that minute. Tokens are never logged or echoed.

## What it costs

- Nari free tier: 100 TTS requests and 100 STT connections per model per day, 2 concurrent
  connections per organisation, utterances up to 36 s, and the STT socket closes after 60 s without
  audio. Each spoken sentence is one TTS request and each reconnect is one STT connection, so a
  chatty day can hit the limit; the gateway reconnects lazily and reports `FREE_DAILY_LIMIT_EXCEEDED`
  on screen when it happens. Paid models (`qwen3-tts`, `qwen3-asr`) lift this.
- Hermes: whatever model and provider your agent already uses. Voice adds nothing.
- This gateway: a few MB of RAM on your VPS.

## Limits

- No wake word. On a phone the page must be open and on screen; iOS suspends audio and WebSockets in
  the background, so there is no "hey Hermes" from a locked phone. The app requests a screen wake
  lock while a session is open.
- One user. Every socket gets its own session and Nari connection; the free tier allows two.
- The transcript lives in Hermes, keyed by a per-browser session id. "New conversation" in the header
  rotates it.
- Long tasks: the gateway aborts the HTTP stream on interrupt. Hermes may keep working on the task in
  the background; `/v1/runs` cancellation is not wired yet.
- Code in answers is spoken as "code omitted"; the text still shows on screen.

## Protocol

Text frames are JSON, binary frames are audio.

Browser to gateway: `speech_start`, `speech_end` (commit the utterance), `interrupt`,
`heard_ms {ms}`; binary frames are 16 kHz PCM16 mono.

Gateway to browser: `status {state, detail?}`, `partial {text}`, `final {text}`,
`assistant_text {text, done}`, `flush` (empty the playback queue), `error {message}`; binary frames
are 24 kHz PCM16 mono.

## Development

```bash
npm test            # node:test, no network: unit tests plus an integration run against
                    # in-process fakes of Nari STT, Nari TTS and the Hermes SSE stream
npm run vendor-vad  # refresh public/vad/ from node_modules
```

`server/session.mjs` is a pure reducer: `reduce(session, event)` returns the next state and a list
of effects, which is what the tests exercise for barge-in and the heard-text truncation.

## Credits

See [NOTICE](NOTICE) for the projects whose ideas and small snippets this borrows:
hermes-live-voice, jarvis_ai, google-adk-realtime-deepagents-example, plus the vendored
@ricky0123/vad-web, Silero VAD and onnxruntime-web.

MIT, see [LICENSE](LICENSE).
