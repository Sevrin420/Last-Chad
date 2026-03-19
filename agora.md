# Agora Voice Chat — Setup Notes

## Status
The `/agora/token` endpoint is **fully implemented** in `worker/runner-worker.js` (lines 1171–1188).
Token generation uses `buildAgoraToken006` (lines 1250–1290) — AccessToken v006 binary format with HMAC-SHA256.

## What's Missing
The **Agora App Certificate** hasn't been set as a Cloudflare Worker secret.
Without it, the Worker returns `{ error: 'Agora not configured' }`, token fetch fails,
`joinRoom()` joins with `null` token, and Agora rejects with `CAN_NOT_GET_GATEWAY_SERVER`.

## Setup Steps

1. **Get App Certificate** from [Agora Console](https://console.agora.io):
   - Go to your project → click the "eye" icon next to App Certificate → copy it

2. **Set the secret** on Cloudflare Worker:
   ```bash
   cd worker && npx wrangler secret put AGORA_APP_CERT
   ```
   Paste the certificate when prompted.

3. **Redeploy** (if not auto-deployed):
   ```bash
   npx wrangler deploy
   ```

## Config Reference
- `wrangler.toml` has `AGORA_APP_ID = "7917341a0c9c46a08328cc9a33989d75"`
- `AGORA_APP_CERT` must be set via `wrangler secret put` (never in toml)
- Agora project should be set to **"Secured mode with token"** (not "Testing mode")

## Implementation Details
- Endpoint: `POST /agora/token` with body `{ channelName, uid }`
- Returns: `{ token: "006..." }` — 1-hour expiry
- Privileges granted: joinChannel, publishAudio, publishVideo, publishData
- Uses native Cloudflare Web APIs: `crypto.subtle`, `crypto.getRandomValues`
