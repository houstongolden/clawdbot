# Myobot Fork Strategy

This is a customized fork of [OpenClaw](https://github.com/openclaw/openclaw) (formerly Moltbot) rebranded as **Myo** for integration with [Myo.ai](https://myo.ai).

## Overview

- **Upstream**: `https://github.com/openclaw/openclaw` (actively maintained, daily updates)
- **Our Fork**: `~/Desktop/CODE_2026/myobot` (local development)
- **Branch Strategy**: 
  - `main` — mirrors upstream for easy syncing
  - `myo-branding` — our Myo customizations (rebase on main)

## Our Customizations

### Branding Changes (`myo-branding` branch)
- **UI Title**: "Myo Control" (was "Moltbot Control")
- **Brand Name**: "MYO" with "Control Panel" subtitle
- **Logo**: Pixelated M with sunset gradient (#FFAA55 → #FF6633)
- **Colors**: Monochrome + sunset orange accent (#FF8844)
- **Font**: Inter (clean, modern)
- **Default Assistant**: name="Myo", avatar="M"
- **CLI Aliases**: `myobot`, `myo` (in addition to `openclaw`, `moltbot`)

### Files Modified
```
ui/index.html                    # Title, app element
ui/src/styles/base.css           # Full color scheme
ui/src/ui/app.ts                 # Custom element name
ui/src/ui/app-render.ts          # Brand header
ui/src/ui/icons.ts               # Myo logo icon
ui/src/ui/assistant-identity.ts  # Default identity
ui/public/myo-icon.svg           # Favicon
src/gateway/assistant-identity.ts # Server-side default
src/gateway/control-ui.ts        # Config injection
package.json                     # CLI aliases, description
README.md                        # Branding
```

### Backward Compatibility Preserved
- Config paths: `~/.clawdbot` and `~/.openclaw` (both supported)
- Storage keys: unchanged (preserves UI settings)
- CLI commands: `moltbot`, `clawdbot`, `openclaw` still work
- Window vars: both `__MYO_*` and `__CLAWDBOT_*` injected

## Sync Workflow

### Quick Sync (recommended)
```bash
cd ~/Desktop/CODE_2026/myobot

# 1. Fetch latest from upstream
git fetch upstream

# 2. Switch to main and fast-forward
git checkout main
git merge upstream/main --ff-only

# 3. Rebase our customizations on top
git checkout myo-branding
git rebase main

# 4. Rebuild
pnpm install
pnpm build
pnpm ui:build

# 5. Restart gateway
./moltbot.mjs gateway restart
```

### If Rebase Has Conflicts
```bash
# During rebase, fix conflicts then:
git add <fixed-files>
git rebase --continue

# Or abort and start over:
git rebase --abort
```

### Automated Sync Check (add to HEARTBEAT.md)
```markdown
- [ ] Weekly: Check openclaw releases at https://github.com/openclaw/openclaw/releases
```

## What to Sync vs Skip

### AUTO-SYNC (low risk)
- `src/telegram/*`, `src/discord/*`, `src/whatsapp/*` — channel plugins
- `src/signal/*`, `src/slack/*`, `src/imessage/*` — more channels
- `extensions/*` — extension channel plugins
- `skills/*` — skill updates
- Security patches — always merge immediately
- Bug fixes — merge after review

### EVALUATE (check for conflicts)
- `src/gateway/*` — may conflict with our control-ui changes
- `src/config/*` — config schema changes
- `ui/*` — may conflict with our branding
- `package.json` — merge carefully (keep our aliases)

### SKIP (we override these)
- `ui/src/styles/base.css` — we have custom Myo theme
- `ui/src/ui/app-render.ts` — we have custom branding
- `README.md` — we have custom readme

## Building & Running

### Development
```bash
cd ~/Desktop/CODE_2026/myobot

# Install deps
pnpm install

# Build TypeScript
pnpm build

# Build Control UI
pnpm ui:build

# Run gateway (foreground)
node dist/index.js gateway --port 18789

# Or via CLI alias
./moltbot.mjs gateway --port 18789
```

### Using Our Custom Build
```bash
# Instead of global openclaw, use local build:
cd ~/Desktop/CODE_2026/myobot
node dist/index.js gateway --port 18789

# Or link globally (optional):
npm link
myobot gateway --port 18789
```

## Myo.ai Integration (Future)

### Planned Features
- Gateway pairing UI in Myo.ai web app
- Cloud ↔ local gateway sync
- Myo.ai API integration for:
  - Session management
  - Tool execution routing
  - Memory sync

### Integration Points
- `lib/gateway/pairing.ts` — pairing code exchange
- `/api/gateways/*` — Myo.ai API endpoints
- WebSocket client for real-time communication

## Resources

- **OpenClaw Docs**: https://docs.openclaw.ai
- **OpenClaw GitHub**: https://github.com/openclaw/openclaw
- **OpenClaw Discord**: https://discord.gg/clawd
- **Myo.ai**: https://myo.ai

## Maintenance Notes

- Check upstream releases weekly
- Run `openclaw doctor` after updates
- Test Control UI in browser after UI changes
- Keep `myo-branding` branch rebased on `main`

---

*Last updated: 2026-01-30*
