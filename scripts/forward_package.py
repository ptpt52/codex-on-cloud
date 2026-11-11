"""Build a bounded macOS ZIP using only the server's Python standard library."""
import argparse
import io
from pathlib import Path
import struct
import zipfile

MAX_FILE = 32 * 1024 * 1024
CPUS = {"darwin-arm64": 0x0100000C, "darwin-amd64": 0x01000007}
LAUNCHER = b'''#!/bin/sh
set -eu
FORWARD_LAUNCH_DIR=$(CDPATH= cd -P "$(dirname "$0")" && pwd)
exec "$FORWARD_LAUNCH_DIR/codex-cloud-forward" "$@"
'''


def validate_macho(data, arch):
    if arch not in CPUS or not 32 <= len(data) <= MAX_FILE:
        raise ValueError("Invalid macOS helper size or architecture")
    magic, cpu, _, kind, count, size, _, _ = struct.unpack_from("<8I", data)
    if magic != 0xFEEDFACF or cpu != CPUS[arch] or kind != 2 or count > 128 or size > len(data) - 32:
        raise ValueError("Expected a matching 64-bit Mach-O executable")
    cursor, minimum, signature = 32, None, False
    for _ in range(count):
        if cursor + 8 > 32 + size:
            raise ValueError("Truncated Mach-O commands")
        command, length = struct.unpack_from("<2I", data, cursor)
        if length < 8 or length % 4 or cursor + length > 32 + size:
            raise ValueError("Invalid Mach-O command size")
        if command == 0x32:
            if length < 24:
                raise ValueError("Truncated build version")
            platform, minimum = struct.unpack_from("<2I", data, cursor + 8)
            if platform != 1 or minimum != 12 << 16:
                raise ValueError("Expected the pinned macOS 12 deployment target")
        if command == 0x1D:
            if length < 16:
                raise ValueError("Truncated code signature command")
            offset, length_bytes = struct.unpack_from("<2I", data, cursor + 8)
            if offset < 32 + size or length_bytes < 12 or offset + length_bytes > len(data):
                raise ValueError("Invalid code signature range")
            magic_signature, blob_length = struct.unpack_from(">2I", data, offset)
            if magic_signature != 0xFADE0CC0 or not 12 <= blob_length <= length_bytes:
                raise ValueError("Missing embedded code signature")
            signature = True
        cursor += length
    if cursor != 32 + size or minimum is None or arch == "darwin-arm64" and not signature:
        raise ValueError("Missing build version or Apple Silicon ad-hoc signature")


def package_bytes(data, arch):
    validate_macho(data, arch)
    chip = "Apple Silicon（M 系列）" if arch == "darwin-arm64" else "Intel"
    folder = "codex-cloud-forward-macos-" + arch.split("-")[1]
    readme = f'''Codex Cloud TCP 端口映射助手 — Mac {chip}

需要 macOS 12 或更新版本。无需安装 Go、Node.js 或 Python。
解压后双击 Start.command，保持终端窗口打开，粘贴对应节点“助手1”至“助手8”页面中显示的 key。
每台电脑只需运行一个助手，可由控制台动态增删多条端口或串口规则。
固定八个助手使用独立 key；同一个 key 同时只允许一个助手实例，后来连接不会抢占。
串口列表、网卡名称和全部 IPv4 信息自动返回授权节点，网页可刷新和手填串口。
也可在终端进入本文件夹运行 ./codex-cloud-forward。
key 自带节点入口和身份；程序不接受一次性配对码或 --server / --allow-reverse 参数。
使用 --version 查看版本，--licenses 查看依赖许可证。

如果出现“Apple 无法验证 codex-cloud-forward”：
1. 确认下载来源并核对网页显示的 ZIP SHA256，尝试打开后点击“完成”或“取消”。
2. 打开“系统设置 → 隐私与安全性”，向下滚动到“安全性”，
   找到刚被阻止的 codex-cloud-forward，点击“仍要打开”，按系统提示确认。
3. 重新双击 Start.command。如果被阻止的是 Start.command，也需对该文件确认。
没有“仍要打开”时，先在解压文件夹中双击 codex-cloud-forward，再返回设置查看。
Apple 官方说明：
https://support.apple.com/zh-cn/102445
本包未进行 Developer ID 分发签名或 Apple 公证；ARM64 程序含 Go 链接器生成的 ad-hoc 签名。
不要关闭系统的整体安全检查。允许本地网络访问后可探测局域网直连。

正向模式：助手只监听本机 127.0.0.1，目标从服务器所在网络访问。
反向模式：服务器只监听其 127.0.0.1，本助手访问本机或局域网内的固定设备目标。
长期 key 允许其所属节点动态配置本机可达网络和串口；助手打印控制节点和规则。
实际端口以网页配置为准；用网页“复制连接信息”取得入口和示例。
SSH 等服务的账号和主机指纹仍由原客户端验证，本助手不保存设备密码或私钥。
常驻规则保存在节点，关闭网页、锁屏、接管或退出登录不会撤销助手 key。
修改、停用或删除一条规则只关闭这一条的原连接；其他规则继续运行。
控制链路重连可保留健康数据连接；已断开的 TCP/串口字节不重放。
节点重启后凭原 key 恢复已保存规则，业务客户端自行建立新 TCP。
Ctrl+C 停止所有本机规则；网页“刷新 key”会撤销旧 key 并断开该助手，规则保留，其他助手不受影响。
助手只在内存使用 key 和运行凭据，不设置自启动、不安装服务、不保存流量日志。
节点私有配置保存八个 key，管理员可随时复制、单独刷新；普通部署不换 key。
'''.encode("utf-8")
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for name, content, mode in [("codex-cloud-forward", data, 0o755), ("Start.command", LAUNCHER, 0o755), ("README.txt", readme, 0o644)]:
            entry = zipfile.ZipInfo(folder + "/" + name, (2020, 1, 1, 0, 0, 0))
            entry.create_system = 3
            entry.external_attr = (0o100000 | mode) << 16
            entry.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(entry, content)
    result = buffer.getvalue()
    if len(result) > MAX_FILE:
        raise ValueError("macOS ZIP exceeds 32 MiB")
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("arch", choices=CPUS)
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    with args.source.open("rb") as source:
        data = source.read(MAX_FILE + 1)
    payload = package_bytes(data, args.arch)
    with args.output.open("xb") as output:
        output.write(payload)


if __name__ == "__main__":
    main()
