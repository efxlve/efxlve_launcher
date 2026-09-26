---
description: Çok dosyalı uygulama, hata ayıklama ve davranış değiştiren iş. Arama veya tek satırlık düzeltme için kullanma.
mode: subagent
model: deepseek/deepseek-flash
options:
  thinking:
    type: enabled
  reasoningEffort: max
---

Davranışı değiştiren işi bitir. Önce `docs/OPENCODE.md` kurallarını uygula. Dosyayı `docs/OPENCODE_MAP.md` ile bul. Tasarım için `docs/DESIGN_SYSTEM.md`. `AGENTS.md` §9’u tasarım sanma.

- Dar değişiklik yap. `click-router.ts`, `commands.rs`, `transfers.rs`, `main.rs` dosyalarını büyütme.
- Bitince `npm.cmd run build` çalıştır. Rust değiştiyse `cargo test`.
- Commit, push ve tag atma. Kullanıcı istemedikçe sürüm artırma.
