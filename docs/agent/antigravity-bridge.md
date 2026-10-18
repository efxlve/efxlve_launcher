# Antigravity bridge (Gemini 3.8 Flash)

Antigravity ships an agent API that can be driven from a terminal. The plan was
for this session to call it directly; that needs a CSRF token the IDE only hands
to its own integrated terminal, and the token is not reachable from outside (it
is not in the language server's environment, and the IDE's storage only mentions
it in log lines). **So the owner is the bridge**: this session writes a brief,
the owner pastes it into Antigravity, and the answer comes back as a chat paste
or a file.

## The API, if it is ever wired up properly

```
language_server.exe agentapi new-conversation [--model=<flash_lite|flash|pro>] [--title=<t>] [--profile=<p>] "<prompt>"
language_server.exe agentapi send-message [--title=<t>] <recipient_id> "<content>"
language_server.exe agentapi get-conversation-metadata <conversation_id>
```

- Binary: `%LOCALAPPDATA%\Programs\antigravity\resources\bin\language_server.exe`
  (`%USERPROFILE%\.gemini\antigravity\bin\agentapi.bat` wraps it).
- Address: `host:port` of the running `language_server` process, no scheme (it is
  gRPC). On 2026-10-18: `127.0.0.1:51280`.
- It answers `unauthenticated: missing CSRF token` without
  `ANTIGRAVITY_CSRF_TOKEN`, which the IDE sets for its own terminal only.

## The manual bridge (what we actually do)

1. A brief lives in `docs/agent/briefs/<topic>.md`. It says what to read, what to
   answer, and — always — that Antigravity must not write to the repository: one
   writer at a time, and that writer is the OpenCode session.
2. The owner pastes the brief into Antigravity (Gemini 3.8 Flash) and brings the
   answer back: paste it in the chat, or save it next to the brief as
   `<topic>-answer.md`.
3. This session acts on it, and the brief plus the answer stay in the repo as the
   record of what was asked and answered.

Antigravity is an agent, not a chat: after every answer, `git status` is worth a
look in case it wrote something despite the instruction.

## Open briefs

- `game-page-review.md` — an independent look at the game page, which the owner
  says got worse. **Answered** by Gemini 3.8 Flash; its findings are folded into
  the plan below.
- `game-page-plan-review.md` — the staged plan, sent to Gemini 4 Argon inside
  Antigravity before any of it is written.
