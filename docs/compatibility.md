# 浏览器兼容性验收

2026-11-05。自动化覆盖桌面、网页终端、输入助手、历史查找与复制，真实手机验收单独记录。

## 自动化矩阵

`npm run test:compat` 使用独立 Playwright 配置，每个环境运行同样七项流程，共 49 项。

| 引擎 | 布局 | 本轮结果 |
| --- | --- | --- |
| Chromium / 本机 Chrome 137 | 电脑、Pixel 7 手机模拟、触屏平板模拟 | 21 项通过 |
| Playwright Firefox 157 | 电脑 | 7 项通过 |
| Playwright WebKit 27.2 | 电脑、iPhone 13 模拟、iPad Pro 11 模拟 | 21 项通过 |

七项流程包括：

1. 320 像素窄屏、横屏和两种平板尺寸下，按钮可见可点、中文草稿保留，不改变远程分辨率。
2. 中文组合期间禁止粘贴和 Enter；组合结束后先粘贴，再由用户单独发送 Enter。
3. 缩小 visualViewport 模拟软键盘遮挡，输入动作仍在可视区域内。
4. 桌面和网页终端均能从“更多按键”发送 Shift+←、Shift+→，不附加 Enter、不发送本地草稿。
5. 历史查找与选区复制保持文本尺寸、滚动位置及终端行列数；组合输入中的 Esc 不关闭查找。Ctrl+F 聚焦查找框，关闭后焦点返回原入口。
6. 手动复制窗口只读、默认全选并获得焦点；旋转后保留足够文本空间和可点的复制/关闭按钮，复制有反馈，关闭清空文本。
7. 支持全屏时检查进入、退出及顶部查找工具的可用性；不支持时显示现有提示，保留普通模式操作。

本轮发现并修复 Firefox 的跨 iframe 焦点问题：历史工具被移动到外层页面后，需要先激活所属浏览上下文，再设置焦点。普通点击打开时聚焦工具区域，只有明确 Ctrl+F 才聚焦搜索输入，避免触屏无意弹出键盘。

## 运行方式

依赖版本由 `package-lock.json` 固定，兼容配置复用现有测试 fixture。在支持相应浏览器的开发机或 CI 中先安装此 Playwright 版本对应的浏览器，再运行：

```sh
npx playwright install chromium firefox webkit
npm run test:compat
```

可用 `CHROME_PATH`、`FIREFOX_PATH`、`WEBKIT_PATH` 分别指定对应引擎的可执行程序或启动器；不把 Chrome 路径传给其他引擎。单独排查例如：

```sh
npm run test:compat -- --project=firefox-desktop
```

本机 Ubuntu 18.04 不满足新 Firefox/WebKit 的运行库要求，本轮在 `workspaces/` 内的隔离 Ubuntu 24.04 用户空间执行这两个引擎，通过 bubblewrap 共享测试回环网络和临时浏览器目录。没有升级宿主系统包、应用依赖、真实浏览器配置或 Codex 设置。该临时运行环境不属于项目部署依赖，也不提交 Git。

测试产物位于忽略的 `test-results/compatibility/`，每次运行替换旧产物；七个环境各保存一张复制窗口截图，失败时保存诊断截图和 trace。完整 Chromium 回归继续使用 `npm run test:browser`。

## 真机验收

Android Chrome 用户已确认可以配合，更新已加载并已发送以下检查步骤，结果待反馈：

1. 刷新页面，输入中文草稿，横竖屏切换；检查草稿保留及粘贴、Enter、关闭按钮。
2. 网页终端上翻，选择历史文本，复制后粘贴到手机便签；禁止向工作中的 Codex 自动发送测试文字。
3. 输入助手的“更多按键 → 光标导航”能找到 Shift+← 和 Shift+→，仅在空闲辅助终端按需试用。
4. 进入全屏并返回，确认查找、上翻、下翻及关闭按钮仍可用。

Linux WebKit 及移动设备模拟不等于真实 iOS Safari 验收；注入 composition/visualViewport 事件也不等于实际中文输入法和软键盘验收。iPhone、iPad 和实际 Android 输入法、系统选区菜单、剪贴板授权仍需真机确认。
