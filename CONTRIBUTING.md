# 为 DSH More 贡献代码

感谢你为 DSH More 补充功能。这个仓库的目标不是维护一个不断膨胀的单体插件，而是维护一组可以独立注册、启停、测试和移除的 DSH 补丁。

最重要的规则是：**普通功能补丁应当只新增或修改 `src/patches/<patch-id>/`。**

如果一个功能使用现有依赖，并且能够归入现有的 `message-action` 或 `standalone` Client 类型，通常不需要修改根入口、设置页面、注册表、构建脚本、`kernel/` 或 `platform/`。

## 开始之前

开发环境要求：

- Node.js `22.19.x` 或 `>= 24`；
- pnpm；
- 与项目当前依赖匹配的 DSH。本版本面向 DSH `0.1.0-rc.7`。

首次检出后执行：

```sh
pnpm install
pnpm run check
```

开始编码前，请先确认：

1. 需求是新增补丁，还是扩展已有补丁；
2. 是否能使用现有 Host/Client 契约完成；
3. 是否涉及不可恢复的数据修改、持久化格式或已有会话；
4. 是否真的需要新增依赖或修改共享层。

## 仓库边界

```text
src/
├── patches/          # 具体功能；普通贡献的默认工作区
├── kernel/           # 与 DSH 无关的补丁契约、激活和注册机制
├── platform/dsh/     # DSH Host/Client 适配与安全边界
└── generated/        # 构建时生成，不提交
```

各目录的责任：

- `src/patches/<patch-id>/`：一个补丁的清单、Host、Client、共享类型和测试；
- `src/kernel/`：所有补丁共同遵守的抽象，不放具体业务功能；
- `src/platform/dsh/`：对 DSH API、Context、DOM、请求和信任边界的集中适配；
- `scripts/`、`build.mjs`：注册表生成和发布构建；
- `test/`：跨补丁的 kernel/platform 契约测试；具体补丁测试不放这里；
- `src/generated/`、`dist/`：自动生成，不编辑、不提交。

只有以下情况才应修改补丁目录之外的代码：

- 新功能无法归入现有两种 Client 类型；
- 至少两个补丁需要同一个新的稳定公共能力；
- DSH API 变化，需要更新集中适配层；
- 新增依赖、构建能力或发布配置；
- 修复 kernel/platform 本身的缺陷。

这类修改需要在变更说明中解释为什么不能留在单个补丁目录，并补充共享层测试。

## 新增一个补丁

推荐结构：

```text
src/patches/example-feature/
├── patch.json
├── shared.ts
├── host/
│   ├── index.ts
│   └── feature.ts
├── client/
│   └── index.tsx
└── example-feature.test.ts
```

### 1. 编写 `patch.json`

```json
{
  "id": "example-feature",
  "name": "面向用户的中文名称",
  "description": "一句话说明开启后获得什么能力",
  "defaultEnabled": true,
  "order": 400,
  "host": "./host/index.ts",
  "client": {
    "kind": "message-action",
    "entry": "./client/index.tsx"
  }
}
```

清单规则：

- `id` 必须与目录名完全一致，并匹配 `[a-z][a-z0-9-]*`；
- `name` 和 `description` 会直接显示在设置卡片中，应使用清晰的中文产品语言；
- `order` 必须是仓库内唯一的安全整数，用于稳定排序；
- `host` 和 `client.entry` 必须指向真实文件；
- `client.kind` 当前只能是 `message-action` 或 `standalone`；
- 不要手工修改注册表或设置 schema，生成器会从这里派生它们。

可以执行下面的命令提前检查清单：

```sh
pnpm run generate
```

### 2. 定义共享标识和线协议

将 Host 与 Client 都需要的稳定内容放在 `shared.ts`，例如补丁 ID、预览结果和请求响应类型。不要把 DSH Context、DOM 节点或 Host 专属实现放进共享文件。

```ts
export const EXAMPLE_FEATURE_PATCH_ID = 'example-feature'

export interface ExamplePreview {
  confirmToken: string
  summary: string
}
```

跨 Host/Client 传输的数据应当是可 JSON 序列化的普通数据。

### 3. 实现 Host 入口

`host/index.ts` 必须导出名为 `hostPatch` 的 `HostPatch`：

```ts
import type { HostPatch } from '../../../kernel/host/patch.js'
import { EXAMPLE_FEATURE_PATCH_ID } from '../shared.js'

export const hostPatch: HostPatch = {
  id: EXAMPLE_FEATURE_PATCH_ID,
  setup: (ctx) => {
    // 可选：安装只属于这个补丁的监听器或运行时包装。
    return () => {
      // 必须完整撤销 setup 创建的副作用。
    }
  },
  routes: ({ ctx, confirmationSecret }) => ({
    preview: async (payload) => {
      // payload 是 unknown；先验证，再使用。
      return { ok: true }
    },
    commit: async (payload) => {
      return { ok: true }
    },
  }),
}
```

Host 规则：

- 不要在模块顶层安装监听器或修改 DSH 对象；使用 `setup()`；
- `setup()` 必须返回 disposer，关闭补丁或卸载插件时应恢复原状；
- 当前注册表契约要求每个补丁至少提供一个 API action；
- 所有 payload 都按不可信的 `unknown` 处理，优先复用 `platform/dsh/host/` 中的校验和错误工具；
- action 名称和返回结构一旦发布就是线协议，修改时要考虑已有 Client；
- 具体业务逻辑放在补丁自己的 Host 文件，不要塞进共享 API router。

### 4. 选择 Client 类型

#### `message-action`

适用于在用户或助手消息旁增加操作。Client 入口必须导出 `useMessageActions`，返回按钮渲染器和可选 overlay。

```tsx
export function useMessageActions(
  props: ConversationHeaderProps & { ctx: ClientContext },
  enabled: boolean,
): MessageActions {
  // Hook 每次渲染都会被调用，包括 enabled === false。
  // 所有 effect 都必须检查 enabled，并在 cleanup 中撤销。
  return {
    renderAction: (target) => enabled ? <button>操作</button> : null,
    overlay: null,
  }
}
```

不要自行扫描并重复创建消息操作容器；复用共享的 `MessageTarget` 和 action row。

#### `standalone`

适用于独立 slot、全局 overlay、侧栏菜单增强或 DOM observer。Client 入口必须导出 `clientPatch`：

```tsx
export const clientPatch: ClientPatch = {
  id: EXAMPLE_FEATURE_PATCH_ID,
  install: (ctx, activation) => {
    // 注册 slot 或挂载控制器；组件内订阅 activation。
  },
}
```

Standalone 规则：

- UI 必须响应补丁开关，关闭后移除按钮、observer 和未完成的局部状态；
- DOM 增强必须可重复安装，并能删除自己创建的节点和属性；
- 不要用新增行为替代 DSH 原生行为。例如永久删除是独立菜单项，不能覆盖原生归档；
- 调用 Host API 时复用 `callPatchApi()`，不要绕过统一路径和请求头。

如果功能不属于这两类，不要把它伪装成最接近的一类。先说明新的挂载需求，再扩展生成器和 kernel 契约。

## 编码约定

- 使用严格 TypeScript；项目开启了 `strict`、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes` 和未使用代码检查；
- 使用 ESM，并在相对 TypeScript import 中保留 `.js` 后缀；
- 类型导入使用 `import type`；
- 遵循现有代码风格：两个空格缩进、单引号、无分号；
- 用户可见文案使用清晰中文，不暴露内部模块名、路径、props 或工程术语；
- 补丁 ID、投影 key、持久化 metadata 和 API action 应使用稳定名称；
- 不要通过 `any`、双重断言或未验证的内部字段绕开边界。确实需要兼容 DSH 暂未公开的接口时，将兼容访问集中在 adapter 中并写失败测试；
- 不要顺手重构无关模块，让每次变更都能明确归属于一个补丁或一个共享缺陷。

## 数据、安全和兼容性

凡是会修改会话、历史或磁盘的功能，都要满足以下最低要求：

1. Client 只调用统一插件 API，不直连本地文件或 Host 内部对象；
2. Host 路由继续经过 loopback/trusted-host、same-origin 和自定义请求头检查；
3. 预览与提交分离，提交时重新校验会话 revision、目标和确认令牌；
4. 忙碌会话应拒绝操作，或先完成明确的 cancel、idle、flush、unload 流程；
5. 删除路径必须从 DSH 返回的逐对象定位信息推导，只接受已知的逐会话 artifact 布局，不把本机路径返回 Client；
6. 禁止对宽泛目录、未解析变量或 glob 执行递归删除；
7. 多步写入必须把可撤销副作用记录下来，并在后续步骤失败时执行补偿；不要用“尽量成功”的部分写入掩盖失败。

以下内容属于持久化协议，不应在普通重构中随意改名：

- Session event 中的 `source.plugin`、`operation` 和 replay metadata；
- projection key 与 state version；
- Settings namespace 和字段；
- 已发布的 API action、请求和响应结构。

确实要做破坏性变更时，应明确声明不兼容范围，并增加迁移或拒绝旧数据的测试。

## 测试放在哪里

补丁测试与代码放在一起：

```text
src/patches/example-feature/example-feature.test.ts
```

至少覆盖：

- 核心选择、转换或状态计算；
- 正常路径和关键拒绝路径；
- `setup()` 安装、关闭和重复启用时的清理；
- payload 非法、状态过期或目标变化；
- 对磁盘操作使用 `mkdtemp()` 隔离，并在 `afterEach` 中清理精确临时目录；
- 修复 bug 时增加一个修复前会失败的回归用例。

只有修改 kernel/platform 时，才把测试放到 `test/kernel/` 或 `test/platform/`。共享测试应验证通用不变量，不能写死“仓库永远只有当前三个补丁”，否则新增补丁会被迫修改补丁目录之外的文件。

## 生成、检查和打包

日常开发可按需要执行：

```sh
pnpm run generate   # 校验 patch.json 并重建注册表
pnpm run typecheck
pnpm test
pnpm run build
```

提交前必须执行：

```sh
pnpm run check
pnpm run package:check
```

说明：

- `build`、`typecheck` 和 `test` 都会自动运行生成器；
- `src/generated/`、`dist/` 和 `*.tgz` 已被忽略，不要强制加入 Git；
- 补丁目录里的 `*.test.ts(x)` 会参与类型检查和测试，但不会进入声明产物；
- `package:check` 会显示最终 npm 包内容，应确认没有源码测试、临时文件或本机路径。

## 发布 npm

发布前需要满足以下条件：

- 当前分支已经设置 upstream，并与远端完全同步；
- 工作区没有未提交文件；
- 正式发布前已执行 `npm login --registry=https://registry.npmjs.org/`，且当前 npm 用户有权发布 `dsh-more`；dry-run 不要求 npm 登录；
- Git 远端允许推送当前分支和 `v<version>` tag。

先执行不产生任何版本、tag 或发布记录的预检：

```sh
pnpm run release:dry-run
```

正式发布使用以下任一命令：

```sh
pnpm release          # 首次发布保留当前版本；以后默认自动升级 patch
pnpm release:patch    # 0.0.1 -> 0.0.2
pnpm release:minor    # 0.0.1 -> 0.1.0
pnpm release:major    # 0.0.1 -> 1.0.0
```

脚本会依次检查 Git/npm 状态，运行完整项目检查，自动修改 `package.json` 版本并通过 npm `version` 生命周期同步 `dsh.plugin.json`，随后创建 `chore(release): v<version>` 提交和同名 tag，发布到公共 npm registry，最后以一次原子 push 同时推送版本提交和 tag。首次发布时，若 npm 上还不存在这个包，`pnpm release` 会直接发布 `package.json` 中的当前版本并为当前提交创建 tag。

如果 npm 账户要求一次性验证码，可以使用：

```sh
pnpm run release -- --otp=123456
```

发布或推送被网络临时中断时，不要手动再次修改版本号。修复登录或网络问题后重新运行 `pnpm release`，脚本会识别本地 release tag、npm registry 和远端 tag 的状态，继续未完成的发布或推送，避免重复升级版本。

## 新增依赖

优先使用现有依赖和平台适配层。确实需要新增时：

- 只在构建或测试中使用的包放入 `devDependencies`；
- 运行时由 DSH 提供的外部包放入 `peerDependencies`，并在 `devDependencies` 固定本地开发版本；
- Client bundle 真正产生外部 `require()` 时，将对应模块加入 `dsh.client.inject`；
- 只用于 TypeScript module augmentation、且不会出现在发布声明或运行时 bundle 中的包，可以仅作为开发依赖；
- 同步 `pnpm-lock.yaml`；本仓库不维护并行的 `package-lock.json`；
- 不要为了一个很小的 helper 引入大型依赖。

更新锁文件后再次运行完整检查，并在变更说明中写明依赖的用途。

## 提交前检查清单

- [ ] 普通功能改动只位于一个 `src/patches/<patch-id>/`；或已解释共享层修改原因；
- [ ] `patch.json` 的 ID、目录名和入口一致，order 唯一；
- [ ] Host 副作用可以在关闭补丁时完整清理；
- [ ] Client 关闭后不会残留按钮、DOM 属性、observer 或弹窗状态；
- [ ] 输入按不可信数据验证，破坏性操作有预览、确认和状态复核；
- [ ] 用户可见行为没有覆盖或偷偷改变 DSH 原生功能；
- [ ] 新测试放在补丁目录，并覆盖失败路径；
- [ ] 没有提交 `src/generated/`、`dist/`、tarball、日志或本机文件；
- [ ] `pnpm run check` 通过；
- [ ] `pnpm run package:check` 的文件清单符合预期。

## 变更说明建议

提交补丁或 Pull Request 时，至少说明：

1. 用户遇到的问题和期望行为；
2. 改动属于哪个 patch ID；
3. 是否修改持久化数据、原生 DSH 行为或公共契约；
4. 如何验证，包括执行的命令；
5. 有视觉变化时附上展开、关闭和错误状态截图；
6. 尚未在真实 DSH 环境确认的部分要明确标为待验证，不要用单元测试替代真实交互结论。
