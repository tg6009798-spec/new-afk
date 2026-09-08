# Tree Bot

Node.js/Mineflayer tree-farming bot prepared for GitHub-based hosting.

## Run

```bash
npm install
npm run selftest
npm start
```

## Required environment variables

- `TREEBOT_USERNAME`
- `TREEBOT_PASSWORD`

Optional variables are documented in `.env.example`.

**Never commit a real Minecraft password to GitHub.** Add the variables in the hosting provider's Environment/Secrets settings.

The app also exposes `/healthz` and `/status` on `PORT` (default `10000`) so hosts that require a web port can detect that the process is alive.

## Configuration

Set `TREEBOT_STAND_X`, `TREEBOT_STAND_Y`, `TREEBOT_STAND_Z` to the block where the bot should stand and `TREEBOT_FACING_YAW` to the direction of the 2x2 planting area.

The bot uses one account only. CAPTCHA handling remains manual and does not attempt to solve CAPTCHAs automatically.
