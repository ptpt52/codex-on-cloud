package main

import (
	"crypto/x509"
	"errors"
	"net"
	"net/http"

	"github.com/gorilla/websocket"
)

// Only fixed messages reach the console; TLS, proxy and network errors can
// contain addresses or request metadata and must not be printed verbatim.
var failureMessages = map[string]string{
	"agent_key_invalid":            "助手授权 key 无效或已撤销，请向该节点管理员获取新的 key。",
	"agent_already_connected":      "此 key 已有一个助手在线；不同助手请使用各自独立的 key。",
	"agent_rule_mismatch":          "下发规则与映射握手不一致，本条映射未开启。",
	"node_changed":                 "控制台节点身份不一致，请核对授权 key 和入口。",
	"rtc_disabled":                 "管理员未启用直连，新连接使用 WSS 中转。",
	"rtc_waiting_helper":           "等待新版助手启用直连探测。",
	"rtc_connecting":               "正在探测加密直连；新连接可先使用 WSS 中转。",
	"rtc_unavailable":              "直连暂不可用，新连接回退 WSS 中转。",
	"rtc_negotiation_failed":       "直连协商未完成，稍后继续探测。",
	"rtc_ice_timeout":              "直连 UDP 路径未打通，稍后继续探测；新连接可使用 WSS 中转。",
	"rtc_dtls_timeout":             "直连 UDP 路径已通，但加密握手未完成；新连接可使用 WSS 中转。",
	"rtc_auth_timeout":             "直连加密握手已完成，但通道认证未就绪；新连接可使用 WSS 中转。",
	"rtc_health_timeout":           "直连心跳超时，新连接使用 WSS 中转。",
	"rtc_channel_failed":           "直连通道未能打开，新连接使用 WSS 中转。",
	"rtc_busy":                     "直连资源暂忙，稍后继续探测。",
	"rtc_draining":                 "直连通道正在轮换，新连接暂用 WSS 中转，已有连接保持原通道。",
	"pair_invalid":                 "规则通道授权无效，等待控制台重新下发。",
	"pair_expired":                 "规则通道授权已过期，等待控制台重新下发。",
	"pair_used":                    "规则通道授权已使用，等待控制台刷新状态。",
	"pairing_timeout":              "助手未及时建立规则通道，请检查助手状态。",
	"local_port_in_use":            "助手本机端口已被占用，请在规则配置中更换端口。",
	"local_listen_failed":          "助手本机端口无法监听，请检查端口权限或修改规则。",
	"reverse_upgrade_required":     "反向设备接入需要新版助手，请重新下载。",
	"reverse_denied":               "助手拒绝此规则，请检查目标与授权配置。",
	"reverse_confirm_timeout":      "助手未及时启动反向规则，请检查助手状态。",
	"reverse_port_in_use":          "服务器回环端口已被占用，请在规则配置中更换端口。",
	"reverse_listen_failed":        "服务器回环端口无法监听，请检查监听端口。",
	"reverse_stream_timeout":       "反向数据通道未及时就绪，此连接已关闭。",
	"serial_upgrade_required":      "串口接入需要新版助手，请重新下载。",
	"serial_busy":                  "串口已被占用，请关闭原客户端。",
	"serial_open_failed":           "串口无法打开，请检查设备名称、权限、占用或通信参数。",
	"serial_disconnected":          "串口已断开，此连接已关闭；不会自动重开或重发数据。",
	"serial_stalled":               "串口写入超时，请检查设备或降低发送速度。",
	"stopped":                      "映射已由网页明确停止。",
	"signed_out":                   "规则运行授权已结束。",
	"authorization_expired":        "规则运行授权已过期，等待控制台重新应用规则。",
	"authorization_revoked":        "规则运行授权已撤销，请检查助手 key 和规则状态。",
	"helper_disconnected":          "助手连接已中断，请检查助手进程与网络。",
	"helper_reconnecting":          "助手连接中断，正在等待自动恢复；已有 TCP 连接已关闭。",
	"helper_stopped":               "助手已停止，映射已关闭。",
	"resume_busy":                  "恢复握手正在进行，稍后重试。",
	"resume_expired":               "原通道恢复超时，控制台将重建映射；旧 TCP 由客户端重连。",
	"resume_authorization_invalid": "原恢复授权已失效，等待控制台重新应用规则。",
	"heartbeat_timeout":            "通道心跳超时，此连接已关闭；请检查网络或设备是否休眠。",
	"server_stopping":              "节点正在重启或停止，助手将重新接入并应用规则。",
	"protocol_error":               "助手与节点通信格式无效，请确认双方使用当前版本。",
	"target_unavailable":           "目标端口无法连接，请确认目标服务正在监听。",
	"target_timeout":               "连接目标端口超时，请检查目标服务。",
	"target_disconnected":          "目标服务异常断开了此 TCP 连接。",
	"relay_connect_timeout":        "建立数据通道超时，此连接已关闭；请检查网络或代理，客户端可重新连接。",
	"relay_ready_timeout":          "等待数据通道就绪超时；此连接已关闭，客户端可重新连接。",
	"relay_stream_timeout":         "数据通道收发超时，此连接已关闭；映射在线时可由客户端重新连接。",
	"relay_stream_disconnected":    "数据通道已断开；映射在线时可由客户端重新连接，无需重新配对。",
	"tcp_peer_stalled":             "TCP 接收端长时间未读取数据，此连接已关闭；请检查接收端。",
	"tcp_peer_disconnected":        "助手侧 TCP 对端异常断开，此连接已关闭；映射在线时可由客户端重新连接。",
	"connection_limit":             "映射已达到八条并发连接上限，请关闭不用的客户端连接。",
	"rate_limit":                   "连接尝试过于频繁，请等待十秒后手动重试。",
	"buffer_limit":                 "连接缓冲超限，此 TCP 连接已关闭，请检查接收端是否过慢。",
	"stream_authorization_invalid": "数据通道授权已失效，请检查该规则状态。",
	"tls_certificate":              "HTTPS 证书验证失败，请检查服务器证书、域名和电脑时间；不会跳过验证。",
	"dns_failed":                   "服务器域名解析失败，请检查地址和本机网络。",
	"network_timeout":              "网络连接超时，请检查网络或代理设置。",
	"network_disconnected":         "与服务器的网络连接已断开，请检查网络后重新配对。",
	"network_failed":               "无法连接服务器，请检查地址、网络和代理设置。",
	"access_denied":                "访问被拒绝，请检查网站地址、来源校验或外层访问认证。",
	"authorization_failed":         "服务器拒绝授权，请检查配对码及网站外层访问认证。",
	"outer_auth_required":          "网站要求额外访问认证，当前助手无法代办网页认证，请检查 Cloudflare Access 配置。",
	"server_unavailable":           "网站暂时不可用，请检查网页服务和中转入口。",
	"endpoint_missing":             "网站未提供端口映射接口，请检查地址或更新网页服务。",
}

type diagnostic struct{ code string }

func (d *diagnostic) Error() string { return failureMessages[d.code] }
func failure(code string) error {
	if _, ok := failureMessages[code]; !ok {
		code = "protocol_error"
	}
	return &diagnostic{code: code}
}

func dialFailure(err error, response *http.Response, path string) error {
	if response != nil {
		if code := response.Header.Get("X-Codex-Forward-Error"); failureMessages[code] != "" {
			return failure(code)
		}
		switch {
		case response.StatusCode >= 300 && response.StatusCode < 400:
			return failure("outer_auth_required")
		case response.StatusCode == 401 && path == "/forward/helper":
			return failure("authorization_failed")
		case response.StatusCode == 401 && path == "/forward/resume":
			return failure("resume_authorization_invalid")
		case response.StatusCode == 401:
			return failure("stream_authorization_invalid")
		case response.StatusCode == 403:
			return failure("access_denied")
		case response.StatusCode == 404:
			return failure("endpoint_missing")
		case response.StatusCode == 429:
			return failure("rate_limit")
		default:
			return failure("server_unavailable")
		}
	}
	var unknown x509.UnknownAuthorityError
	var hostname x509.HostnameError
	var invalid x509.CertificateInvalidError
	var dns *net.DNSError
	var network net.Error
	switch {
	case errors.As(err, &unknown), errors.As(err, &hostname), errors.As(err, &invalid):
		return failure("tls_certificate")
	case errors.As(err, &dns):
		return failure("dns_failed")
	case errors.As(err, &network) && network.Timeout():
		return failure("network_timeout")
	default:
		return failure("network_failed")
	}
}

func connectionFailure(err error) error {
	var known *diagnostic
	var closed *websocket.CloseError
	var network net.Error
	if errors.As(err, &known) {
		return known
	}
	if errors.As(err, &closed) && closed.Code == 4000 && failureMessages[closed.Text] != "" {
		return failure(closed.Text)
	}
	if errors.As(err, &network) && network.Timeout() {
		return failure("network_timeout")
	}
	return failure("network_disconnected")
}

func streamFailure(err error, timeoutCode string) error {
	classified := connectionFailure(err)
	var d *diagnostic
	if errors.As(classified, &d) {
		if d.code == "network_timeout" {
			return failure(timeoutCode)
		}
		if d.code == "network_disconnected" {
			return failure("relay_stream_disconnected")
		}
	}
	return classified
}

func tcpFailure(err error) error {
	var network net.Error
	if errors.As(err, &network) && network.Timeout() {
		return failure("tcp_peer_stalled")
	}
	return failure("tcp_peer_disconnected")
}
