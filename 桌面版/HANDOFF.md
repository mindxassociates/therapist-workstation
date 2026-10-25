# 心理咨询师工作台 Desktop --- Muse 项目交接文档

> **交接基线：TherapistWorkstation V3.1.0 WebUI + Tauri 2 + SQLCipher**
>
> 本文档用于让 Muse
> 直接接管项目。请优先阅读"当前状态""必须保持的产品要求""已知问题与验收测试"。不要假定历史版本中已经修过的问题在当前版本一定已经通过回归测试。

------------------------------------------------------------------------

## 1. 项目目标

"心理咨询师工作台"是一个**中文、本地优先（local-first）的心理咨询师桌面工作管理应用**。

主要目标：

-   尽量不依赖云端服务器；
-   临床/业务数据保存在本机加密数据库；
-   支持本地多个用户账户，但定位仍然是**单机使用**，不是 group practice
    网络协作系统；
-   提供来访者档案、日程、咨询记录、咨询目标、任务、随手记、收费、搜索、归档、备份、安全审计等工作流；
-   UI 和文案全部以中文为主；
-   Windows 为当前主要开发/测试平台；
-   后续可保留 macOS 构建能力；
-   最终希望具备适合处理敏感心理健康资料的安全设计，但**不要仅因使用
    SQLCipher/Tauri 就宣称"HIPAA compliant"**。HIPAA
    合规还涉及设备、组织政策、访问控制、备份、风险分析、日志、人员管理等。

------------------------------------------------------------------------

## 2. 当前交接版本

当前桌面代码基线：

``` text
TherapistWorkstation-V3.1.0-WebUI-SQLCipher
```

当前前端基线来源于最新版网页版：

``` text
心理咨询师工作台_V1.11.0_改良版.html
```

重要原则：

> **从现在开始，网页版 UI 应作为桌面版唯一前端基线。**

不要再维护"网页版一套 UI、桌面版另一套旧 UI"。

推荐架构：

``` text
Web UI (HTML/CSS/JavaScript)
        │
        │ Tauri invoke / bridge
        ▼
Tauri 2
        │
        ▼
Rust backend
        │
        ▼
SQLCipher encrypted local database
```

前端负责：

-   页面；
-   modal；
-   表单；
-   日程视图；
-   任务看板；
-   UI state；
-   数据编辑体验；
-   即时刷新。

Rust/Tauri 后端负责：

-   用户认证；
-   密码验证；
-   SQLCipher；
-   workspace 持久化；
-   审计；
-   自动锁定支持；
-   备份；
-   文件系统访问；
-   安全边界。

------------------------------------------------------------------------

## 3. 项目目录结构

Muse 接手后首先确认实际 ZIP 内容。预期大致结构：

``` text
TherapistWorkstation-V3.1.0-WebUI-SQLCipher/
│
├─ build-windows.bat
├─ package.json
├─ README.md
│
├─ web/
│  └─ index.html
│
└─ src-tauri/
   ├─ Cargo.toml
   ├─ Cargo.lock
   ├─ build.rs
   ├─ tauri.conf.json
   │
   ├─ icons/
   │  └─ icon.ico
   │
   ├─ capabilities/
   │
   └─ src/
      ├─ main.rs
      └─ lib.rs
```

如果实际结构不同，以代码为准，但不要无理由重构目录。

------------------------------------------------------------------------

## 4. 技术栈

### Desktop shell

-   Tauri 2
-   Rust
-   Windows WebView2

### Frontend

目前刻意保持轻量：

-   HTML
-   CSS
-   Vanilla JavaScript

当前不是 React/Vue/Svelte 项目。

**不要为了"现代化"而立即迁移前端框架。**

先把现有产品做到稳定、可测试、可持久化，再考虑框架迁移。

### Database

目标：

-   SQLite-compatible local DB
-   SQLCipher encryption

历史 Electron 版本曾使用：

``` text
better-sqlite3-multiple-ciphers
```

Tauri/Rust 版本则由 Rust backend 负责数据库访问。

------------------------------------------------------------------------

## 5. Windows 开发环境

历史上已成功使用：

``` text
Node.js 22.x
npm 10.x
Rust stable
Cargo
Visual Studio 2022 Build Tools
MSVC x64 toolchain
WebView2
Strawberry Perl
```

曾验证过的机器输出包括：

``` text
node -v
v22.23.2

npm -v
10.9.8

rustc 1.97.1
```

### Visual Studio Build Tools

需要 C++ build tools/MSVC。

历史上曾遇到：

``` text
where.exe link
INFO: Could not find files...
```

因此如果 native compilation 失败，要检查 MSVC/Windows SDK，而不是只检查
Rust。

### PowerShell execution policy

PowerShell 可能阻止：

``` powershell
npx tauri ...
```

历史 workaround：

``` powershell
npx.cmd tauri ...
```

不要为了这个问题要求用户全局放宽 PowerShell security policy。

------------------------------------------------------------------------

## 6. Windows 构建

项目目标是让非开发者尽量可以直接运行：

``` powershell
.\build-windows.bat
```

理想 build pipeline：

``` text
1. npm install
2. cargo check
3. tauri build
4. verify NSIS output
```

Tauri Windows installer 使用 NSIS。

历史配置正确字段是：

``` json
"nsis": {
  "installMode": "currentUser",
  "displayLanguageSelector": false
}
```

不是：

``` json
"installerMode"
```

### Tauri global API

纯 HTML frontend 曾依赖：

``` javascript
window.__TAURI__.core.invoke
```

因此配置曾需要：

``` json
"withGlobalTauri": true
```

Muse 应确认当前代码是否仍依赖 global Tauri API。

更长期的目标是建立一个明确、单一的 frontend adapter，而不是 UI
到处直接访问 `window.__TAURI__`。

------------------------------------------------------------------------

## 7. Windows GUI subsystem

历史上正式程序启动时曾出现黑色 console window。

Release GUI binary 应避免 console window。

检查 `main.rs` 是否有正确的 Windows subsystem 配置，例如：

``` rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
```

不要让关闭 console 导致整个 GUI 应用退出。

------------------------------------------------------------------------

## 8. 产品语言与格式要求

### 全中文 UI

除技术诊断信息外，面向用户的界面全部中文。

不要出现无必要的：

-   SQLite
-   SQLCipher
-   Rust
-   Tauri
-   JSON
-   database schema

例如用户可见文案应是：

``` text
数据保存在本地数据库，位于程序同目录
```

而不是：

``` text
数据保存在本地 SQLite 数据库
```

### 日期

所有业务日期统一：

``` text
YYYY-MM-DD
```

例如：

``` text
2026-10-25
```

包括：

-   出生年月日；
-   首次咨询日期；
-   日程；
-   咨询记录；
-   截止日期；
-   收费日期等。

在 UI 中尽量使用：

``` html
<input type="date">
```

让用户直接选择日期，而不是手工输入。

### 议题

原文：

``` text
标签（用逗号分隔）
```

改为：

``` text
议题（用逗号分隔）
```

必须同时识别：

``` text
,
，
```

即英文逗号和中文全角逗号。

------------------------------------------------------------------------

## 9. 认证与本地多账户

产品定位：

> 单机 + 本地多个账户。

不是：

-   SaaS multi-tenant；
-   group practice server；
-   LAN database sharing；
-   多台电脑同步。

### 首次启动

如果没有用户：

``` text
创建管理员账户
```

创建时：

-   用户名；
-   密码；
-   确认密码。

数据库加密密码**不要再单独要求用户设置**。

历史产品决策：

> 用户账户密码同时用于数据库解锁/加密流程，避免出现第二个"设置数据库密码"页面。

### 密码 UI

密码输入应支持：

-   眼睛图标显示/隐藏；
-   Caps Lock 提醒；
-   清晰错误提示；
-   不要点击后毫无反应。

### 管理员创建

历史重大 bug：

``` text
点击“创建管理员账户”完全没反应
```

根因曾包括：

-   Tauri bridge 未暴露；
-   frontend 仍使用 Electron `window.desktopDB`；
-   inline event / CSP；
-   async invoke model 不匹配。

当前版本必须重新回归测试。

------------------------------------------------------------------------

## 10. Frontend ↔ Tauri bridge

历史 Electron UI 使用过：

``` javascript
window.desktopDB
```

Tauri migration 时曾建立 compatibility bridge。

历史 command 包括：

``` text
startup_status
startup_setup
startup_login
db_get_state
db_set_state
```

以及与以下功能相关的 commands：

-   prefs；
-   backup；
-   audit；
-   users；
-   open path；
-   open external；
-   lock/session。

Muse 必须打开当前：

``` text
web/index.html
src-tauri/src/lib.rs
```

逐一核对：

``` text
frontend invoke name
↕
#[tauri::command]
↕
invoke_handler registration
```

禁止出现：

``` text
前端调用 command A
Rust 实现 command B
```

而 UI 不显示任何错误。

### Bridge failure UX

如果 Tauri API 不存在，页面必须明确显示：

``` text
桌面后端连接失败
```

不要静默 `return`。

------------------------------------------------------------------------

## 11. 最重要的架构问题：异步持久化

这是历史上大量 bug 的根源。

Electron 时代 UI 有很多：

``` javascript
if (save()) {
  ...
}
```

但 Tauri：

``` javascript
invoke(...)
```

是异步 Promise。

错误模式：

``` javascript
const ok = window.desktopDB.setState(...);

if (ok === true) {
  ...
}
```

如果 `setState()` 返回 Promise，这个判断就是错的。

### 正确目标

所有真正的数据写入应遵循：

``` javascript
modify in-memory state
        ↓
await persist()
        ↓
Rust / SQLCipher confirms commit
        ↓
update UI
        ↓
show 已保存
```

失败：

``` text
保持用户输入
显示具体错误
不要关闭 modal
不要显示“已保存”
```

### 建议建立唯一 persistence API

例如：

``` javascript
async function persistWorkspace(reason = '') {
  // one implementation only
}
```

所有 CRUD 都调用它。

不要让：

``` text
saveClient()
saveEvent()
saveSession()
saveTask()
saveNote()
saveGoal()
```

各自实现不同的 persistence behavior。

------------------------------------------------------------------------

## 12. Workspace 数据模型

网页版主要围绕一个前端 state object 工作，历史变量名：

``` javascript
S
```

常见 collections 包括：

``` text
clients
sessions
sessionDrafts
events
tasks
goals
quickNotes
noteDrafts
finances
recentViews
referrals
referralLinks
templates
plans
settings
backupMeta
```

V3.1 方向是：

> 将完整 workspace JSON 可靠保存到 SQLCipher。

这是有意设计。

原因是早期尝试把每个模块映射成独立 SQL table 时，经常因为 frontend
新增字段但 Rust schema 没同步，导致：

-   咨询记录消失；
-   随手记保存失败；
-   自定义清单丢失；
-   plans 丢失；
-   drafts 丢失；
-   新功能字段没有 persistence。

### 建议

短期：

``` text
encrypted workspace snapshot + metadata/audit tables
```

优先保证数据完整性。

长期如果要 normalize relational schema，再单独设计 migration system。

不要边开发 UI 边临时扩展 SQL schema。

------------------------------------------------------------------------

# 13. 功能模块

## 13.1 今日工作台

目标：显示今天最需要处理的内容。

应包括：

-   今日心理咨询；
-   今日其他活动；
-   待办任务；
-   待收费；
-   建档未完成；
-   已发生但还没有咨询记录的心理咨询。

### "待补咨询记录"

非常重要。

如果：

``` text
心理咨询 event date/time 已经过
AND
没有对应 completed session record
```

今日工作台应该显示：

``` text
待补记录
```

用户应能直接进入咨询记录编辑。

### 备份提醒

不要在刚创建账户、没有任何业务数据时显示：

``` text
建议备份数据
还没有记录过完整备份……
```

只有真正存在业务数据且尚未备份时才显示。

------------------------------------------------------------------------

## 13.2 来访者

核心字段包括：

-   姓名；
-   出生年月日；
-   性别（如保留）；
-   联系方式；
-   首次咨询日期；
-   议题；
-   状态；
-   备注；
-   建档清单。

### 出生年月日

必须使用 date picker。

### 建档清单

默认项目之外，必须允许：

``` text
＋ 添加自定义项目
```

每项可：

-   添加；
-   勾选；
-   取消勾选；
-   修改；
-   删除。

自定义清单必须持久化。

### 归档

归档来访者必须：

-   从 active client list 消失；
-   出现在"归档"；
-   可恢复；
-   不能因为筛选器问题而"看似丢失"。

------------------------------------------------------------------------

## 13.3 日程

### 心理咨询 event

如果选择关联来访者：

默认标题：

``` text
心理咨询
```

optional mode：

``` text
视频
面讯
电话
```

时区可选。

默认：

``` text
北京时间
```

### 即时刷新

新增/编辑活动保存成功后：

``` text
日程当前视图立即更新
今日工作台立即更新
```

不能要求用户：

-   切换页面；
-   修改筛选；
-   重启程序。

### 从日程直接记录咨询

如果是已关联来访者的心理咨询：

应提供：

``` text
填写咨询记录
```

如果已经存在记录：

``` text
查看 / 编辑咨询记录
```

------------------------------------------------------------------------

## 13.4 咨询记录

这是最高优先级模块之一。

页面至少有：

``` text
全部记录
待补记录
```

### 保存

保存完成记录后必须：

1.  SQLCipher commit 成功；
2.  当前咨询记录列表立即出现；
3.  对应"待补记录"消失；
4.  今日工作台同步更新；
5.  重启后仍存在。

### 草稿

支持：

``` text
sessionDrafts
```

自动保存草稿时必须区分：

``` text
草稿
已完成
已锁定
```

不要把 autosave draft 当成 completed clinical note。

### 从前次咨询记录复制

按钮：

``` text
从前次咨询记录复制
```

必须：

-   找同一来访者；
-   日期早于当前记录；
-   排除当前记录本身；
-   找最近一次有效咨询记录；
-   没有前次记录时给出明确提示。

不能点击无反应。

### 锁定

如果支持记录锁定：

-   locked record 默认只读；
-   重新编辑应有明确 action；
-   修改已锁定记录应进入审计。

------------------------------------------------------------------------

## 13.5 咨询目标

必须支持：

-   新建；
-   编辑；
-   删除/归档（如设计存在）；
-   关联来访者；
-   保存后立即显示；
-   重启后存在。

历史 bug：

``` text
点击保存没有反应
```

必须加入 regression test。

------------------------------------------------------------------------

## 13.6 随手记

随手记是临时工作笔记，不等同正式咨询记录。

字段可包括：

-   标题；
-   内容；
-   关联来访者（optional）；
-   议题；
-   颜色；
-   置顶。

当前 UI 方向是卡片式 / 瀑布流。

### 必须测试

-   无关联来访者也能保存；
-   有关联来访者能保存；
-   保存后立即出现；
-   搜索；
-   筛选；
-   置顶；
-   重启后存在。

历史 bug：

``` text
输入框不能输入
保存无反应
清单空白
```

不要假定已经完全解决。

------------------------------------------------------------------------

## 13.7 任务看板

状态建议：

``` text
待处理
进行中
已完成
```

### 必须同时支持

1.  dropdown 修改状态；
2.  drag & drop。

### 即时 UI

修改后：

``` text
state update
→ persist
→ rerender board
```

不允许：

``` text
修改成功
但只有重启程序后才看到新状态
```

### 初次进入

任务看板第一次打开就必须 render。

历史 bug：

``` text
刚进入页面完全空白
切换筛选后才出现任务
```

### Drag & Drop

历史上尝试过：

-   HTML5 drag/drop；
-   pointer fallback。

Muse 应根据 Tauri WebView2 实测选择稳定方案。

验收：

``` text
拖任务 A
→ 放到“进行中”
→ 卡片立即移动
→ reload/restart
→ 仍在“进行中”
```

### client filter

"全部来访者"默认必须显示所有任务。

不能要求先选择某个来访者才看到任务。

------------------------------------------------------------------------

## 13.8 收费

收费与心理咨询 event 可以关联。

至少支持：

-   client；
-   date；
-   amount；
-   status；
-   method；
-   eventId。

常见状态：

``` text
待收
已收
```

今日工作台可显示待收费。

------------------------------------------------------------------------

## 13.9 最近查看

必须记录真正发生的访问行为。

不能只是空页面。

建议记录：

``` text
clientId
timestamp
resource type
```

避免记录敏感正文到 recent log。

------------------------------------------------------------------------

## 13.10 全局搜索

搜索应覆盖合理业务字段，例如：

-   来访者姓名；
-   议题；
-   咨询记录；
-   随手记；
-   任务；
-   日程；
-   转介资源。

注意隐私模式下结果显示。

------------------------------------------------------------------------

## 13.11 转介网络

用于保存转介资源。

可能字段：

-   姓名/机构；
-   类型；
-   specialty；
-   insurance；
-   location；
-   phone；
-   email；
-   notes；
-   favorite。

------------------------------------------------------------------------

## 13.12 数据中心

应包含：

-   手动完整备份；
-   自动备份状态；
-   恢复；
-   数据位置；
-   必要的数据导出/导入。

不要把技术数据库细节直接暴露给普通用户。

------------------------------------------------------------------------

# 14. 自动保存

用户明确希望：

> 输入的数据可以自动保存，避免忘记点保存。

但必须区分两类数据。

### 表单草稿

可以 debounce autosave：

``` text
500–1500 ms after change
```

保存为 draft。

### 正式咨询记录

不要因为用户打了几个字就自动把它标成：

``` text
已完成
```

应该：

``` text
autosave → 草稿
explicit action → 完成/锁定
```

### UI

建议显示：

``` text
正在保存…
已保存
保存失败
```

不要用假的成功状态。

------------------------------------------------------------------------

# 15. 自动锁定

这是安全核心功能。

用户希望"强化自动锁定"。

要求：

-   configurable inactivity timeout；
-   inactivity 而不是单纯页面打开时间；
-   mouse/keyboard/pointer activity reset timer；
-   锁定后敏感 UI 不可查看；
-   解锁需要当前用户密码；
-   不应该仅用前端 overlay 假装锁定；
-   锁定/解锁写审计日志。

安全页面应显示：

``` text
当前用户
自动锁定状态
最近审计日志
```

------------------------------------------------------------------------

# 16. 安全审计

历史要求：

> 安全与审计页面可查看当前用户、自动锁定状态、最近 300 条审计日志。

审计事件建议包括：

``` text
login_success
login_failure
logout
lock
unlock
user_created
user_disabled
password_changed
backup_created
backup_restored
client_created
client_archived
session_completed
session_unlocked/reopened
security_settings_changed
```

### 不可随意修改

"不可随意修改的审计日志"不等于绝对不可篡改。

建议：

-   append-only application API；
-   hash chaining；
-   sequence number；
-   timestamp；
-   actor；
-   event type；
-   metadata；
-   previous hash；
-   current hash。

不要把完整咨询记录正文写进 audit log。

### UI

显示最近 300 条。

如果没有日志：

``` text
暂无审计记录
```

不要显示空白页面。

------------------------------------------------------------------------

# 17. 备份

项目已经讨论过自动备份。

目标：

-   encrypted database backup；
-   configurable retention；
-   manual backup；
-   automatic backup；
-   backup status；
-   restore workflow。

### 自动备份

建议：

-   应用正常退出前；
-   或每天首次成功写入后；
-   或达到一定时间间隔。

避免每次 keystroke 复制整个数据库。

### 数据为空时

不要提示：

``` text
建议备份数据
```

------------------------------------------------------------------------

# 18. 数据位置

历史产品文案要求：

``` text
数据保存在本地数据库，位于程序同目录
```

Muse 必须先确认当前 Tauri 实际数据库位置。

如果技术上为了 Windows permissions / NSIS 安装安全，数据库实际放在：

``` text
%LOCALAPPDATA%
```

则不要用错误文案声称"程序同目录"。

二者必须一致：

``` text
实际 implementation
=
用户可见文案
```

如果继续使用安装目录旁的数据库，要认真评估：

-   Program Files write permissions；
-   multi-user Windows account；
-   backup；
-   portable mode；
-   uninstall data retention。

------------------------------------------------------------------------

# 19. 不要使用 LAN 共享数据库

历史上讨论过：

``` text
把数据库放在局域网共享文件夹同步
```

最终决定：

> 不做。

不要让多个电脑直接打开同一个 SQLite/SQLCipher 文件。

当前产品：

``` text
single machine
local multiple accounts
```

------------------------------------------------------------------------

# 20. 安全边界

Muse 不应把"HIPAA secure"当成单一技术开关。

代码层至少需要：

-   encrypted at rest；
-   password hashing/KDF；
-   no plaintext passwords；
-   least privilege；
-   auto lock；
-   audit；
-   backup；
-   error handling；
-   no PHI in logs；
-   CSP；
-   no arbitrary remote content；
-   no unsafe shell execution；
-   no hardcoded encryption key；
-   secure update/signing strategy。

### Password/KDF

确认实际 Rust 实现。

优先使用现代 password hashing/KDF，例如：

``` text
Argon2id
```

或当前经过审查的等价方案。

不要直接：

``` text
SHA256(password)
```

当密码 hash。

### Database key

不要 hardcode。

不要写入 frontend JS。

------------------------------------------------------------------------

# 21. CSP 与 inline handlers

当前 Web UI 历史上大量使用：

``` html
onclick="..."
onchange="..."
ondragstart="..."
```

这曾与 Tauri CSP 冲突。

为了快速恢复 UI，历史版本曾放宽 `unsafe-inline`。

这不应成为最终安全设计。

长期建议：

``` text
remove inline handlers
→ addEventListener
→ tighten CSP
```

但不要一次大规模重写导致所有 UI 再次失效。

建议渐进迁移，并有 automated regression tests。

------------------------------------------------------------------------

# 22. 历史重大问题

Muse 接手时必须知道这些坑已经出现过。

### Electron native ABI mismatch

历史：

``` text
better_sqlite3.node
compiled NODE_MODULE_VERSION 136
Node required 127
```

这是 Electron ABI 与 Node ABI 不同。

Tauri 版不应重新引入 Electron native module。

------------------------------------------------------------------------

### electron-builder symlink privilege

曾出现：

``` text
Cannot create symbolic link
A required privilege is not held by the client
```

属于旧 Electron build pipeline。

Tauri 项目不要重新依赖这套 packaging。

------------------------------------------------------------------------

### Tauri config

曾错误使用：

``` json
"installerMode"
```

正确：

``` json
"installMode"
```

------------------------------------------------------------------------

### Missing icon

曾出现：

``` text
icons/icon.ico not found
```

确保 repository 包含 icon。

------------------------------------------------------------------------

### OpenSSL Windows compilation

曾反复出现：

``` text
openssl-sys
nmake.exe failure
```

如果当前 SQLCipher crate 仍强制 source-build OpenSSL，需要评估是否能减少
Windows native build friction。

不要在没有必要的情况下引入新的 OpenSSL dependency。

------------------------------------------------------------------------

### 中文路径

历史构建路径：

``` text
C:\Users\...\Downloads\心理咨询师工作台_...
```

native build/debug 时容易增加变量。

开发建议：

``` text
C:\TherapistWorkstation
```

短英文路径。

------------------------------------------------------------------------

# 23. 当前最重要的已知风险

当前 V3.1 是新的整合基线，**不要视为 production-ready**。

必须重点验证：

1.  Web UI 是否真正全部使用 SQLCipher persistence；
2.  是否还有 localStorage 写业务数据；
3.  所有 `save()` 是否正确 await；
4.  咨询记录保存后是否立即显示；
5.  随手记是否保存；
6.  咨询目标是否保存；
7.  任务首次进入是否 render；
8.  dropdown 状态是否即时更新；
9.  drag/drop 是否即时更新；
10. 日程保存是否即时刷新；
11. archive 是否即时显示；
12. recent views 是否工作；
13. audit page 是否工作；
14. auto lock 是否工作；
15. backup/restore 是否真实可用；
16. restart 后数据是否完整；
17. wrong password 是否无法解密；
18. 多本地用户权限是否隔离到设计预期；
19. application errors 是否会显示，而不是"点击没反应"。

------------------------------------------------------------------------

# 24. Muse 第一阶段任务：不要先加新功能

第一阶段目标：

> **把 V3.1 做成稳定 baseline。**

顺序建议：

### Step 1 --- Code audit

检查：

``` text
web/index.html
src-tauri/src/lib.rs
src-tauri/src/main.rs
src-tauri/Cargo.toml
src-tauri/tauri.conf.json
build-windows.bat
```

输出：

``` text
architecture map
invoke map
persistence map
security findings
build findings
```

### Step 2 --- Build cleanly

在：

``` text
C:\TherapistWorkstation
```

从 clean checkout/build 验证：

``` text
npm install
cargo check
tauri build
```

### Step 3 --- Runtime diagnostics

开发 build 必须可以看到：

-   frontend exceptions；
-   failed invoke；
-   Rust error；
-   DB error。

用户 release UI 则显示中文可理解错误。

### Step 4 --- Persistence refactor

建立唯一：

``` javascript
await persistWorkspace()
```

并逐个迁移 CRUD。

### Step 5 --- Render/update model

每次 mutation 后：

``` text
persist
→ rerender affected views
```

不要依赖：

``` text
用户切换页面
用户切换筛选
重启程序
```

### Step 6 --- Regression test

完成下面验收清单。

------------------------------------------------------------------------

# 25. 必须通过的 Smoke Test

使用**虚构测试数据**。

## Account

-   [ ] 首次启动出现创建管理员；
-   [ ] 创建管理员成功；
-   [ ] 密码显示/隐藏；
-   [ ] Caps Lock 提醒；
-   [ ] 退出；
-   [ ] 正确密码登录；
-   [ ] 错误密码拒绝；
-   [ ] 自动锁定；
-   [ ] 解锁。

## Client

-   [ ] 新建来访者；
-   [ ] DOB date picker；
-   [ ] first session date picker；
-   [ ] 中文逗号议题；
-   [ ] 英文逗号议题；
-   [ ] 自定义建档项；
-   [ ] 勾选自定义项；
-   [ ] 编辑；
-   [ ] 归档；
-   [ ] 归档页面立即出现；
-   [ ] 恢复。

## Calendar

-   [ ] 新建普通活动；
-   [ ] 保存后立即出现；
-   [ ] 新建心理咨询；
-   [ ] 默认标题"心理咨询"；
-   [ ] client optional；
-   [ ] mode 视频/面讯/电话；
-   [ ] timezone；
-   [ ] 默认北京时间；
-   [ ] 从 event 创建咨询记录。

## Session

-   [ ] 新建咨询记录；
-   [ ] 保存后立即出现在全部记录；
-   [ ] restart 后存在；
-   [ ] 已发生 event 无记录 → 待补；
-   [ ] 补记录后待补消失；
-   [ ] 从前次记录复制；
-   [ ] draft autosave；
-   [ ] completed 与 draft 不混淆；
-   [ ] lock/read-only。

## Quick Notes

-   [ ] 无 client 保存；
-   [ ] 有 client 保存；
-   [ ] 保存后立即出现；
-   [ ] restart 后存在；
-   [ ] 搜索；
-   [ ] 筛选；
-   [ ] 置顶。

## Goals

-   [ ] 新建；
-   [ ] 保存后立即出现；
-   [ ] 编辑；
-   [ ] restart 后存在。

## Tasks

-   [ ] 初次进入即显示；
-   [ ] 新建；
-   [ ] 无 client；
-   [ ] 有 client；
-   [ ] dropdown 改状态立即移动；
-   [ ] drag/drop 立即移动；
-   [ ] restart 后状态保持；
-   [ ] "全部来访者"显示全部任务。

## Finance

-   [ ] 新建；
-   [ ] event linked fee；
-   [ ] 标记已收；
-   [ ] 今日待收费同步。

## Recent

-   [ ] 打开 client 后产生 recent view；
-   [ ] recent page 非空；
-   [ ] 不记录正文 PHI。

## Audit

-   [ ] login；
-   [ ] failed login；
-   [ ] lock/unlock；
-   [ ] backup；
-   [ ] client/session security-sensitive changes；
-   [ ] 页面显示最近 300 条；
-   [ ] hash-chain verify（如当前实现存在）。

## Backup

-   [ ] 无数据时不提示；
-   [ ] 有数据后可手动备份；
-   [ ] 自动备份；
-   [ ] restore；
-   [ ] restore 后 workspace 完整。

------------------------------------------------------------------------

# 26. UI 改良方向

保持当前视觉语言，不要把产品改成 generic admin dashboard。

目标：

-   专业；
-   安静；
-   低认知负荷；
-   中文信息密度适中；
-   clinical workflow first。

### 建议统一

Buttons：

``` text
Primary
Secondary
Danger
Icon
```

Status：

``` text
成功
警告
错误
草稿
已锁定
```

Form：

``` text
label
help text
validation
error
```

### Modal

所有 modal：

-   Esc；
-   close；
-   dirty state warning；
-   保存中禁止重复点击；
-   save error 不关闭。

### Toast

不要用 toast 代替关键错误。

适合 toast：

``` text
已保存
已复制
已完成
```

不适合仅 toast：

``` text
数据库无法写入
备份失败
认证失败
```

------------------------------------------------------------------------

# 27. Accessibility

至少保证：

-   keyboard navigation；
-   focus visible；
-   Enter/Space activation；
-   semantic buttons；
-   labels；
-   modal focus management；
-   adequate contrast；
-   dark mode；
-   不仅靠颜色表达状态。

------------------------------------------------------------------------

# 28. Performance

数据量预期不是大型 EHR，但可能有多年记录。

避免每次 keypress：

``` text
serialize entire workspace
+
write DB
+
rerender entire application
```

建议：

-   debounce draft save；
-   affected-view render；
-   avoid unnecessary DOM rebuild；
-   backup 与 autosave 分离。

但在优化前优先保证数据正确。

------------------------------------------------------------------------

# 29. Logging / Error handling

开发模式：

``` text
console.error
Rust tracing/log
command name
error category
```

禁止记录：

-   session note content；
-   client full name（尽量避免）；
-   password；
-   encryption key；
-   full workspace JSON。

Release UI 应把错误转成中文，例如：

``` text
保存失败。数据尚未写入本地数据库，请不要关闭此窗口。
```

并提供：

``` text
重试
```

如果适用。

------------------------------------------------------------------------

# 30. Versioning

建议从当前：

``` text
3.1.0
```

继续：

``` text
3.1.1
3.1.2
...
```

bugfix 不要随意跳 major/minor。

只有完成明显 architecture milestone 再进入：

``` text
3.2
4.0
```

每个 build 应在：

``` text
package.json
Cargo.toml
tauri.conf.json
```

保持版本一致。

------------------------------------------------------------------------

# 31. Git 建议

如果还没有正式 repository，建立 Git repo。

至少：

``` text
main
develop (optional)
```

不要 commit：

``` text
node_modules/
src-tauri/target/
dist/
*.db
*.sqlite
*.backup
real client data
.env secrets
```

建议 `.gitignore` 明确覆盖这些内容。

每个可测试 release tag：

``` text
v3.1.0
v3.1.1
```

------------------------------------------------------------------------

# 32. 不要做的事情

Muse 接手后请避免：

1.  不要把项目重新改回 Electron；
2.  不要引入 LAN shared SQLite；
3.  不要为了方便把 encryption key hardcode；
4.  不要把 clinical data 写回 localStorage；
5.  不要一次性迁移 React/Vue；
6.  不要为了"修按钮"复制多套 persistence logic；
7.  不要用 `setTimeout(render, ...)` 当持久化修复；
8.  不要用 reload/restart 当 UI refresh 机制；
9.  不要静默吞掉 Promise rejection；
10. 不要声称软件已经 HIPAA compliant；
11. 不要使用真实来访者资料做开发测试；
12. 不要在日志中输出完整 workspace；
13. 不要破坏网页版现有功能来追求桌面化。

------------------------------------------------------------------------

# 33. 推荐的下一版定义

建议下一版：

``` text
Therapist Workstation V3.1.1
```

目标只做：

> **Desktop stabilization release**

Definition of Done：

-   clean Windows build；
-   no console window；
-   authentication works；
-   all CRUD persistence works；
-   all affected views update immediately；
-   restart persistence verified；
-   task drag/drop works；
-   session records work；
-   notes/goals work；
-   audit works；
-   auto-lock works；
-   backup works；
-   no business data in localStorage；
-   no uncaught frontend errors during smoke test。

完成这些以后，再开始新的 feature development。

------------------------------------------------------------------------

# 34. Muse 接手时第一条指令

建议直接给 Muse：

> 你现在接管"心理咨询师工作台"桌面项目。请先完整阅读 `HANDOFF.md` 和
> repository，不要立即重构或添加新功能。以 V3.1.0 为基线，先建立
> architecture/invoke/persistence map，并完成 Windows clean
> build。然后按照 HANDOFF.md 的 Smoke Test
> 对现有功能逐项回归。优先修复数据持久化、即时 UI
> 刷新、咨询记录、随手记、咨询目标、任务看板、审计、自动锁定和备份。任何修改都必须保持中文版
> Web UI 为唯一前端基线，并确保临床数据只进入本地加密数据库，不回退到
> localStorage。完成后提交 V3.1.1 stabilization
> build、变更日志和测试结果。

------------------------------------------------------------------------

# 35. 产品所有者偏好总结

开发过程中请持续遵守：

-   中文优先；
-   用户不希望频繁手改源码；
-   尽量提供完整可构建版本；
-   Windows 操作步骤要具体；
-   不要让用户重复排查已经排除的 Node/Rust 环境问题；
-   bug 应寻找共因，而不是逐个按钮打补丁；
-   数据保存后必须即时反映；
-   临床工作流比技术炫技重要；
-   软件应尽量减少咨询师忘记保存、找不到记录、状态不同步的风险；
-   本地多账户可以保留；
-   不做 group-practice 网络协作；
-   不做 LAN database sync；
-   桌面版以后应持续跟随同一个 Web UI 基线。

------------------------------------------------------------------------

## 最后说明

当前 V3.1.0 应被视为：

``` text
development / stabilization baseline
```

而不是：

``` text
production-ready clinical software
```

在使用真实来访者信息之前，至少完成本文的 Windows clean
build、功能回归、数据持久化测试、备份恢复测试、认证/锁定测试和安全审计检查。
