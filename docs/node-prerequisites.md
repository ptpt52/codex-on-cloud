# 首次部署的工具与依赖

在准备部署的 Linux 节点上，以普通用户执行。推荐 Ubuntu 24.04；需要 systemd 用户服务，Windows 请先按 [WSL 指引](wsl.md)准备。

## 先核对现有工具

```bash
command -v node npm python3 git flock
node --version
npm --version
# 只有构建端口映射助手才需要 Go
if command -v go >/dev/null 2>&1; then go version; fi
systemctl --user is-system-running
```

| 工具 | 要求 | 何时需要 |
| --- | --- | --- |
| Node.js / npm | Node.js 22+；下文提供固定 24.22.2 | 所有节点 |
| Python 3、tmux、util-linux/flock | Ubuntu 24.04 系统包 | 终端、文件服务、部署锁 |
| Git、CA 证书 | 系统包 | 克隆仓库、助手版本信息、HTTPS 下载 |
| Go | 固定 **1.26.4** | 构建端口映射助手 |
| Codex CLI | 自行安装和登录，不由项目升级 | 桌面模式安装检查必需；纯终端模式可选 |

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

以下为 Ubuntu x86_64 / ARM64 的普通用户安装示例。工具放在被 Git 忽略的 `data/host-tools` 中，每个版本使用独立目录；下载包最多 160 MiB，临时文件在退出时清理。已有目标目录时只验证版本，不覆盖或自动升级。默认只安装 Node.js；需要构建端口映射助手时，将代码中的 `tool_install_go=0` 改为 `tool_install_go=1`。不构建助手的桌面和纯终端节点都不需要 Go。

```bash
(
  set -eu
  tool_install_go=0
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

  if [ "$tool_install_go" = 1 ]; then
    if [ ! -e "$tool_root/go1.26.4" ]; then
      curl -fL --retry 3 --connect-timeout 15 --max-time 300 \
        --max-filesize 167772160 \
        "https://go.dev/dl/go1.26.4.linux-$tool_go_arch.tar.gz" \
        -o "$tool_tmp/go.tar.gz"
      printf '%s  %s\n' "$tool_go_sha" "$tool_tmp/go.tar.gz" | sha256sum -c -
      tar -xzf "$tool_tmp/go.tar.gz" -C "$tool_tmp"
      mv -T "$tool_tmp/go" "$tool_root/go1.26.4"
    fi
    test "$(GOTOOLCHAIN=local "$tool_root/go1.26.4/bin/go" env GOVERSION)" = go1.26.4
  fi
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
if command -v go >/dev/null 2>&1; then go version; fi
```

确认版本后可继续部署。后续终端需重新设置 PATH，或把对应的**实际绝对路径**加入当前用户的 `~/.profile`。不要原样把 `$PWD` 写进登录配置，它在其他目录中会指向不同位置。Node 路径会写入 systemd 用户服务，因此安装目录需要长期保留。

## 自建中继节点的完整顺序

在节点机器上按以下顺序操作，完整命令见[节点接入与恢复](selfhost-node.md)：

1. 以普通用户部署所选工作区模式，确认本机工作台就绪。
2. 从中心管理员取得绑定 slug 的 key，运行 `server:join`，在隐藏输入中填写 key。
3. 需要助手时，按最终入口运行 `npm run build:forward`。
4. 运行 `server:doctor`，再登录完整节点路径，在“端口映射”中核对四个平台下载。

`--build-forward` 适用于最终入口已经确定的部署；安装器会在更改服务前检查固定 Go 版本，`--check --build-forward` 也会检查。首次自建接入应先部署、再接入、最后构建，避免助手绑定 localhost 或旧节点地址。

入口变更后重新构建并下载。构建不重启工作台服务；节点在线或终端可用不等于助手已发布。中心服务器安装由[独立安装脚本](selfhost-server.md#中心安装)引导固定运行时，不使用本页的节点安装命令。

[文档目录](README.md) · [部署选择](deployment.md) · [维护排障](operations.md)
