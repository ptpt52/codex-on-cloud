# 浏览器兼容性验收

兼容性以当前提交、锁定的 Playwright、实际浏览器和测试环境为准。历史 Chrome / Firefox / WebKit 版本和某次通过数量不作为当前兼容性承诺；旧结果保存在[验证归档](archive/verification.md)。

## 自动化矩阵

`npm run test:compat` 使用[独立配置](../playwright.compat.config.mjs)运行选定的跨引擎规格：

| 引擎 | 项目名 | 布局 |
| --- | --- | --- |
| Chromium | `chromium-desktop`、`chromium-phone`、`chromium-tablet` | 电脑、Pixel 7 手机模拟、触屏平板 |
| Firefox | `firefox-desktop` | 电脑 |
| WebKit | `webkit-desktop`、`webkit-phone`、`webkit-tablet` | 电脑、iPhone 13 / iPad Pro 11 模拟 |

范围包括窄屏、旋转、中文组合输入、焦点、查找复制、终端标签与操作、文件、设备映射、连接恢复、多节点登录和自建管理中心等。实际文件清单以配置的 `testMatch` 为准，测试数量随功能变化。

完整手机 / 电脑 Chromium 回归另由 `npm run test:browser` 执行，不等同于上述选定规格。CI 的分组、时限与产物见[自动检查](ci.md)。

## 运行方式

在隔离开发目录安装锁定依赖，再安装该 Playwright 版本对应的浏览器：

```sh
npm ci
npx playwright install chromium firefox webkit
npm run test:compat
```

系统需满足三个引擎的运行库要求；优先使用匹配 CI 的 Ubuntu 24.04 开发环境。不要在生产任务主机上为测试随意升级系统库或应用依赖。

可分别用 `CHROME_PATH`、`FIREFOX_PATH`、`WEBKIT_PATH` 指定对应引擎的程序或启动器；不把 Chrome 路径传给其他引擎。单独排查或列出用例：

```sh
npm run test:compat -- --project=firefox-desktop
npm run test:compat -- --list
```

产物在忽略的 `test-results/compatibility/`，失败保留截图和 trace；不要使用生产账号、真实浏览器配置或生产节点注入故障。隔离用户空间、浏览器模拟与真实设备分别记录，不把某台开发机的临时启动器当成项目运行依赖。

## 真机验收

在自己的 Android、iPhone、iPad 或其他目标设备上，使用专用验收实例检查：

1. 登录、账号密码自动填充、屏幕锁设置与解锁；浏览器原生保存密码提示不由默认自动化规格直接验证。
2. 中文和其他输入法组合，横竖屏、软键盘遮挡与草稿保留；先粘贴，再单独 Enter。
3. 网页终端历史选字、系统复制菜单、剪贴板授权和手动复制回退。
4. 平铺 / 下拉终端入口、操作菜单、重命名与取消；多节点使用各自登录标识。
5. 全屏进入 / 返回、亮屏、切到后台再恢复，以及 Wi-Fi / 蜂窝切换。
6. 开启实际需要的文件、设备或映射功能，核对权限和原任务保留。

只在空闲的测试终端发送验证输入，不能向工作中的 Codex 自动注入测试文字。Linux WebKit 不等于 iOS Safari；注入 composition / visualViewport 事件也不等于真实输入法、软键盘或系统权限验收。
