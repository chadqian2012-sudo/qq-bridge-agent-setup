# Agent installation guide

This repository configures a Windows QQ bridge and three MCP servers. DSH, QQ and SnowLuma must already be installed and configured by their user. Never copy real account IDs, group IDs, tokens, personal state, chat logs or absolute local paths into a commit. Do not send a QQ message as a test unless the user explicitly authorizes that message.

1. Read README.md, check the prerequisites and identify the user's own SnowLuma directory, DSH CLI file and DSH home/profile. Obtain the user's bot QQ, optional administrator QQ and allowed group IDs locally. Do not infer them from examples.
2. Verify that the user's SnowLuma OneBot HTTP endpoint on port 3000 and WebSocket endpoint on port 3001 have the same nonempty token. The user must configure SnowLuma and QQ themselves. Do not patch or redistribute SnowLuma.
3. Run install.ps1 with those local paths and IDs. Its `-NoTasks` and `-SkipDshInstall` switches are for isolated tests; a real setup normally needs both scheduled tasks and DSH plugin installation. Never use fixture identifiers in a live setup.
4. Start QQ, SnowLuma and DSH using the user's existing installation and restart DSH after setup. Check the account, target groups, bridge status and schedule with tools/full-chain-check.ps1 and tools/ai-night-schedule.ps1. Check errors, rather than assuming a process or browser tab proves connectivity.
5. After any change, run relevant tests and a privacy scan. Review what git will commit, including files excluded from automated scanning. No output from a scanner alone proves that material is safe to publish.

Do not modify or terminate processes belonging to another installation. If installing the scheduled tasks conflicts with existing tasks, preserve them and report the conflict.
