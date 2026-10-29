# QQ Bridge local deployment

Windows deployment of [QQ Bridge](https://github.com/Derpyu520/qq-bridge), its three MCP servers and local watchdog/schedule. This repository contains a modified copy of QQ Bridge; its original copyright and MIT license are retained in LICENSE. SnowLuma and DeepSeek Harness (DSH) are separate prerequisites; they are neither included nor installed by this repository.

The bridge depends on the separately distributed `@snowluma/sdk` and `@snowluma/mcp` npm packages. Their packages declare `SEE LICENSE IN LICENSE`, but the installed packages inspected here did not contain that file; `npm ci` also patches their local installed copies. They are not included in this repository. Review the third-party notes in LICENSE and the applicable upstream terms before using or distributing those dependencies.

## Before installation

- Install Node.js 22.13 or later, npm and Git. Ensure `node.exe` and `npm.cmd` are on PATH.
- Install and configure QQ, SnowLuma and DSH yourself. Create a DSH profile and identify the installed DSH `lib/bin.js` and DSH home directory. Configure local OneBot HTTP on port 3000 and WebSocket on port 3001, with the same nonempty access token. Configure SnowLuma's QQ account and injection according to its own documentation and license.
- Use your own bot QQ, optional owner QQ and allowed groups. This repository contains no personal account or group whitelist. With no groups given, group access remains disabled until configured.

From PowerShell in this repository (replace every placeholder locally):

```powershell
.\install.ps1 -SnowLumaDir '<SnowLuma directory>' -DshBin '<DSH directory>\lib\bin.js' `
  -DshHome '<DSH home>' -Profile web -BotQQ '<your bot QQ>' `
  -OwnerQQ '<your administrator QQ>' -GroupIds @('<your group ID>')
```

The installer installs repository dependencies, configures the DSH profile and MCP servers, creates local `config.json` and `state/install.json`, and registers two Windows scheduled tasks. It refuses to replace an existing unrelated task or configuration. To continue a previously interrupted installation with the same paths and account, add `-Resume`. The files under `state/` and `config.json` are local secrets and must remain private.

The local defaults also enable the existing group daily report, moderation reporting, group-owner moderation commands and voice tools. The daily report targets the groups supplied to the installer and can send a report at midnight. Review these settings before allowing a live group. Voice needs the user's own permitted audio files and a separately installed FFmpeg where required; personal audio is not included.

Restart DSH after installation. Start QQ and SnowLuma according to their own instructions, then use `tools/start-and-selfcheck.ps1` to start/check the bridge and open its consoles. Use `tools/full-chain-check.ps1` for diagnosis. The provided default group policy is diving, ordinary-message recommendation probability 0.01, with the 普瑞赛斯 role. Empty private and group access lists do not grant access. Ask an agent to follow AGENTS.md when setting this up.

The scheduler pauses AI Monday–Thursday, allows Friday 16:00–22:00 and weekends or listed holidays 10:00–22:00, using China Standard Time. The included holiday list covers the published 2026 dates only; update it when subsequent years' official dates are available. It does not keep a sleeping computer awake. The watchdog and scheduler are Windows tasks; their names start with `QQDSH-`.

The included `-NoTasks -SkipDshInstall` options allow an isolated fixture installation, but do not constitute a complete live setup. Testing and status checks do not send QQ messages; scripts explicitly named `send-*` or a console test-send action do send messages and require the user's authorization.

## Current verification

This initial release has been exercised in isolated directories on Windows with fixture OneBot configuration and a separate DSH home: npm installation, real DSH plugin installation and configuration expansion, the three MCP stdio handshakes, a paused bridge on isolated ports, scheduled-task registration with temporary names, and schedule boundary checks. It has not yet been verified on a clean Windows machine with a separately installed, logged-in SnowLuma/QQ account and live model traffic. Check the full chain in your own environment before relying on unattended operation.
