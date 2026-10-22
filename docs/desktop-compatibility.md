# 桌面端兼容记录

## 2026-10-22：DSH 0.2.1-rc.2 与 Windows 适配

本次保留原有全部功能及工作区已有修改，没有使用 `allow-version` 或关闭补丁来绕过兼容问题。开发 SDK 和锁文件已固定到 `0.2.1-rc.2`，Cordis 4.0.5、Schemastery 3.18.5；既有 `^0.2.1-alpha.5` peer 本身覆盖同版本基线的 RC，不需另加不安全豁免。

### 已发现的问题

| 问题 | 处理 |
| --- | --- |
| 构建将 `URL.pathname` 作为 esbuild 工作目录，Windows 盘符以及包含空格、中文、`#`、`%` 的路径会错误 | 统一使用 `fileURLToPath`；在特殊字符目录从不同 cwd 执行真实构建回归 |
| release 直接 spawn npm，Windows 的 `npm.cmd` 不能作为普通可执行程序启动 | 找到 `npm-cli.js` 后交给 Node 执行；不使用 shell，避免参数中的 `%s`、引号和符号被解释 |
| Desktop 验收硬编码 macOS 路径，默认 symlink 在 Windows 受权限限制 | 增加 Windows 安装目录/exe 查找与显式路径；目录链接使用 junction；清理重试处理临时文件锁 |
| Markdown 下载使用 Windows 保留设备名（CON、AUX、COM1 等） | 安全前缀并处理截断后的尾随点，保留普通文件名 |
| 加速设置缺少配置入口，保存失败前提前改变内存状态 | 补齐原生 Config entry，保存成功后生效；保留会话开关与自定义参数 |
| 加速拦截器把网络失败也当作准备失败，再发一次原请求；`/fast` 忽略补丁开关 | 网络和取消错误不重复发送；命令可用性和执行均检查实时开关 |

这些是代码中确认的问题；由于没有用户 Windows 报错日志，不能断言每一项都是该机器本次无法使用的直接原因。Web 与 Desktop profile 分离，装到 `web` 不会加载到桌面端，也必须核对。

### 验证与边界

- macOS 上使用 Node **24.22.1** 完成 `npm run check`：清单、peer、类型、**46 个测试文件 / 359 项测试**、**11 项脚本回归**和构建全部通过，无跳过。
- npm SDK Host 和本机实际安装的 Desktop Host 均为 **0.2.1-rc.2**，隔离验收通过。除历史功能外，新增原生加速设置保存、读取、启停和 loopback HTTP 请求验证，确认发出 `service_tier: priority` 与自定义请求头，关闭补丁时不加速。
- 隔离 Desktop profile 仍出现上游 telemetry `serviceVersion` 缺失及 analytics 等待警告；插件断言全部通过。原生 UI fixture 图标警告不计作真实窗口验收。
- 目标 RC 的真实 SDK Host 使用临时 DSH_HOME 和本地模型替身；不读取用户历史或使用模型密钥。检查 bundle 没有被跳过、受认证 Fetch registry、未登录请求 401。
- Windows 路径语义测试覆盖盘符、UNC、长路径、中文空格、独立任务识别、精确会话目录删除和危险路径拒绝。
- CI 扩展为 Linux / Windows / macOS × Node 22.19 / 24，并在 Node 24 上跑 SDK Host。**配置 CI 不等于已执行远端 Windows CI；本轮无 Windows 实机逐项验收。**
- 工作区同期新增的 `terminal-clipboard` 也保留在构建和全量测试中；本次不覆盖其实现。

### Windows 重跑和安装

```powershell
pnpm install --frozen-lockfile
pnpm run check
pnpm run test:runtime
# 可选：检查这台机器实际安装的 Desktop，不是 npm SDK
$env:DSH_MORE_DESKTOP_APP = "C:\实际安装目录\DeepSeek Harness.exe"
pnpm run test:desktop
npm pack
```

把生成的包安装到**实际使用的 profile**；桌面端需先完整退出，并使用 Desktop 自带 `dsh`（不是 npm 通用 CLI）：

```powershell
Get-Command dsh | Select-Object Source
dsh --version
dsh plugin --profile desktop add "C:\Downloads\dsh-more-0.1.1.tgz"
dsh plugin --profile desktop list dsh-more --depth 0
```

重新打开 Desktop 后，在设置里确认所有补丁开关，再用测试会话验收：编辑续跑、用户/助手消息删除、冷/实时会话永久删除、模型能力保存、加速及 `/fast`、Markdown 下载、自动标题、独立任务和手动归组；检查源会话历史保留，开关关闭/恢复和重启后的配置持久化。终端复制粘贴按其当前工作区功能单独验证。

本次修复尚未发布 npm；不能用 `dsh-more@latest` 代替这里的本地修复包。没有重启或修改用户正在运行的 DSH，也没有提交/推送代码。

## 2026-10-16：适配 DSH 0.2.1-alpha.5

npm 的 `alpha` 标签在本轮查询时为 `0.2.1-alpha.5`。本轮修改：

- 宿主 DSH peer 保留既有 RC 分支，并增加 `^0.2.1-alpha.5`；Cordis/Schemastery 也显式允许对应 alpha。开发 SDK 与锁文件统一固定在已验证的 alpha，不用全量预发布豁免。
- 移除已被 alpha 删除的 `webRuntime` 强注入，避免插件永久等待服务；Host 与插件清单的注入声明保持一致，并等待 `connection` 就绪。
- 预设类型依赖从已停止发布的 `dsh-agent-presets` 迁到 `dsh-agent-preset-registry`，保留原有 `agentPresets.composeFrom` 的精确代际继承。
- 设置、会话导航、旧菜单插槽统一收敛到适配层；内容 Factory 改用正式 `ConversationContentProps`，不再借用已变窄的 shell props。
- 导出兼容 alpha 的一等工具结果消息及旧版包裹内容，正确保留失败标记；续跑上下文同时识别新版 `runtime-context` 来源与旧版插件来源。
- 测试改用真实 SettingsForms（仅配置文档 IO 为内存替身），原生 SlotRegistry/renderer/ConversationContent 默认读取固定 SDK；不再因没有 Desktop 安装包而跳过。

验证范围：

- 类型检查、全量 Vitest **41 个文件、296 项测试通过，无跳过**，包含原生 alpha 客户端模块。
- 隔离 alpha Host 与本机 Desktop `0.2.0-rc.2` 均通过导出、编辑续跑、删除重建、原历史保留、归组持久化、永久删除、补丁开关、模型能力保存/冲突及标题中间件验收；同时断言 bundle 未被跳过、路由进入认证 Fetch registry、未登录请求返回 401。
- 两种 Host 验收只用临时 DSH_HOME 和模型替身；未使用用户密钥或修改用户会话。隔离 desktop composition 仍会报告上游 telemetry serviceVersion 缺失及 analytics 等待警告，与插件断言无关。
- 原生内容测试的图标替身有 React 属性警告，不影响功能断言。现有 RC 安装包的原生客户端两项回归也通过。
- `pnpm run check`、peer 检查、构建、`npm pack --dry-run` 和 diff 空白检查均通过。本机最终源码验证使用现有 Node.js 26.3.0；已配置 Node 22/24 CI，但本轮未执行远端 CI。宿主自带的签名 Node 24 因 macOS 库验证拒载 npm 的 rolldown 原生绑定，未通过修改签名或关闭安全检查绕过。

重跑：

```sh
pnpm install --frozen-lockfile
pnpm run check
pnpm run test:runtime  # 固定 npm alpha Host；已加入 CI Node 24
pnpm run test:desktop  # 本机 Desktop 安装包
```

本轮没有替换或重启用户的 DSH，没有 alpha 真实窗口逐项点击验收，也未发布 npm、提交或推送。已有本地链接安装需重启 DSH 并刷新页面，让新 peer、Host 与 Client 一起加载。

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
