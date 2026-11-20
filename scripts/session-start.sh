#!/bin/bash
# Claude Code SessionStart hook.
# In cloud sessions, bring node dependencies in line with the checked-out
# branch (the environment's setup script result is cached for about a week).
# Does nothing on a local machine. Never blocks the session.
[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0
cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0
[ -f pnpm-lock.yaml ] || exit 0

# Output goes to stderr so it stays out of the conversation context.
pnpm install --frozen-lockfile --prefer-offline >&2 \
  || echo "session-start: pnpm install failed" >&2
exit 0
