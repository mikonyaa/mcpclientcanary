# Security

Do not post credentials, proprietary prompts or full native transcripts in public issues. Use GitHub's private vulnerability reporting if enabled; otherwise contact the maintainer through the account's published channels and share only a minimal synthetic reproduction.

The supported mode uses exclusively synthetic tools, owned directories and a loopback mock model. It is not a full network sandbox. Provider auth is removed by an allowlist; clean CLAUDE_CONFIG_DIR auth identity is checked before the dummy credential is installed. Managed policy is neither changed nor bypassed.

Controlled paths reject symlink/traversal escapes. Cleanup requires the owner marker and canonical root. Reports treat text as escaped data, do not execute imported JSON, and load no remote assets. Evidence capture is bounded. Vendor executable distribution is separate. No private raw capture feature is exposed in v0.1.0.
