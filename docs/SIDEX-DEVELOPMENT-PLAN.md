# SideX 分批开发计划

对象：`chocolatedesue/sidex`（fork 自上游 `Sidenai/sidex`），默认分支 `main`，本计划基线 commit `24f925d`（v0.1.8，2026-10-13）。

目标：把「VS Code 的 workbench 搬到 Tauri」这件事补完整——优先补插件生态（扩展宿主 / 自定义编辑器）和调试器，同时把测试从「文本断言 + web smoke」推进到「Node 单测 + web e2e + 原生 GUI e2e」。

## 0. 现状（2026-10-14 实测）

| 项 | 结果 | 怎么测的 |
|---|---|---|
| 前端构建 | 通过，`vite build` 约 40 s（4 GB heap） | `NODE_OPTIONS=--max-old-space-size=4096 node node_modules/vite/bin/vite.js build` |
| TS lint | 0 error / 2 warning | `npx eslint 'src/**/*.ts'` |
| Prettier | **178 个文件不达标** | `npx prettier --check 'src/**/*.{ts,tsx,js,json}'` |
| 静态 smoke | `smoke:ux` 17/17 | `npm run smoke:ux` |
| 扩展宿主 | 是 **Node 边车** `src-tauri/extension-host/host.cjs`（5441 行，CommonJS），工作台侧是 `src/vs/workbench/contrib/extensions/browser/tauriExtensionHost.contribution.ts`（3334 行）；两者用自定义 `{type, params}` 协议通信 | 读代码 + `smoke-preview-and-md-diff.mjs` |
| 自定义编辑器 | `resolveCustomTextEditor` / `resolveCustomEditor` / `openCustomDocument` 已实现；自定义文档生命周期（dirty / save / saveAs / revert / backup）本次补齐 | 单测 `scripts/test-ext-host.mjs` |
| 工作台侧 customEditor | 本次从历史版本恢复整个 `contrib/customEditor` 模块（10 个文件，之前只剩 4 个 stub）并接线到 `workbench.common.main.ts` | `tsc --noEmit` 0 条 customEditor 错误 + `vite build` |
| 扩展主题贡献 | 本次修掉 `_syncDiskThemeExtensions` / `_registerDiskExtensionWithWorkbench` 未定义（调用即抛，被 catch 吞掉） | `tsc --noEmit` 从 10 条降到 7 条（消掉的正是这 3 条） |
| 原生 GUI e2e | `scripts/e2e/gui-smoke.sh`（Xvfb + openbox + xdotool + scrot），在 cc 上 9/9 | `npm run e2e:native` |
| Rust / Go 工具链 | tyy-237（本 agent 的常驻运行环境）没有 cargo / rustc / go；**cc（qzlab，8 核 31 GB）有** rustc 1.99.0 / go / docker / gh，构建与测试都在那跑 | `ssh cc` |

## 1. 测试策略（先定口径，各批次复用）

分四层，能往下走就不停在上层：

1. **Node 单测**：`node --test scripts/*.mjs`。扩宿主是纯 CommonJS，可在进程内直接驱动，不需要 Tauri / Rust / webview。已建 `scripts/test-ext-host.mjs`。
2. **web e2e**：Playwright 打 `dist/`（静态服）或 `vite preview`。覆盖工作台前端行为（命令、面板、编辑器）。
3. **原生 GUI e2e**：Xvfb + xdotool + 逐步截图，断言落在可观察结果（文件真写盘、面板真出现）。参照 LAB-820 在 Malgel 上的做法。需要能构建 Tauri 的机器。
4. **Rust**：`cargo test` / `clippy` / `fmt`，放 CI 或具备工具链的机器。

「完整」的含义：每个批次的功能都要有对应的第 1/2 层用例；涉及原生行为的补第 3 层。

## 2. 批次

### 批次 A —— 扩展宿主：自定义文档生命周期（本次已实现）

**范围**：`src-tauri/extension-host/host.cjs`。

- `openCustomDocument` 的返回值按 panel 和 resource 记账。
- 订阅 `CustomDocument.onDidChangeCustomDocument`，向工作台发 `customDocumentDirty` 事件（dirty 置位）。
- 新增协议处理：`saveCustomDocument` / `saveCustomDocumentAs` / `revertCustomDocument` / `backupCustomDocument` / `deleteCustomDocumentBackup`，分别调 provider 的同名方法；保存 / 另存 / 还原后清 dirty；另存会迁移 resource 索引。
- `customEditorClosed` 退订事件、`dispose()` 文档、清索引。

**验收标准**：`npm run test:ext-host` 全绿（12 条：resolve 两条路径、记账、dirty、save、按 resource save、saveAs 迁移、revert、backup+delete、close 清理、两种错误路径）。

**测试方式**：第 1 层。CI 新增 `node-ext-host` job（`.github/workflows/test.yml`）。

**没做**：工作台侧消费这些协议（见批次 B）。宿主侧接口先落地并被单测锁住。

### 批次 B —— 工作台侧自定义编辑器（本次已实现）

**范围**：`contrib/customEditor/` + `workbench.common.main.ts`。

移植时整个模块被删成 4 个 stub 文件，插件声明的 `customEditors` 在工作台侧没有落点。本次从 `18424e49`（打桩前的最后一版）恢复 10 个文件并接线：

- `customEditorInput.ts` / `customEditorInputFactory.ts`：`CustomEditorInput extends LazilyResolvedWebviewEditorInput`、`CustomEditorInputSerializer`、`ComplexCustomWorkingCopyEditorHandler`。
- `customEditors.ts`：`CustomEditorService`（能力注册、`openWith`、`getContributedCustomEditors`）。
- `customEditorModelManager.ts` / `customTextEditorModel.ts`：dirty / backup 模型。
- `contributedCustomEditors.ts` / `extensionPoint.ts`：`contributes.customEditors` 扩展点。
- `customEditor.contribution.ts` 注册进 `workbench.common.main.ts`（放在 Webview 段之前）。

这样 `CustomEditorInput` 又是真的 webview 编辑器输入，`mainThreadCustomEditors` 和编辑器标签协议拿到的是具体类型而不是 `any` stub。

**验收标准**：`tsc --noEmit` 无 customEditor 报错；`vite build` 通过。装一个 marketplace 预览插件后打开文件 → 编辑 → 标签出现未保存标记 → `Ctrl+S` 真写盘、标记消失（原生下验收）。

**测试方式**：第 2 层 + 第 3 层。

### 批次 C —— 扩展宿主 activate 完整性（本次修掉一个具体缺口）

**范围**：补齐宿主 API 面（`workspace.fs`、watcher 语义、`TreeDataProvider` 事件、`StatusBarItem`、`Decoration`、`secrets`、`tasks`、`Terminal` 事件、`workspace.applyEdit`），对照 VS Code 1.141 的 `vscode.d.ts` 逐项补。

本次先修掉一个具体缺口：`_syncDiskThemeExtensions` / `_registerDiskExtensionWithWorkbench` 被调用但从未定义，每次调用都抛异常并被外层 catch 吞掉，所以「让 marketplace 插件的图标 / 产品图标 / 配色主题可被 `workbench.iconTheme` 选中」这件事从来没生效。

- 新增 Tauri 命令 `extension_read_manifest_json`（原样返回 `package.json`）——Tauri 构建没有 `file://` 文件系统 provider，工作台自己读不到盘上的 manifest。
- 把盘上扩展读成 `IExtensionDescription`，和扩展服务自己的描述取并集，喂给 `themes` / `iconThemes` / `productIconThemes` 三个扩展点；在 `onDidChangeExtensions` 上重放，卸载时移除并重放。

**验收标准**：`tsc --noEmit` 消掉这 3 条错误；`cargo check` 通过；`npm run test:ext-host` 12/12。

**测试方式**：第 1 层 + 第 4 层（Rust 编译）。

**还没做**：上面列的其余宿主 API 补全（`workspace.fs`、watcher 语义等）仍待逐项对照补。

### 批次 D —— 调试器（DAP）

**范围**：`mainThreadDebugService.ts` + `crates/sidex-dap` + 宿主 `debugStarted` 之外的会话生命周期：`startDebugging` 返回 session、断点、单步、变量、调用栈、控制台。

**验收标准**：对一段 Node 脚本下断点、单步、看变量；`onDebug` 激活事件生效。

**测试方式**：第 1 层（DAP 编解码）+ 第 3 层（原生里真跑一次）。**未开始。**

### 批次 E —— 原生 GUI e2e 套件（本次已实现）

**范围**：`scripts/e2e/gui-smoke.sh`。Xvfb + openbox（让 webview 拿到焦点）+ xdotool 驱动 + scrot 逐步截图；断言落在可观察结果：窗口出现、workbench 真的画出内容（屏幕上的不同颜色数，空白窗口只有十几个）、命令面板可开、快速打开 `note.md`、输入后 `Ctrl+S` 真写盘（marker 进文件、原有行还在）。

**验收标准**：`npm run e2e:native` 在 cc 上 9/9 通过，截图存档在 `smoke-artifacts/e2e-native/`。CI 里加了 `Native GUI e2e` workflow（`e2e-native.yml`）。

**修过的假阳性**：命令面板那条断言原先在欢迎页取 before/after 截图，而欢迎页的空编辑器提示文字会自己轮换（"Show All Commands" / "Find in Files" / …），屏幕本来就变，所以不开面板也会 PASS（截图里根本没有面板）。改成先快速打开 `note.md`，等编辑器内容静止后再取前后两张，此时大差异只可能来自面板。

**踩到的两个坑**（都写进脚本注释/CI 注释）：

1. **构建方式**：`cargo build --release` 出来的二进制不会切到生产模式，启动时仍然去连 `http://localhost:1420`（dev URL），页面加载被取消、workbench 一片空白。必须走 `npm run build && npx tauri build --no-bundle`，二进制从 55.9 MB 变成 62.9 MB（dist 资产真的嵌进去了）。
2. **渲染**：Xvfb 下 WebKitGTK 默认合成路径画不出东西（窗口在、内容是空白矩形）。要 `WEBKIT_DISABLE_COMPOSITING_MODE=1` + `LIBGL_ALWAYS_SOFTWARE=1` + `WEBKIT_DISABLE_DMABUF_RENDERER=1`（脚本里已设）。

### 批次 F —— CI 与打包

**范围**：
- Prettier：178 个文件的差异。**先决定口径**——是收敛检查范围到 SideX 自写代码（`src/vs/workbench/contrib/sidex*`、`src/main.ts`、`scripts/`），还是全量格式化 `src/vs/**`。后者 diff 巨大且会伤上游合并，建议前者。
- `Lint Rust` / `Unused Dependencies` / `Security Audit`：在 CI 上跑一遍定位是上游既有债还是本仓引入。
- v0.1.5 的 `macos-arm64` 打包失败：在 CI 日志里定位。

**验收标准**：以上四项都能给出「红 / 绿 + 原因」，红的要么修，要么在 workflow 里显式标成已知债。

### 批次 G —— 与 VS Code 1.141 的贡献接线

**范围**：LAB-707 的差异清单里，SideX 已有目录但没接线的贡献（`callHierarchy`、`typeHierarchy`、`timeline`、`mergeEditor`、`multiDiffEditor`、`notebook`、`comments`、`interactive`、`update`、`accessibility`）。**注意：这些目录里多数文件本身是 stub**，接线前要先判断是「接线即可」还是「要真实现」——实测这一批几乎都是后者，工作量按各自贡献单独估。

**验收标准**：每个贡献有明确的「能用 / 不用」结论，能用的补 e2e。

## 3. 顺序与依赖

已完成：A（扩展宿主自定义文档生命周期）、B（工作台侧自定义编辑器恢复 + 接线）、C（主题贡献接线，宿主 API 其余项仍待补）、E（原生 GUI e2e）。

接着做：C 剩余项（`workspace.fs`、watcher 语义等宿主 API）→ D（调试器）→ F/G（CI 与打包、贡献接线）。D 现在可以在 cc 上真机验收；C 剩余项是纯宿主、无外部依赖。

## 4. 需要用户定的一件事

**Prettier 口径**：178 个文件的差异，是全量格式化 `src/vs/**`（diff 巨大，以后合上游很痛），还是把检查范围收到 SideX 自写的部分？我倾向后者。

算力已定：cc（qzlab）。
