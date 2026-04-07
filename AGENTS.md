# AGENTS.md

## Intent
- Keep this project as a minimal, secure WebSocket bridge + web client for Codex RPC.

## Operating Rules
- Prefer small, reversible diffs.
- Do not add dependencies unless explicitly requested.
- Validate changes with `node --check bridge.js` and targeted runtime checks.
- Treat security defaults as mandatory:
  - No default weak secrets in production.
  - No token leakage in logs or URLs.
  - No untrusted HTML rendering without sanitization.

## Code Review Priorities
- Authentication and authorization on bridge endpoints.
- Input validation and path handling for any filesystem RPC.
- XSS and injection risks in `public/index.html`.
- WebSocket lifecycle robustness (open/close/error, backpressure, buffering).

## Completion Checklist
- Changes compile.
- Manual smoke checks pass for `/health`, static serving, and WS connect flow.
- Risks and remaining gaps are explicitly documented.
