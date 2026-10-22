# 终端复制粘贴

补丁 ID：`terminal-clipboard`。默认启用，可在 DSH More 设置中单独关闭。

## 使用

- 在右侧终端拖动选中或双击选词，松开鼠标后自动复制新选区。
- 右键直接粘贴；`Shift + 右键` 保留原生菜单。
- `Ctrl+Shift+C` 复制选区；有选区时 `Ctrl+C` 也复制，无选区时仍中断命令。
- `Ctrl+Shift+V`、`Shift+Insert` 粘贴。
- macOS 的 `⌘C/⌘V` 和浏览器原生 `Ctrl+V` 不被补丁接管。
- vim 等开启鼠标捕获的程序中，按住 Shift 拖选以使用 xterm 原生选区。

## 权限与安全边界

自动复制和右键粘贴需要浏览器允许剪贴板读写（HTTPS 或 localhost 安全上下文）。失败时显示提示，不请求 Host 读取系统剪贴板，不把剪贴板内容传给补丁 API。只读终端不注入输入。关闭补丁、关闭终端、终端失焦或实例被替换后，丢弃未完成的粘贴结果。

粘贴调用 xterm 的原生 `paste()`，保留换行归一化和 bracketed paste 行为，不追加回车。但剪贴板自带换行仍可能触发 shell 执行，请只粘贴可信命令。

## 兼容性

针对 DSH 0.2.1-rc.2 的 `TerminalScreen` 实现：DSH 暂未公开 xterm 实例服务，因此在单独的适配器中有限遍历 React ref，并严格核对实例所属 DOM 和方法。找不到兼容实例时不拦截事件，不猜测终端会话、不直接调用 `model.write()`。没有修改 React/xterm 原型或原生按键处理器。

测试包括 DOM 事件、生命周期、剪贴板拒绝和延迟粘贴取消；真实桌面剪贴板权限和鼠标选区仍应手工验证。

## 本地验证

```sh
pnpm run generate
pnpm exec vitest run src/patches/terminal-clipboard/terminal-clipboard.test.ts
pnpm run typecheck
pnpm run build
```

加载新构建的 DSH More 后，在设置中确认「终端复制粘贴」已开启，再打开右侧终端测试。若桌面安装的是已发布版本而不是当前工作目录，需先更新/重新加载本地插件；仅刷新页面不会安装新代码。
