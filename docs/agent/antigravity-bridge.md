# Antigravity bridge (Gemini 3.8 Flash from this session)

Antigravity (the owner's IDE) ships an agent API that can be driven from here.
It is the same binary the IDE runs, and it talks to the running IDE over gRPC.

## What it can do

```
language_server.exe agentapi new-conversation [--model=<flash_lite|flash|pro>] [--title=<t>] [--profile=<p>] "<prompt>"
language_server.exe agentapi send-message [--title=<t>] <recipient_id> "<content>"
language_server.exe agentapi get-conversation-metadata <conversation_id>
```

`--model=flash` is the Gemini 3.8 Flash tier the owner uses. The binary lives at:

```
%LOCALAPPDATA%\Programs\antigravity\resources\bin\language_server.exe
```

`%USERPROFILE%\.gemini\antigravity\bin\agentapi.bat` is a one-line wrapper around
`language_server.exe agentapi %*`.

## What it needs

1. **Antigravity has to be running.** The API is a client of the IDE's language
   server; with the IDE closed there is nothing to talk to.
2. **The language server address**, in `host:port` form (no scheme — it is gRPC):
   read the listening ports of the `language_server` process:
   `Get-NetTCPConnection -State Listen | Where-Object { $_.OwningProcess -in (Get-Process language_server).Id }`
   On 2026-10-18 it was `127.0.0.1:51280` (the other port, 51279, is not gRPC).
3. **The CSRF token**, which the IDE hands to its own integrated terminal as
   `ANTIGRAVITY_CSRF_TOKEN`. Without it the call answers
   `unauthenticated: missing CSRF token`. The owner copies it out once per IDE
   session by running this **in Antigravity's terminal**:

   ```powershell
   "$env:ANTIGRAVITY_CSRF_TOKEN" | Set-Content "$env:TEMP\ag-token.txt"
   ```

   Read it from `%TEMP%\ag-token.txt`; never paste it into a prompt, a commit or
   the conversation.

## How to use it

- **Analysis, reviews and reports only.** Antigravity must not write to the
  repository: one writer at a time, and that writer is the OpenCode session.
  Prompts say so explicitly ("read only, change nothing, run no commands").
- **Ask for the answer as a file** under `%TEMP%` (for example
  `%TEMP%\efxlve-ag-report.md`) and read it afterwards. Pulling text back out of
  a conversation means reading the IDE's own storage, which is fragile.
- **Write the prompt to a UTF-8 file and pass its contents** as the argument:
  Turkish characters do not survive a PowerShell command line intact.
- **Never use a contributor tier model** (see `AGENTS.md` → Models).

## Tested

- `new-conversation` reached the server and was refused only for the missing
  token (`127.0.0.1:51280`), which is how the address and the token requirement
  were found.
- The subagent path inside this session works and is the fallback when
  Antigravity is closed: `opencode-go/claude-haiku-5-5` read `TODO.md` and
  reported its sections correctly.
