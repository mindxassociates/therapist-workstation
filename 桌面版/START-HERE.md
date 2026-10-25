# START HERE — Muse Handoff

> **2026-10-25 更新（V3.1.1）**：本目录已由 Muse 按 HANDOFF.md 完成 V3.1.1 稳定化构建，
> 并按产品所有者要求换上 Mind X Provider Portal 品牌色、面向中国大陆执业咨询师。
> 变更与测试结果见 `CHANGELOG.md`；构建方法见 `README.md`（Windows / macOS 各一节）。
> 以下为原始交接说明，仍然有效。


This archive contains the **actual recoverable desktop source code** plus the latest improved Web UI reference and the full project handoff.

## What is authoritative

- `src-tauri/` + `web/index.html`: actual Tauri/SQLCipher desktop source recovered from the V3.0.6 complete source package.
- `reference/心理咨询师工作台_V1.11.0_改良版.html`: newer Web UI/product reference that the desktop app is intended to converge on.
- `HANDOFF.md`: product requirements, architecture decisions, historical failures, stabilization plan, and smoke tests.

## Important provenance note

A previously referenced `TherapistWorkstation-V3.1.0-WebUI-SQLCipher.zip` was not recoverable as a physical source archive in the current workspace. Therefore this package does **not** pretend that an unverified V3.1 source tree exists. Muse should treat the included V3.0.6 desktop source as the code baseline and V1.11.0 as the UI/product reference, then produce a verified V3.1.x stabilization release.

## First task for Muse

1. Read `HANDOFF.md` completely.
2. Audit `web/index.html`, `src-tauri/src/lib.rs`, `src-tauri/src/main.rs`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json`.
3. Build the existing desktop baseline cleanly on Windows before major refactoring.
4. Compare the desktop frontend against `reference/心理咨询师工作台_V1.11.0_改良版.html`.
5. Integrate the newer UI without regressing Tauri authentication, SQLCipher persistence, backup, audit, or auto-lock.
6. Fix persistence/UI refresh problems before adding new features.
7. Run the full smoke test in `HANDOFF.md`.

Do not use real client data during development or testing.
