# SideX 项目情况分析报告

| 字段 | 内容 |
|------|------|
| 日期 | 2026-10-13（Asia/Shanghai，UTC+8） |
| 主仓 tip | `mikasans/sidex` @ `eec8d471`（tag **v0.1.15**） |
| 本地主路径 | `/workspace/sidex-mikasans-fresh` |
| 对照仓 | `chocolatedesue/sidex`（本地 `/workspace/sidex`，tip `e871026` ≈ v0.1.12） |
| 撰写依据 | git log / tags、GitHub Releases & Actions、`CHANGELOG.md`、`docs/DEV_NOTES_*.md`、`CROSS_VALIDATION_REPORT.md`、`smoke-artifacts/`；**未臆造数字** |

---

## 1. 项目概况

### 1.1 是什么

SideX 是把 **VS Code workbench**（MIT 架构参考）跑在 **Tauri** 上的桌面编辑器：Rust 后端 + 系统 WebView（Linux WebKitGTK / macOS WKWebView / Windows WebView2），前端仍是 TypeScript workbench + Monaco + xterm。目标是去掉 Electron 自带 Chromium 的体积与内存税，保留编辑、终端、扩展市场、Markdown / PDF 等核心体验。

一句话对齐：`ARCHITECTURE.md` — Electron Main → Tauri Rust；Renderer → Webview；Extension Host → sidecar（仍在推进）。

### 1.2 仓库关系

| 仓库 | 可见性 / 角色 | tip（本报告时） | 备注 |
|------|----------------|-----------------|------|
| [chocolatedesue/sidex](https://github.com/chocolatedesue/sidex) | 原工作仓 | `e871026`（本地 tag 至 v0.1.12） | LAB-707 / 早期发布与交叉验证多在此 |
| [mikasans/sidex](https://github.com/mikasans/sidex) | **公开副本**（本轮主发布目标） | `eec8d471` / **v0.1.15** | 自 v0.1.7 起精简 Actions；v0.1.7→v0.1.15 主要在此迭代 |

两仓已分叉：mikasans 领先 chocolatedesue 约 **v0.1.13–v0.1.15**（UX / 终端 / 兼容快捷键），不宜假设两边 `main` 等价。

### 1.3 技术栈版本（仓库钉死值）

| 组件 | 版本 | 来源 |
|------|------|------|
| 应用版本 | **0.1.15** | `package.json` / `src-tauri/Cargo.toml` / `tauri.conf.json` |
| VS Code product | **1.141.0** | `src/vs/platform/product/common/product.ts` fallback；`index.html` splash |
| Tauri | **2.12.3** | `src-tauri/Cargo.toml`；`tauri-build` **2.7.2** |
| Tauri 插件（摘录） | log 2.10 / dialog 2.8 / shell 2.5 / single-instance 2.5.3 / deep-link 2.6.1 | 同上 + CHANGELOG |
| rustc / cargo（开发机） | **1.99.0** | `rustc --version`；workspace `rust-version = "1.99.0"` |
| Wasmtime | **49**（lazy Engine） | `src-tauri/Cargo.toml`；CHANGELOG 0.1.5 |
| 前端要点 | Vite **6.4.4**、Monaco **0.52.2**、`@xterm/xterm` **5.5.0**、`@embedpdf/snippet` **^2.15.1** | `package.json` |
| **未采用** | Tauri **3.0 alpha** | `docs/DEV_NOTES_UX_PERF.md` triage：**Skip** |

---

## 2. 版本时间线（v0.1.5 → v0.1.15）

提交哈希为本地 `git rev-list -n1 <tag>`；CI 为 `mikasans/sidex` Actions「Cloud build」结论（构建 job + attach）。时区换算：GitHub `Z` → 用户 CST（UTC+8）。

| Tag | Commit | 主要内容（据 CHANGELOG / commit subject） | CI（mikasans） |
|-----|--------|------------------------------------------|----------------|
| **v0.1.5** | `7a0af5ff` | rustc 1.99、Wasmtime 49、npm lock 同步 | 原仓发布线；mirror 从后续 tag 起 |
| **v0.1.6** | `1de3e75d` | Remote SSH 行为矩阵硬化；Open With / preview / MD Diff / Tauri 2.12 已在此前合入 | chocolatedesue Release 侧；见 DEV_NOTES_REMOTE_SSH |
| **v0.1.7** | `a1272c3c` | **mirror 精简 Actions**：仅留 `cloud-build` + `release`；去掉 audit/build/fmt/lint/test/udeps | Run [38335836398](https://github.com/mikasans/sidex/actions/runs/38335836398)：Linux/Win/macOS **成功**，**attach 失败**（`fatal: not a git repository`）→ Release **无资产** |
| **v0.1.8** | `3676f65d` | VS Code 1.141 density + frosted glass、splash、粘贴默认、窗口底色 `#111111` | [38336253096](https://github.com/mikasans/sidex/actions/runs/38336253096)：Linux/Win **Build 失败**（`--locked` / lock），macOS 成功；无资产 |
| **v0.1.9** | `2b1359ed` | EmbedPDF 同源 `pdfium.wasm`、Cargo.lock、CLI `--version` 不弹窗、startup windowMark | [38337764451](https://github.com/mikasans/sidex/actions/runs/38337764451)：三平台 Build **成功**，**attach 失败**；无资产 |
| **v0.1.10** | `092d6676` | cargo 产物白屏：`ensure-frontend-server` + Linux `SideX` wrapper；YAML 修正 | [38339231329](https://github.com/mikasans/sidex/actions/runs/38339231329)：三平台成功，**attach 失败**；无资产 |
| **v0.1.11** | `6b8107a4` | PDF 真画页 + Seti 默认图标（E2E 像素） | [38340730133](https://github.com/mikasans/sidex/actions/runs/38340730133)：Linux/Win **Build 失败**（`Cargo.lock` 与 `--locked`），macOS 成功；无资产 |
| **v0.1.12** | `e871026d` | 同步 `Cargo.lock`；attach 加 `-R $GITHUB_REPOSITORY` | [38341740855](https://github.com/mikasans/sidex/actions/runs/38341740855)：**全绿**（含 attach）→ 三平台资产挂 Release |
| **v0.1.13** | `26623d0c` | Tab connected/pill、Layout Density、watermark 可读、版本对齐 | [38343827105](https://github.com/mikasans/sidex/actions/runs/38343827105)：**全绿** + 资产 |
| **v0.1.14** | `5e96c580` | 终端：shell 探测 / fish SI / suggest；PTY IPC coalesce；smoothScrolling 对齐 VS Code 默认关 | [38344727882](https://github.com/mikasans/sidex/actions/runs/38344727882)：**全绿** + 资产 |
| **v0.1.15** | `eec8d471` | Win/Mac/Linux 终端与 CLI 路径、chord 5s、`cmdorctrl`、Ctrl+Y redo | [38348376445](https://github.com/mikasans/sidex/actions/runs/38348376445)：本报告撰写时 **仍 in_progress**；Release 页尚无资产 |

**有可下载安装包的 tag（mikasans）：** v0.1.12、v0.1.13、v0.1.14（各含 `linux-x86_64.tar.gz` / `windows-x86_64.zip` / `macos-arm64.dmg`）。v0.1.7–v0.1.11 多为构建或 attach 失败导致 Release 空壳。

macOS 默认产物为 **`.dmg`**（`57995403` / CLOUD-BUILD 文档）；Linux/Windows 为 `cargo build --release` + `dist/` 包装，**非**完整 `tauri build` 嵌入。

---

## 3. 功能模块现状

每项：**状态** · **证据** · **边界**。

### 3.1 Markdown WYSIWYG + Markdown Diff Editor

- **状态：** 可用（单编辑器 WYSIWYG + Diff 侧路）。
- **证据：** CHANGELOG（VS Code **1.141** `markdown-editor-out`）；`smoke:preview-md-diff` 证据 **22/22**（`/workspace/sidex/smoke-artifacts/preview-md-diff-evidence.json`）；E2E 截图 `docs/assets/e2e-md.png`。
- **边界：** inline `customEditorDiffs` 高亮 API 未移植（CHANGELOG）；MD 首开白屏在 CROSS_VALIDATION 早期标 PARTIAL，后续有 retainContext 等缓解。

### 3.2 EmbedPDF / PDF Preview

- **状态：** v0.1.11 起页面可绘制（此前工具栏有、画布空）。
- **证据：** `docs/DEV_NOTES_PDF_ICONS.md` — 白像素 **364443**，可见 “SideX EmbedPDF”；`docs/assets/e2e-pdf.png`；`smoke:pdf` / marketplace 证据含 `embedpdf.pixels`（`/workspace/sidex/smoke-artifacts/smoke-evidence.json` **9/9**）。
- **边界：** 曾依赖 CDN wasm → 改为同源 `/pdfium.wasm`（v0.1.9）；`page-width` 在 0×0 host 不恢复 → `fit-page`（v0.1.11）。Xvfb + Software GL 下早期曾误判「暗画布」。

### 3.3 Open With 对齐

- **状态：** 选择器 hope≈actual（去掉假 marketplace PDF、MD 双宿主重复）。
- **证据：** commit `421fc7e2`；CHANGELOG Open With 节；E2E `docs/assets/e2e-open-with.png`。
- **边界：** `DEV_NOTES_E2E_STARTUP.md`：在 **旧 staging dist** 上 Reopen With **PARTIAL**（picker 未清晰确认）。

### 3.4 Preview / customEditor 扩展运行时

- **状态：** 非 PDF `customEditors` 不再安装后空转；host 实现 `resolveCustomEditor` 等。
- **证据：** CHANGELOG preview 节；`smoke:preview-md-diff` **22/22**。
- **边界：** CROSS_VALIDATION / DEV_NOTES：完整扩展宿主 activate、部分 webview 路径仍浅；PDF 固定走内置 EmbedPDF。

### 3.5 Marketplace / Open VSX + 图标主题

- **状态：** siden + Open VSX 搜索 / gallery / install-by-id；可装 **vscode-icons**；默认 **vs-seti**。
- **证据：** `smoke:cli-icons` 在完整树证据 **15/15**（`/workspace/sidex/smoke-artifacts/cli-icons-evidence.json`）；E2E Explorer 彩色图标像素 **97+**（`DEV_NOTES_PDF_ICONS.md`）。
- **边界：** mikasans-fresh 精简 checkout 缺 `extensions/` 时本地 cli-icons 会少过（本机跑过 **7/11**）——以完整构建树 / CI `ensure-file-icon-theme` 为准。

### 3.6 默认 Seti 图标

- **状态：** 打包强制带 `theme-seti` + 非空 `builtin-extensions.js`（postbuild guard）。
- **证据：** v0.1.11 说明 + E2E `e2e-explorer-icons.png`。
- **边界：** 旧 staging 无 theme-seti 时 Explorer 仅文字。

### 3.7 CLI（`--install-cli`、Windows 路径）

- **状态：** `sidex`/`SideX` 早路径 `--help`/`--version`/`--install-cli`；Linux/mac → `~/.local/bin`；Windows → `%LOCALAPPDATA%\SideX\bin` + `;` PATH（v0.1.15）。
- **证据：** `smoke:compat` **18/18**；CHANGELOG 0.1.15；`scripts/install-cli.sh`。
- **边界：** 需指向带 early-CLI 的二进制；launcher 读 `package.json` 报版本。

### 3.8 Remote SSH

- **状态：** 内置 Remote Explorer + `sidex-remote`（russh）；远程 FS / PTY / 本地端口转发；Open VSX `jeanp413` **proposed API** 已开。
- **行为矩阵（`DEV_NOTES_REMOTE_SSH.md` 表格逐行统计）：** **55** 行 → **pass 50**（其中 **fixed 子集 22**）· **unsupported 5** · **fail 0**。文档汇总另写「70+ live/unit 绿」「~20 formerly broken」——含表外 live 覆盖，**不宜与 55 行表混为一谈**。
- **自动化：** live_ssh **44/44**；独立 `live_ssh_matrix` **45** tests；`smoke:remote-ssh` **39/39**（`remote-ssh-evidence.json`）。
- **边界（5 unsupported）：** OTP 式 kbd-interactive、反向端口转发、远程 file watching、recent hosts、jeanp413/MS server 安装+websocket。**无真实 UI 连远程的端到端**（见 §4）。

### 3.9 终端

- **状态：** shell 探测（`/etc/shells` + PATH，含 fish）；fish 不强 `-l` + `shellIntegration.fish`；`terminal.integrated.suggest.enabled` 默认 true；PTY→IPC coalesce（8ms / 64KB）+ `terminal_ack_data` 反压；smoothScrolling 跟 VS Code 默认 **false**；远程 PTY 后端（`57995403`）。
- **证据：** `smoke:terminal` **13/13**（本机现跑）；单元 `coalesce_reduces_emit_count`：100 小块 @64B 上限 → **`batched.len() <= 20`**（≥80% 减少）；keymap 等见 CHANGELOG。
- **边界：** 父会话口头「100→5 / 95%」**未**写进仓库断言；以测试 `<=20` 为准。

### 3.10 UX 对齐（1.141）

- **状态：** density / frosted glass（尊重减少透明）/ tab connected·pill / compact tabs / splash / watermark 主题色 / 窗口 `#111111`。
- **证据：** `smoke:ux` **30/30**；`docs/DEV_NOTES_UX_PERF.md` triage。
- **边界：** Copilot/Agent/Dev Container / 大批上游 leak cherry-pick / Tauri 3 / wry GPU 旗标 = **Skip/Later**。

### 3.11 跨平台 + 快捷键感应

- **状态：** v0.1.15 — Windows profiles/env、路径 basename、CLI 路径、chord **5s**、`cmdorctrl`/`option`、META→Cmd/Win、Win/Linux **Ctrl+Y** redo。
- **证据：** `smoke:compat` **18/18**；`sidex-keymap` **88** tests（`cargo test -p sidex-keymap -- --list`）。
- **边界：** 本机无原生 Win/mac GUI；跨平台靠静态 smoke + CI 构建产物。

### 3.12 AI 默认关闭

- **状态：** `sidex.chat.enabled` 默认 false；启动不拉 agent / 不探 :7433。
- **证据：** `startup-evidence.json`：`aiDefaultOff: true`，`web.noAgentPortProbe` ok；多份 DEV_NOTES 复核。

### 3.13 启动路径

- **状态：** `SIDEX_STARTUP_TRACE`；AI off；deep-link Linux `register_all` 延后；Wasmtime lazy。
- **证据：** 见 §5。
- **边界：** Linux/Win cloud 包依赖 `:1420` wrapper（§7）。

---

## 4. 测试与验证

### 4.1 npm smoke 脚本（最新口径）

| 脚本 | 包名 | 最新通过数 | 证据位置 / 备注 |
|------|------|------------|-----------------|
| `smoke:startup` | `scripts/smoke-startup.mjs` | **9/9** | `startup-evidence.json`（含 web+native 步） |
| `smoke:preview-md-diff` | `smoke-preview-and-md-diff.mjs` | **22/22** | `preview-md-diff-evidence.json` |
| `smoke:remote-ssh` | `smoke-remote-ssh.mjs` | **39/39** | `remote-ssh-evidence.json` |
| `smoke:cli-icons` | `smoke-cli-and-icons.mjs` | **15/15**（完整树） | `cli-icons-evidence.json`；缺 extensions 的 checkout 会掉 |
| `smoke:ux` | `smoke-ux-polish.mjs` | **30/30** | 本机 2026-10-13 重跑 |
| `smoke:pdf` | `smoke-marketplace-pdf.mjs`（+ ensure pdfium） | CHANGELOG / 证据 **8/8～9/9** 量级 | `smoke-evidence.json` **9/9**（含 pixels） |
| `smoke:terminal` | `smoke-terminal-ux-perf.mjs` | **13/13** | 本机重跑；0.1.14 文档曾写 12 |
| `smoke:compat` | `smoke-compat-keybind.mjs` | **18/18** | 本机重跑 |
| `smoke-interactive-web` | （未挂 package script 名，脚本存在） | **5/5** | `interactive-web-evidence.json` |

### 4.2 Rust 测试（文档 / list 已核实）

| 套件 | 结果 |
|------|------|
| `sidex-keymap` | **88** tests listed |
| `sidex-remote` live_ssh | **44/44**（需 `SIDEX_SSH_LAB`） |
| `sidex-remote` live_ssh_matrix | **45** tests（文档） |
| terminal `commands::terminal::tests` | coalesce / fish detect 等（CHANGELOG：terminal 4；cli 9） |
| 早期 CROSS_VALIDATION | `sidex-extensions` 101；`sidex-text` 295（0.1.4/0.1.5 时代记录） |

### 4.3 E2E（Xvfb 真机）

`docs/DEV_NOTES_E2E_STARTUP.md` + `docs/DEV_NOTES_PDF_ICONS.md`：Xvfb `:110` 起 `target/release/SideX`。

| 面 | 结果 |
|----|------|
| Explorer / 终端 / 调色板 / 开 `sample.md` | PASS |
| PDF 工具栏 + wasm | PASS；画布 v0.1.11 起像素 PASS |
| Open With | PARTIAL（旧 staging） |
| 截图 | `docs/assets/e2e-startup.png`、`e2e-workbench.png`、`e2e-terminal.png`、`e2e-md.png`、`e2e-pdf.png`、`e2e-explorer-icons.png`、`e2e-palette.png`、`e2e-open-with.png` |

### 4.4 明确未测 / 弱测

- **真实 Remote SSH UI 流程**（连公网/实验室机、开远程文件夹点击路径）——仅 lab sshd + Rust/smoke。
- **macOS / Windows 原生运行时行为**——CI 只保证 **构建与打包**；无本机 GUI 回归。
- **签名发布 / Gatekeeper / SmartScreen**——cloud包 **unsigned**（CLOUD-BUILD.md）。
- **完整扩展宿主 activate 矩阵、调试器、Jeanp413 server 协议**。
- **上游 Electron VS Code 全量 UI 对拍**（仅抽 1.141 体验点）。

---

## 5. 性能（有出处的数字）

| 指标 | 数值 | 条件 / 来源 | 注意 |
|------|------|-------------|------|
| Native window restore | **150–320ms**（典型）；另测 **243–421ms** | `SIDEX_STARTUP_TRACE`；E2E / ISSUES_PERF | 冷热差大 |
| Native setup complete（AI off） | **167–342ms**；中位约 **267ms**（三连跑） | 同上 | 不含前端首屏 |
| 冷首屏（墙钟，前端已在 `:1420`） | **~3.8s** | `DEV_NOTES_E2E_STARTUP.md` | 到「非纯色 + workbench 像素」 |
| Smoke native wall（修 windowMark 后） | **~411ms**；另一次 observed **829ms**（trace 内 335/351ms） | ISSUES_PERF / startup-evidence | smoke 轮询会放大 |
| Web DCL | **599ms**（E2E 会话）；曾见 **534–880ms** | startup-evidence / ISSUES_PERF | **同 staging dist 方差，不作 bundle 宣称** |
| Web workbench proxy | **980ms**；total **1579ms** | startup-evidence | 同上 |
| 更早 CROSS_VALIDATION web total | **~2312ms**；native setup **+515ms** | CROSS_VALIDATION_REPORT | 不同会话基线 |
| PTY coalesce | 100 chunk → **≤20** emits | `terminal.rs` 单元测试 | 文档「80%+」；非保证 5 |

**原则（与用户约定一致）：** 只做可交叉验证的重要项；web 时间波动不写成「优化收益」除非重新 `vite build` 对比。

---

## 6. CI / 发布

### 6.1 mikasans 精简流水线

| Workflow | 触发 | 作用 |
|----------|------|------|
| `cloud-build.yml` | `workflow_dispatch` + push tag **`v*`** | Linux x86_64 / Windows x86_64 / macOS arm64 **无签名**构建；tag 时 attach Release |
| `release.yml` | **仅** `workflow_dispatch` | 保留；上游签名/R2 路径本 mirror 通常无 secrets |

已删除：audit / build / fmt / lint-js / lint-rust / test / udeps 自动工作流（v0.1.7）。**普通 docs 推送不会触发 cloud-build**（仅 `v*` / 手动）。

### 6.2 历史失败根因（已修）

| 现象 | 根因 | 修复 |
|------|------|------|
| Linux/Win `cargo build --locked` 失败 | workspace `Cargo.lock` 落后（syn/aws-lc 等） | v0.1.9 / **v0.1.12** 再生 lock |
| attach 失败 `fatal: not a git repository` | attach job **无 checkout**，`gh release` 默认找 git remote | **`-R $GITHUB_REPOSITORY`**（v0.1.12） |
| 版本 bump 后再次 `--locked` 红 | 0.1.11 改版本未锁 | v0.1.12 |

### 6.3 产物形态

- macOS：**DMG**（默认）。
- Linux：`SideX` wrapper + `SideX.bin` + `dist/`（必须能起 `:1420`）。
- Windows：zip 同构思路。
- 放松 profile：`CARGO_PROFILE_RELEASE_CODEGEN_UNITS=16`、`LTO=false`（测速用，非 shipping 字节等同）。

---

## 7. 风险与已知问题 / 技术债（按优先级）

1. **高 — Linux/Windows cloud 包依赖 frontend server wrapper**  
   cargo 产物仍指 Vite `devUrl`；无 `:1420` 则白屏。长期应 `tauri build --no-bundle` 嵌入 frontendDist（`DEV_NOTES_E2E_STARTUP.md`）。

2. **高 — 双仓分叉**  
   mikasans **v0.1.15** vs chocolatedesue 停在 ~**v0.1.12**。文档/问题若混用 tip 会误判。

3. **中 — Remote SSH 产品完整度**  
   5 项 unsupported；无 VS Code Server 安装路径；UI E2E 缺失。

4. **中 — 扩展宿主覆盖面**  
   语言特性 / 非 PDF custom editor / activate 生命周期仍浅于 VS Code。

5. **中 — 跨平台原生验证缺口**  
   Win/mac 仅 CI 产物；快捷键与 shell 探测靠静态 smoke。

6. **中 — Open With 在旧 staging 上 PARTIAL**  
   需用新 dist / 云构建包复测。

7. **低 — Xvfb PDF 暗画布历史误判**  
   根因是 zoom/host 尺寸，不是「只能真机」；测试需像素断言（已补）。

8. **低 — 性能叙事纪律**  
   web DCL 波动易被误报为优化；需固定产物 + 多次中位数。

9. **低 — unsigned macOS DMG**  
   Gatekeeper / `xattr` 文档已有，对研究机可接受，对终端用户摩擦大。

10. **Later（triage）** — 上游 memory-leak cherry-pick、Tauri 3、wry GPU 旗标、Copilot 表面。

---

## 8. 建议下一步（优先级 + **估时为估计**）

| 优先级 | 项 | 估时（人日，估计） | 说明 |
|--------|----|-------------------|------|
| P0 | 等 **v0.1.15** cloud-build 收尾，确认三平台资产挂上 | 0.5（盯） | 撰写时仍 in_progress |
| P0 | Linux/Win 改为 `tauri build` 嵌入 dist，去掉对 `:1420` 的硬依赖 | **3–5** | 消白屏技术债 |
| P1 | 把 mikasans 变更同步回 chocolatedesue（或明确「以 mikasans 为准」） | **1–2** | 防双源 |
| P1 | Remote SSH：recent hosts + 一份 **UI** Playwright/手工清单 | **2–4** | 补产品闭环 |
| P1 | Win/mac 各装一版云产物，跑 CLI install + 终端 fish/pwsh + PDF 像素 | **2–3** | 交叉验证跨平台 |
| P2 | 扩展宿主：选 2–3 个高价值 Open VSX 扩展做 activate 矩阵 | **5–8** | 深度 > 广度 |
| P2 | 冷首屏：固定 release 二进制 + 前端，5 次中位；再决定是否动 defer/包体 | **2–3** | 有数再改 |
| P3 | jeanp413 server 路径 / 反向转发 / file watching | **8+** | 明确不做也行，写进 README |
| P3 | Tauri 3 / 上游 leak batch | **评估后再估** | triage 已标 Later |

---

## 附录 A — 关键文档索引

- `CHANGELOG.md`
- `CROSS_VALIDATION_REPORT.md`
- `DEV_NOTES_REMOTE_SSH.md`
- `DEV_NOTES_MD_WYSIWYG.md`
- `docs/DEV_NOTES_UX_PERF.md`
- `docs/DEV_NOTES_ISSUES_PERF.md`
- `docs/DEV_NOTES_E2E_STARTUP.md`
- `docs/DEV_NOTES_PDF_ICONS.md`
- `docs/DEV_NOTES_TERMINAL_UX_PERF.md`
- `docs/DEV_NOTES_COMPAT_KEYBIND.md`
- `docs/CLOUD-BUILD.md`
- `docs/assets/e2e-*.png`

## 附录 B — Remote SSH 矩阵计数说明

对 `DEV_NOTES_REMOTE_SSH.md` 中带 Status 列的数据行脚本计数（2026-10-13）：

- 总行数 **55**
- **pass 50**（含标注 `pass / fixed` 的 **22**）
- **unsupported 5**
- **fail 0**

若口头沿用「57 行 / 51 pass」，与当前表格差 1–2 行，**以本表计数与文档原文为准**。

---

*报告结束。数字均可回溯到上表「来源」列；后续版本请以新 tag 的 CHANGELOG / Actions 覆盖本节时间线。*
