# 心理咨询师工作台 Desktop V3.1.3

面向在中国大陆执业的心理咨询师：中文、本地优先、单机多账户。品牌色为 Mind X Provider Portal 的 `#4a778b / #355564`。

Tauri 2 + Web UI + 本地加密数据库的单机桌面版框架。

## V3.1 架构基线

- 单机使用，不提供局域网/云端实时同步。
- 支持多个本地账户；第一个账户自动为管理员。
- 管理员可创建、启用、停用其他本地账户。
- 至少保留一个启用的管理员账户，且不能停用当前登录账户。
- 所有本地账户共享同一个加密工作数据库，不为每个账户建立独立数据仓库。
- 每个账户使用自己的密码解锁同一数据库主密钥。
- 管理员/咨询师角色、自动锁定、密码修改、审计日志与完整性校验继续保留。
- 不要让两台电脑同时直接打开同一活动数据库。

## Windows 首次构建

### 已有环境
Node.js 22 和 Visual Studio 2022 Build Tools 可以继续使用。

### 还需要 Rust
在 PowerShell 中运行：

```powershell
winget install --id Rustlang.Rustup
```

安装后关闭 PowerShell，重新打开，再检查：

```powershell
rustc --version
cargo --version
node -v
npm -v
```

### 构建
解压项目，在项目目录打开 PowerShell：

```powershell
.\build-windows.bat
```

第一次 Rust/Tauri/SQLCipher 编译可能较慢。成功后安装程序位于：

```text
src-tauri\target\release\bundle\nsis\
```

## macOS 构建

在 Mac 上安装 Xcode Command Line Tools、Node.js 22 与 Rust（rustup）后，在项目目录运行：

```bash
chmod +x build-macos.command
./build-macos.command
```

产物位于 `src-tauri/target/release/bundle/`（`.app` 与 `.dmg`）。本项目产物**未签名**：在本机自用可直接打开（首次需在「系统设置 → 隐私与安全性」中放行）；如需分发给其他咨询师，须用 Apple Developer ID 签名并公证（notarization），否则对方 Mac 会拦截。

数据位置（标准模式）：`~/Library/Application Support/us.mindx.therapistworkstation/` 下的 Data / Backups 文件夹；在 `.app` 同目录放置 `portable.mode` 文件则为便携模式。Windows 标准模式位于 `%LOCALAPPDATA%\us.mindx.therapistworkstation\`。

## 第一次运行测试

1. 只使用虚拟来访者数据。
2. 创建第一个管理员账户。
3. 进入“安全与审计”，创建第二个“咨询师”测试账户。
4. 锁定并使用第二个账户登录，确认能看到共享的工作数据。
5. 确认咨询师看不到用户管理功能。
6. 使用管理员重新登录，确认可以停用测试咨询师账户。
7. 测试自动锁定、修改密码、审计日志和完整性校验。
8. 测试备份后完全退出并重新打开应用，确认数据可正常解锁。

正式录入真实资料前，应完成 Windows 实机运行、备份恢复和异常退出测试。

## 部署（一键构建）

构建与分发步骤见 **`部署指南.md`**：Windows 双击 `build-windows.bat`、macOS 运行 `build-macos.command`，脚本会自动安装缺失工具、构建，并把安装包与校验和收集到 `release/` 文件夹。

## 隐私合规（中国大陆）

工作台按《个人信息保护法》对敏感个人信息的处理要求设计：本地加密存储、不上云、单独同意清单项、本地多账户与审计、来访者数据导出与彻底删除、每日加密备份。应用内「隐私与合规」页有完整说明与可打印的《个人信息处理告知》模板。本节与应用内说明均为产品功能说明，不构成法律意见。
