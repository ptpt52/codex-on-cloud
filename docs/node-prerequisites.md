# 首次部署的工具与依赖

在准备部署的 Linux 节点上，以普通用户执行。推荐 Ubuntu 24.04；需要 systemd 用户服务，Windows 请先按 [WSL 指引](wsl.md)准备。

## 先核对现有工具

```bash
command -v node npm go python3 git flock
node --version
npm --version
go version
systemctl --user is-system-running
```

| 工具 | 要求 | 何时需要 |
| --- | --- | --- |
| Node.js / npm | Node.js 22+；下文提供固定 24.22.2 | 所有节点 |
| Python 3、tmux、util-linux/flock | Ubuntu 24.04 系统包 | 终端、文件服务、部署锁 |
| Git、CA 证书 | 系统包 | 克隆仓库、助手版本信息、HTTPS 下载 |
| Go | 固定 **1.26.4** | 构建端口映射助手 |
| Codex 或其他 AI CLI | 按团队规范安装与登录 | 实际使用对应 AI；纯终端部署不要求预装 |

`--install-deps` 安装工作区所需的 apt 基础包，不安装 Node.js、Go 或 Codex。Ubuntu 的默认 `nodejs` / `golang-go` 包不一定满足项目版本，不能用“apt 安装成功”代替版本核对。

找不到命令时，先检查是否已安装到仓库的 `data/host-tools`。下面的 PATH 配置同时适用于恢复已有工具和完成新安装；不要删除仍被 systemd 服务使用的运行时。

## 准备基础包与源码

```bash
sudo apt-get update
sudo apt-get install -y --no-install-recommends \
  git ca-certificates curl tar xz-utils python3 tmux util-linux
```

克隆自己的仓库并进入根目录；仓库地址见 [README](../README.md)。后续工具安装命令都在该目录执行。已有 Node.js 22+ 且 `npm --version` 正常时，可继续使用，不必换成下文版本。

## 缺少工具时，安装固定版本

以下为 Ubuntu x86_64 / ARM64 的普通用户安装示例。工具放在被 Git 忽略的 `data/host-tools` 中，每个版本使用独立目录；下载包最多 160 MiB，临时文件在退出时清理。已有目标目录时只验证版本，不覆盖或自动升级。仅需要网页终端时，可以跳过 Go 对应的安装段。

```bash
(
  set -eu
  case "$(uname -m)" in
    x86_64)
      tool_node_arch=x64
      tool_go_arch=amd64
      tool_node_sha=48cc0e21e048790e54c0cf5749c2725005313d652651c40b7a21feb9697aaf75
      tool_go_sha=1153d3d50e0ac764b447adfe05c2bcf08e889d42a02e0fe0259bd47f6733ad7f
      ;;
    aarch64|arm64)
      tool_node_arch=arm64
      tool_go_arch=arm64
      tool_node_sha=eb187837a2230d4047161ac0be008584e16b46f726e9c9490ee35dc6b17d9ba8
      tool_go_sha=ef758ae7c6cf9267c9c0ef080b8965f453d89ab2d25d9eb22de4405925238768
      ;;
    *) echo '本示例仅支持 Linux x86_64 / ARM64' >&2; exit 1 ;;
  esac
  tool_root="$PWD/data/host-tools"
  mkdir -p "$tool_root"
  tool_tmp=$(mktemp -d "$tool_root/install-XXXXXXXX")
  trap 'rm -rf -- "$tool_tmp"' EXIT

  tool_node_dir="node-v24.22.2-linux-$tool_node_arch"
  if [ ! -e "$tool_root/$tool_node_dir" ]; then
    curl -fL --retry 3 --connect-timeout 15 --max-time 300 \
      --max-filesize 167772160 \
      "https://nodejs.org/dist/v24.22.2/$tool_node_dir.tar.xz" \
      -o "$tool_tmp/node.tar.xz"
    printf '%s  %s\n' "$tool_node_sha" "$tool_tmp/node.tar.xz" | sha256sum -c -
    tar -xJf "$tool_tmp/node.tar.xz" -C "$tool_tmp"
    mv -T "$tool_tmp/$tool_node_dir" "$tool_root/$tool_node_dir"
  fi
  test "$("$tool_root/$tool_node_dir/bin/node" --version)" = v24.22.2

  if [ ! -e "$tool_root/go1.26.4" ]; then
    curl -fL --retry 3 --connect-timeout 15 --max-time 300 \
      --max-filesize 167772160 \
      "https://go.dev/dl/go1.26.4.linux-$tool_go_arch.tar.gz" \
      -o "$tool_tmp/go.tar.gz"
    printf '%s  %s\n' "$tool_go_sha" "$tool_tmp/go.tar.gz" | sha256sum -c -
    tar -xzf "$tool_tmp/go.tar.gz" -C "$tool_tmp"
    mv -T "$tool_tmp/go" "$tool_root/go1.26.4"
  fi
  "$tool_root/go1.26.4/bin/go" version | grep -F 'go version go1.26.4 '
)
```

安装或确认已有目录后，在当前 Bash 终端设置命令路径：

```bash
case "$(uname -m)" in
  x86_64) tool_node_arch=x64 ;;
  aarch64|arm64) tool_node_arch=arm64 ;;
esac
export PATH="$PWD/data/host-tools/node-v24.22.2-linux-$tool_node_arch/bin:$PWD/data/host-tools/go1.26.4/bin:$PATH"
hash -r
node --version
npm --version
go version
```

确认版本后可继续部署。后续终端需重新设置 PATH，或把对应的**实际绝对路径**加入当前用户的 `~/.profile`。不要原样把 `$PWD` 写进登录配置，它在其他目录中会指向不同位置。Node 路径会写入 systemd 用户服务，因此安装目录需要长期保留。

## 自建中继节点的完整顺序

```bash
# 1. 在本机安装并启动纯网页终端
npm run deploy -- --mode terminal --install-deps --enable-linger

# 2. 向管理员领取绑定自己 slug 的 key，交互隐藏输入 key
npm run server:join -- --server https://desk.example.com --slug node-a

# 3. 接入成功后，按最终入口构建四平台助手
npm run build:forward

# 4. 检查本机与接入状态
npm run native:status
npm run server:status
npm run server:doctor
```

请替换域名与 slug。构建完成后，以节点管理员或临时账号登录，在“端口映射”中核对 Windows x64 / ARM64 和 Mac Apple Silicon / Intel 四项下载，并下载实际需要的版本。只有登录页能打开、节点在线或终端可用，还不能说明助手已发布。

`--build-forward` 可用于最终访问入口已经确定的部署；它会在系统安装、配置初始化和服务变更前检查 Go 版本，`--check --build-forward` 也会检查。自建中继首次接入应按上面的“部署 → 接入 → 构建”顺序，避免先为 localhost 构建、接入后下载失效。

切换域名、网关或 `/node/<slug>/` 路径后，重新构建并让客户重新下载。服务端会隐藏与当前节点入口不匹配的产物，防止助手连接到旧地址。单独构建和发布下载不需要重启面板，已有终端任务继续运行。
