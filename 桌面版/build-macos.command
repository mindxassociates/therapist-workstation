#!/bin/bash
# 心理咨询师工作台 — macOS 一键构建（首次运行会自动安装缺失工具，可能需要较长时间）
set -e
cd "$(dirname "$0")"
echo "============================================================"
echo " Therapist Workstation — macOS 一键构建"
echo "============================================================"

# ---------- Xcode 命令行工具 ----------
if ! xcode-select -p >/dev/null 2>&1; then
  echo "[SETUP] 未检测到 Xcode 命令行工具，正在启动安装（请在弹窗中点「安装」，装完后重新运行本脚本）…"
  xcode-select --install || true
  exit 0
fi

# ---------- Rust ----------
if ! command -v cargo >/dev/null 2>&1; then
  echo "[SETUP] 未检测到 Rust，正在安装 rustup…"
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
  source "$HOME/.cargo/env"
fi

# ---------- Node.js ----------
if ! command -v node >/dev/null 2>&1; then
  if command -v brew >/dev/null 2>&1; then
    echo "[SETUP] 未检测到 Node.js，正在用 Homebrew 安装…"
    brew install node@22
  else
    echo "[FAIL] 未检测到 Node.js。请先从 https://nodejs.org 安装 Node.js 22 LTS，再重新运行本脚本。"
    exit 1
  fi
fi

# ---------- 版本一致性 ----------
node -e "const fs=require('fs');const a=require('./package.json').version;const b=require('./src-tauri/tauri.conf.json').version;const c=fs.readFileSync('src-tauri/Cargo.toml','utf8').match(/^version\s*=\s*\"([^\"]+)\"/m)[1];if(a!==b||a!==c){console.error('[FAIL] 版本号不一致: package.json='+a+' tauri.conf.json='+b+' Cargo.toml='+c);process.exit(1)}console.log('[OK] 版本 '+a)"
VER=$(node -p "require('./package.json').version")

echo "[1/4] 安装 JavaScript 依赖…"
npm install
echo "[2/5] 检查 Rust 后端（主程序 + AI 组件程序）…"
npm run check
cargo check --manifest-path src-tauri/helper/Cargo.toml
echo "[3/5] 构建 macOS 应用（.app + .dmg）…"
npm run build -- --bundles app,dmg

echo "[4/5] 收集成品到 ./release/ …"
mkdir -p release
DMG=$(ls src-tauri/target/release/bundle/dmg/*.dmg 2>/dev/null | head -1)
APP=$(ls -d src-tauri/target/release/bundle/macos/*.app 2>/dev/null | head -1)
[ -n "$DMG" ] && cp "$DMG" "release/TherapistWorkstation-$VER-macOS.dmg"
if [ -n "$APP" ]; then ditto -c -k --sequesterRsrc --keepParent "$APP" "release/TherapistWorkstation-$VER-macOS-app.zip"; fi
if [ -n "$APP" ]; then
  echo "[+] 制作便携版（免安装，数据保存在 .app 同文件夹）…"
  PSTAGE="release/TherapistWorkstation-$VER-macOS-Portable"
  rm -rf "$PSTAGE"; mkdir -p "$PSTAGE"
  cp -R "$APP" "$PSTAGE/"
  touch "$PSTAGE/portable.mode"
  cp "便携版说明.md" "$PSTAGE/便携版说明.md"
  ditto -c -k --sequesterRsrc --keepParent "$PSTAGE" "release/TherapistWorkstation-$VER-macOS-Portable.zip"
  rm -rf "$PSTAGE"
fi
echo "[5/5] 构建 AI 组件包（上传到对应版本的 GitHub Release 后，安装版可一键下载启用）…"
cargo build --release --manifest-path src-tauri/helper/Cargo.toml
CSTAGE="release/ai-components-stage"
rm -rf "$CSTAGE"; mkdir -p "$CSTAGE/engines/llama"
cp "src-tauri/helper/target/release/tw-ai-helper" "$CSTAGE/tw-ai-helper"
if [ "$(uname -m)" = "arm64" ]; then LARCH="arm64"; else LARCH="x64"; fi
curl -sSL -o /tmp/tw-llama-mac.zip "https://github.com/ggml-org/llama.cpp/releases/download/b6123/llama-b6123-bin-macos-$LARCH.zip"
unzip -q -o /tmp/tw-llama-mac.zip -d /tmp/tw-llama-mac
LLDIR=$(dirname "$(find /tmp/tw-llama-mac -name llama-cli -type f | head -1)")
cp -R "$LLDIR/"* "$CSTAGE/engines/llama/"
printf '%s\n' "macOS 组件包说明" "" "本包包含智能记录组件程序与笔记生成引擎（llama-cli）。" "录音转写引擎（whisper-cli）在 macOS 上请通过 Homebrew 安装：brew install whisper-cpp" "或在智能记录页填写自定义引擎路径。" > "$CSTAGE/说明.txt"
rm -rf /tmp/tw-llama-mac /tmp/tw-llama-mac.zip
(cd "$CSTAGE" && zip -r -q "../ai-components-v$VER-macos.zip" .)
rm -rf "$CSTAGE"
(cd release && shasum -a 256 TherapistWorkstation-* > SHA256SUMS.txt)
echo ""
echo "============================================================"
echo " 构建成功"
echo " 成品在 release/ 文件夹：.dmg 是安装版，-Portable.zip 是便携版（便携版不含智能记录）；"
echo " ai-components-v$VER-macos.zip 是智能记录组件包，请上传到 GitHub Release v$VER，安装版即可在应用内下载启用。"
echo " 注意：本安装包未做 Apple 签名。首次打开请右键点击应用选"
echo " 「打开」，或在 系统设置 → 隐私与安全性 中点「仍要打开」。"
echo "============================================================"
open release
