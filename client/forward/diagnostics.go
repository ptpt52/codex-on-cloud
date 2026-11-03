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
	"rtc_disabled":                 "管理员未启用直连，新连接使用 WSS 中转。",
	"rtc_waiting_helper":           "等待新版助手启用直连探测。",
	"rtc_connecting":               "正在探测加密直连；新连接可先使用 WSS 中转。",
	"rtc_unavailable":              "直连暂不可用，新连接回退 WSS 中转。",
	"rtc_negotiation_failed":       "直连协商未完成，稍后继续探测。",
	"rtc_health_timeout":           "直连心跳超时，新连接使用 WSS 中转。",
	"rtc_channel_failed":           "直连通道未能打开，新连接使用 WSS 中转。",
	"rtc_busy":                     "直连资源暂忙，稍后继续探测。",
	"rtc_draining":                 "直连通道正在轮换，新连接暂用 WSS 中转，已有连接保持原通道。",
	"pair_invalid":                 "配对码无效，请从网页重新生成并完整复制。",
	"pair_expired":                 "配对码已过期，请重新生成。",
	"pair_used":                    "配对码已使用，请重新生成；现有助手无需重复配对。",
	"pairing_timeout":              "助手未在五秒内完成启动，请检查助手后重新配对。",
	"local_port_in_use":            "Windows 本机端口已被占用，请换一个本机端口后重新配对。",
	"local_listen_failed":          "Windows 本机端口无法监听，请检查本机端口权限后重新配对。",
	"stopped":                      "映射已由网页明确停止。",
	"signed_out":                   "创建此映射的登录已退出，授权已撤销。",
	"authorization_expired":        "创建此映射的登录已过期，请重新登录并配对。",
	"authorization_revoked":        "映射授权已失效，请重新登录并配对。",
	"helper_disconnected":          "助手已关闭或网络连接已中断，请检查助手后重新配对。",
	"heartbeat_timeout":            "连接心跳超时，请检查网络或设备是否休眠，然后重新配对。",
	"server_stopping":              "网页服务正在重启或停止，请稍后重新配对。",
	"protocol_error":               "助手与服务器通信格式无效，请更新助手后重新配对。",
	"target_unavailable":           "服务器目标端口无法连接，请确认目标服务正在监听。",
	"target_timeout":               "连接服务器目标端口超时，请检查目标服务。",
	"target_disconnected":          "服务器目标服务异常断开了此 TCP 连接。",
	"connection_limit":             "映射已达到八条并发连接上限，请关闭不用的客户端连接。",
	"rate_limit":                   "连接尝试过于频繁，请等待十秒后手动重试。",
	"buffer_limit":                 "连接缓冲超限，此 TCP 连接已关闭，请检查接收端是否过慢。",
	"stream_authorization_invalid": "数据通道授权已失效，请检查映射状态并重新配对。",
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
