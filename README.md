# dsh-peak-gate

> ⚡ DeepSeek Harness 峰谷计费闸门插件 · [GitHub 仓库](https://github.com/f20880479-lab/dsh-peak-gate) · MIT License
>
> 高峰时段每次发送消息前确认，可勾选「本次高峰段内不再提示」，或通过 `/peakgate` 指令排队到空闲时段（半价）自动发送；空闲时段不询问。

基于 DeepSeek 官方峰谷定价政策（2026-08-17 生效）：

| 时段 | 北京时间 | 价格 |
| --- | --- | --- |
| 高峰（工作日） | 09:00–12:00、14:00–18:00 | 原价（空闲价的 2 倍） |
| 空闲（其余时间） | 12:00–14:00、18:00–次日 09:00 | 半价 |
| 周末（周六、周日全天） | — | 半价（2026-08-23 起官方政策） |

## 功能

- **每次发送都确认**：高峰时段每次按 Enter 或点击发送按钮都会弹出确认卡片（不会直接发送）。
- **本次高峰段静音**：卡片上可勾选「本次高峰段内不再提示」——勾选后直到当前高峰段结束（12:00 或 18:00）都不再询问；下一个高峰段（如下午 14:00 段）会重新询问。静音对所有会话生效。
- **等到空闲时段（自动发送）**：卡片上选择后消息草稿被暂存，空闲时段（18:00 / 次日 09:00 / 周一 09:00）开始时自动以半价发送——真正实现“把任务等到空闲时段再开始工作”。
- **会话内待发送队列（悬浮窗口）**：右下角一枚 44px 悬浮球（带队列计数角标），点击展开为队列面板：
  - **只显示当前会话**的排队消息，工具栏可一键切换「全部会话」
  - **⬆ 立即发送**：不等待、即使高峰时段也直接发出该条（绿色按钮）
  - **↑↓ 调整发送顺序**（发送时严格按列表顺序执行）
  - **✎ 修改文本**（Enter 保存 / Esc 取消）、**✕ 删除单条**、**清空队列**
  - **可拖拽**：按住悬浮球或面板标题栏移动到任意位置，位置自动记忆
  - **四边四角可调大小**（像普通窗口），尺寸自动记忆
  - 点击面板外部自动收起为悬浮球；× 按钮同样可收起
  - 界面采用与 DSH 一致的深色主题样式
- **排队方式（无需记命令）**：高峰发送时在确认卡片上点「等到空闲时段（自动发送）」即自动入队；也可输入 `/peakgate` 指令（输入时自动弹出子命令提示条）：
  - `/peakgate hold 消息内容` —— 把该消息排入队列，空闲时段自动发送（半价）
  - `/peakgate list` —— 展开队列窗口 · `/peakgate remove 序号` —— 删除一条 · `/peakgate cancel` —— 清空队列
- **空闲时段零打扰**：空闲时段（含周末）普通发送完全不询问；指令仍可用。
- **安全兜底**：草稿被修改则自动取消暂存（不误发）；排队消息不会覆盖用户正在编辑的草稿；图片消息无法自动暂存时提示手动发送；关闭卡片仅取消本次发送并保留草稿。
- **不误伤**：运行中“停止”按钮、命令菜单/斜杠菜单弹窗、审批面板按钮、IME 中文输入、Shift+Enter 换行均不会被拦截。
- **设置项**：通用设置 → “高峰时段发送确认”（开关 + 当前计费档位与下次切换时间实时显示）。

## 安装

### 方式一：npm registry 直接安装（已发布，推荐）

```bash
dsh plugin --profile desktop add dsh-peak-gate
dsh plugin --profile web add dsh-peak-gate
```

然后确认 `dsh-peak-gate` 出现在对应 profile 的 `~/.dsh/profiles/<name>/package.json` 的
`dsh.profile.bundles` 中，**重启 DSH Desktop** 生效。

### 方式二：本地 link 安装（开发调试）

1. 在 profile 目录执行 `pnpm add link:<本包绝对路径>`
2. 在 profile `package.json` 的 `dsh.profile.bundles` 末尾追加 `"dsh-peak-gate"`
3. 重启 DSH Desktop

卸载：从 `dsh.profile.bundles` 移除该包名 → `pnpm remove dsh-peak-gate` → 重启。

## 使用

1. 重启 DSH Desktop 后，插件自动加载（浏览器端 bundle）。
2. 高峰时段（工作日 09:00–12:00、14:00–18:00，北京时间）发送消息 → 弹出确认卡片：
   - ☑ **本次高峰段内不再提示**（可选）：勾选后直到本段结束都不再询问（所有会话）。
   - **立即发送（高峰价）**：按当前价格发送。
   - **等到空闲时段（自动发送）**：取消本次发送，草稿暂存，空闲时段开始时自动发出（半价）。
   - **✕ 关闭**：取消本次发送、保留草稿（不静音，下次发送仍会询问）。
3. 不勾选时，高峰时段每次发送都会询问。
4. 空闲时段（其余时间、周末）发送消息 → 完全无打扰。
5. 任意时段输入 `/peakgate hold 消息内容` 后回车 → 消息入队（输入框被清空），空闲时段自动半价发送；`/peakgate list` 打开队列卡片管理（删除/清空）。指令不会触发高峰确认，也不发给模型。

## 配置

高级配置存于浏览器 localStorage（键 `dsh.peakGate.settings.v1`），可用 DevTools 修改：

```json
{
  "enabled": true,
  "timezone": "Asia/Shanghai",
  "peakWindows": [
    { "start": "09:00", "end": "12:00" },
    { "start": "14:00", "end": "18:00" }
  ],
  "offPeakWeekends": true
}
```

- `timezone`：计费时钟的 IANA 时区（默认北京时间）。
- `peakWindows`：工作日高峰窗口（24 小时制，`end` 为开区间）。
- `offPeakWeekends`：周末全天按空闲价（官方政策）。

其他 localStorage 键：`dsh.peakGate.muted.v1`（已静音的高峰段记录，形如 `2026-08-25|09:00-12:00`）、`dsh.peakGate.holds.v1`（暂存消息）。

## 开发

```bash
npm install        # 安装测试依赖（jsdom）
npm test           # 33 项集成测试 + 6 项 jsdom/React 真实渲染测试
```

包结构：

```
dsh-peak-gate/
├── package.json          # dsh.bundle.patch + dsh.client(platform web)
├── cordis.patch.yml      # 插入插件行（id: peak-gate）
├── lib/
│   ├── index.js          # host half（空 apply，占位行）
│   └── client.js         # browser half：全部功能（__ModuleLoader__ 格式）
└── test/
    ├── integration.test.mjs
    └── smoke.test.mjs
```

## 原理

- 客户端 bundle 经 `exports["./client"]` 由 web GUI 加载（`window.__ModuleLoader__.load`）。
- 在 `document` 捕获阶段监听 Enter/发送按钮点击，先于 React 根容器处理器执行：
  命中高峰闸门时 `preventDefault + stopPropagation`，发送被完整拦下，草稿保留在输入框中；
  `/peakgate` 指令则直接在拦截层执行（不发给模型、不消耗 token）。
- 确认后通过会话的 `provideInfo(id).props.inputActions.submit()` 走与发送按钮完全相同的提交流程。
- 时间计算用 `Intl.DateTimeFormat`（Asia/Shanghai），无时区库依赖；周末规则与官方政策一致。

## 贡献

欢迎提交 Issue 与 PR：

1. Fork 本仓库并创建功能分支；
2. 修改后运行 `npm test` 保证全部用例通过（新增功能请附测试）；
3. 提交 PR 并描述改动与验证结果。

注意：`lib/client.js` 是直接在 `__ModuleLoader__` 格式下手写的浏览器 bundle（无构建步骤），
改动请保持该格式（普通 JS + `React.createElement`，不使用 JSX）。

## 免责声明

价格为 DeepSeek 官方公开政策（可能调整）；本插件只做本地提醒，不改变任何计费行为。

