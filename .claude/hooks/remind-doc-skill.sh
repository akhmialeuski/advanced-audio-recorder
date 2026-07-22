#!/usr/bin/env bash
# PreToolUse hook: when a Write/Edit targets a markdown file, inject a reminder
# to apply the skill-documentation-guide. Non-blocking: it only adds context,
# it never denies the tool. Reads the hook payload JSON on stdin and emits
# nothing for non-markdown targets.
set -euo pipefail

msg="REMINDER: apply skill-documentation-guide before writing this .md. No typographic or pseudo-header labels (no Finding X.Y., no Problem:, no bold key: value lines); write real sentences with connectives between them. Never cram many file names into prose; use a flat single-level list or a real code snippet instead. Commands only in fenced bash blocks, never inline in prose. Impersonal Russian narrative, technical terms in English, no emoji, no em-dash."

jq --arg msg "$msg" '
  if ((.tool_input.file_path // "") | endswith(".md"))
  then {hookSpecificOutput: {hookEventName: "PreToolUse", additionalContext: $msg}}
  else empty
  end
'
