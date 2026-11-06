# 自动检查

`.github/workflows/check.yml` 在推送 master、Pull Request 和手动触发时运行。工作流仅有仓库读取权限，checkout 不保存凭据。相同分支的新运行取消旧运行。

## 检查范围

| 作业 | 内容 | 期限 |
| --- | --- | --- |
| backend | 脚本语法、Node、Python、Go race/vet/mod verify、工作流 actionlint | 15 分钟 |
| terminal | 只安装 tmux/Python 与生产 JS，验证无 noVNC/X11 的真实终端后台 | 10 分钟 |
| browsers | Chromium、Firefox、WebKit 三个独立环境的 63 项兼容性流程；Chromium 另跑完整手机/电脑回归 | 每个环境 35 分钟 |
| native | 真实隔离 Xvfb、XFCE、xterm、tmux、剪贴板、noVNC 与端口映射协议检查 | 25 分钟 |

Actions 使用完整 commit SHA；Node 固定 24.22.2、Go 固定项目已有的 1.26.4，Playwright 和应用依赖继续由现有锁文件固定。检查运行在 Ubuntu 24.04，浏览器矩阵最多同时三个作业。失败浏览器产物保留七天，内容来自临时测试实例。

工作台和显示控件用例已改成每项测试独立的网关和访问地址，两个页面接管测试只在同一个临时实例内共享状态。完整浏览器回归可使用两个 worker，不依赖公共演示桌面。`npm run demo` 仍可独立启动演示。

## 本地执行

```sh
npm run check
npm test
npm run test:desktop
npm run test:compat
CHROME_PATH=/usr/bin/google-chrome npm run test:browser -- --workers=2
```

真实隔离桌面与协议检查：

```sh
npm run test:lifecycle
npm run test:display
npm run test:viewport
CHROME_PATH=/usr/bin/google-chrome npm run test:pointer
npm run test:forward
npm run test:terminal-only
```

CI 为这些检查安装临时虚拟桌面依赖，使用固定 Playwright 对应的 Chromium。真实 systemd 恢复检查 `npm run test:recovery` 由具有 systemd 用户管理器的主机单独执行，不将普通 CI 的进程组检查记为 systemd 验收。

工作流已用固定 actionlint 1.7.11 在本地校验。宿主的旧 ShellCheck 不支持 actionlint 使用的参数，本地禁用了这个子检查；CI 的 Ubuntu 24.04 执行完整 actionlint。GitHub Actions 的首次远端运行需要将工作流推送到仓库，结果应以实际运行记录为准。

自动化使用临时目录、测试凭据和隔离显示；浏览器中的 RFB/管理上游与真实 X11、TCP/DTLS、systemd 验证分别记录。真实手机和其他设备的系统输入法、选区菜单及剪贴板仍通过人工验收。
