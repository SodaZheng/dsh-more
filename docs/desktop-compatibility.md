# 桌面端兼容记录

## 2026-10-15：适配 Desktop 0.2.0-rc.2

本次确认并修复两层失效，未使用版本豁免绕过 DSH 的兼容检查：

- **插件未加载**：新版启动器按 DSH peer 范围筛选 bundle；原来的 `^0.1.5-rc.2` 不覆盖 `0.2.0-rc.2`，因此整个 dsh-more 被跳过。保留旧范围并增加 `^0.2.0-rc.2`。
- **原生通信通道变化**：静态桌面页面通过 `__DSH_TRANSPORT__.fetch` 连接 Host。插件改用目录相对的 `api/dsh-more/...`，请求优先交给宿主 carrier；Host 等待 Connection 服务就绪后，注册原生受认证 Fetch 路由，而不是只挂 HTTP 路由。旧版无 Fetch registry 时保留 HTTP 适配。
- **错误响应完整性**：插件的小型 JSON 请求使用 buffered carrier，避免提前返回关闭补丁错误时，未读请求流导致连接提前断开。仍保留 64 KiB 业务请求限制、JSON 类型检查、自定义请求头、确认令牌与补丁开关。

验证结果：

- 类型检查、清单校验、peer 检查与 diff 空白检查通过。
- 本地 Vitest **39 个文件、290 项测试通过**，包括从当前安装包载入的真实 SlotRegistry、renderer、ConversationContent；无跳过。原生 Factory 测试的图标 mock 会产生 React 属性警告，不影响断言。
- 安装包实际 Host 的隔离回归通过：导出、编辑续跑、删除重建、源历史保留、归组持久化、永久删除、补丁开关、模型能力保存及冲突、标题中间件。脚本同时检查 bundle 没被跳过、路由确实进入原生 registry，以及未登录访问返回 401。仅用临时 DSH_HOME 和模型替身，不修改用户会话或使用用户密钥。
- 隔离 profile 中仍有安装包自身的 telemetry serviceVersion 缺失与依赖 analytics 等待警告；插件功能断言通过，不将这些警告计作插件验收结果。

**范围限制：本轮没有重启用户正在使用的 Desktop，也没有逐项点击真实窗口。** 构建产物已更新；desktop profile 本来就链接此仓库。需要保存工作后完整退出并重新打开 Desktop，让新 peer 声明、Host 和客户端 bundle 一起加载。没有发现运行中的 dev:web watcher，不承诺自动热更新。本轮未发布 npm、未提交或推送代码。

重跑方式（显式使用仓库自己的工具，避免环境 PATH 中同名全局工具）：

```sh
node node_modules/typescript/bin/tsc --noEmit
DSH_MORE_DESKTOP_ASAR='/Applications/DeepSeek Harness.app/Contents/Resources/app.asar' node node_modules/vitest/vitest.mjs run
npm run test:desktop
```

## 官方桌面端兼容验收（2026-09-26 至 27）

已完成官方 macOS DeepSeek Harness **0.1.7-rc.2** 的修复和实际窗口验收。desktop profile 通过本地链接加载本仓库构建产物；本次没有发布 npm 或推送代码。

## 根因与修复

| 问题 | 修复 |
| --- | --- |
| 新版移除了 `sessions.open()`，独立任务初始化抛错，后续 Factory / picker 适配均未安装；消息编辑、删除后的导航也调用了旧接口 | 共享适配改用 `uiWorkspace.openSession()`，兼容旧版接口；当前会话从新版 `retainedBy.mainView` 读取 |
| 新版 `sessions.create()` 只发布目录记录，不保证输入绑定已经就绪 | 临时 `retain()` 目标，等待 `ready` 后交接草稿，主视图接管后释放；关闭补丁也会释放等待中的引用 |
| 归档动作改成菜单子插槽独立注入，且增加快捷键文本，旧父组件回调拦截和整行文字匹配失效 | 永久删除、手动归组使用 `sidebar.workspaces.session.menu.item` 直接接收会话 ID；保留旧版适配 |
| 关闭／开启永久删除后，旧会话的卸载句柄丢失 | 被动观察覆盖插件生命周期，包括动作关闭期间；API 仍受开关控制。包装保留调用者的 Cordis `this`，不改变资源所有权 |
| 导出入口依赖按钮 CSS 类、直接父节点和固定条目顺序 | 在当前会话头部按语义识别条目；打开的原生菜单不能适配时保留工具栏入口 |

删除失败时会恢复原会话选择，避免错误弹窗留在预先切换的相邻会话上。原有独立任务 Factory 适配已保留并纳入验证。

## 真实桌面窗口验收

使用 Electron 的 `dsh-app://app/` 实际渲染进程，通过 CDP 操作控件。系统捕获接口失效且页面被系统标记为隐藏，因此调试期间启用焦点模拟以恢复帧回调；没有用测试页面替代桌面应用。

| 功能 | 实际结果 |
| --- | --- |
| 独立任务 | 下拉选项恢复；选择后保留文本草稿并创建独立目录。× 清除项目目录也保留草稿。原生“新会话”继续创建不同独立目录 |
| 消息编辑 | 修改测试消息后自动跳入新会话，真实模型完成生成 `QA-THREE`；原来的后续回复不再出现 |
| 删除消息 | 用户、助手消息分别完成删除及自动跳转；其他消息保留；取消预览不修改消息 |
| 永久删除 | 非当前会话删除后不抢页面；当前会话删除后跳转到相邻会话；取消不删除。启动时关闭该补丁、恢复会话后再多次开关，仍能删除当前会话 |
| 手动归组 | 从未分组移入工作区再移回；原工作目录不变，没有误触归档 |
| Markdown | 原生“更多操作”出现导出项；收到下载完成事件，实际文件包含测试用户消息和 `QA-ONE` 回复 |
| 模型能力 | 专用测试模型通过编辑器保存识图、low/high 思考等级和参数格式；重新打开及页面重载后配置正确 |
| 自动标题 | 新建测试会话真实生成“测试 · …”标题，模型回复正常 |
| 七个开关 | 逐项关闭后对应 API 返回 `patch-disabled` / 409，开启后恢复；菜单项正确注销、恢复且不重复；页面重载后配置保持 |

测试的四轮内容请求均得到预期回复；最终 Client 插件 registry 没有失败 fiber。

最终重启后，通过 `Debugger.getScriptSource` 核对实际已执行的客户端脚本，确认完整包含最终 `dist/client.js`（SHA-256：`cedb76501a4f4b2414f0ac1c61a26be7f1bc70829e090b2255aeda7cecdd7e33`）。验收后以普通模式重新打开应用，移除临时调试端口；原生窗口截图确认主界面和目录清除入口正常显示，普通 Host 仍提供完全相同的最终 bundle。

## 自动检查

- `DSH_MORE_DESKTOP_ASAR='/Applications/DeepSeek Harness.app/Contents/Resources/app.asar' pnpm run package:check`：包括 prepack 中的清单、peer、类型、完整测试及构建；**37 个文件、277 项测试通过**，原生 Factory 测试未跳过。
- `node scripts/check-desktop-runtime.mjs`：使用安装包实际 Host，在临时 `DSH_HOME` 与本地模型替身上验证导出、编辑续跑、消息重建、源历史保留、归组持久化、写入句柄释放、关闭期间创建的会话再删除、模型能力保存及 revision 冲突、标题中间件。
- `git diff --check` 与脚本语法检查通过。

`pnpm run test:desktop` 可重复执行隔离运行时检查。它不替代窗口验收，也不使用用户模型密钥。

## 清理与范围

六条专用测试会话（包括编辑／删除产生的延续会话）、测试提供方和空测试目录已清理。七个补丁恢复原来的默认开启状态及空用户覆盖；原始会话选择已恢复，没有修改已有用户消息。

本次范围是这台 Mac 上的官方桌面端 0.1.7-rc.2，未声称已验证 Windows/Linux、其他预发布版本或每一种第三方插件组合。文件附件交接、并发取消、只读设置、非法请求等失败路径另由自动回归覆盖。永久删除仍要求 JSONL 后端有效定位能力；插件载入前已存在且未被观察到的写入句柄会被安全拒绝，需重启后再操作。
