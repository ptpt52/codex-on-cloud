export const SELFHOST_VERSIONS = Object.freeze({ node: '24.22.2', caddy: '2.11.9', frp: '0.72.0', coturn: '4.6.1-1build4', certbot: '2.9.0-1' });
const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])$/i;

export function serverDomain(value) {
  if (typeof value !== 'string' || !DOMAIN.test(value) || value.length > 253) throw Error('中心域名无效');
  return value.toLowerCase();
}

export function serverEmail(value) {
  if (typeof value !== 'string' || value.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) || /[\r\n\0]/.test(value)) throw Error('证书通知邮箱无效');
  return value;
}

export function caddyAcmeConfig(domain, webroot) {
  domain = serverDomain(domain);
  return `{
	admin off
	auto_https off
}

http://${domain} {
	root * ${webroot}
	handle /.well-known/acme-challenge/* {
		file_server
	}
	handle {
		redir https://{host}{uri} 308
	}
}
`;
}

export function caddyConfig(domain, { tlsDirectory = '/etc/codex-selfhost/tls', centerPort = 36180, frpHttpPort = 18080 } = {}) {
  domain = serverDomain(domain);
  return `{
	admin off
}

https://${domain} {
	tls ${tlsDirectory}/fullchain.pem ${tlsDirectory}/privkey.pem
	encode zstd gzip

	header {
		Strict-Transport-Security "max-age=31536000"
		X-Content-Type-Options "nosniff"
		Referrer-Policy "same-origin"
		-Server
	}

	handle /internal/* {
		respond 404
	}

	@nodeNoSlash path_regexp nodeNoSlash ^/node/([a-z0-9-]{1,48})$
	handle @nodeNoSlash {
		redir https://{host}/node/{re.nodeNoSlash.1}/ 308
	}

	handle /node/* {
		forward_auth 127.0.0.1:${centerPort} {
			uri /internal/route-auth?path={http.request.uri.path}
			copy_headers X-Selfhost-Node
		}
		reverse_proxy 127.0.0.1:${frpHttpPort} {
			header_up Host {host}
			flush_interval -1
			transport http {
				read_timeout 0
				write_timeout 0
			}
		}
	}

	handle {
		reverse_proxy 127.0.0.1:${centerPort}
	}
}
`;
}

export function frpsConfig({ bindPort = 7000, httpPort = 18080, adminPort = 17500, centerPort = 36180, token, adminPassword, tlsDirectory = '/etc/codex-selfhost/tls' }) {
  if (![bindPort, httpPort, adminPort, centerPort].every(port => Number.isInteger(port) && port > 1024 && port < 65536)) throw Error('frps 内部端口无效');
  if (typeof token !== 'string' || token.length < 32 || /[\r\n\0]/.test(token)) throw Error('frp token 无效');
  if (typeof adminPassword !== 'string' || adminPassword.length < 16 || /[\r\n\0]/.test(adminPassword)) throw Error('frps 管理密码无效');
  return `bindAddr = "0.0.0.0"
bindPort = ${bindPort}
proxyBindAddr = "127.0.0.1"
vhostHTTPPort = ${httpPort}
auth.token = ${JSON.stringify(token)}
transport.tls.force = true
transport.tls.certFile = "${tlsDirectory}/fullchain.pem"
transport.tls.keyFile = "${tlsDirectory}/privkey.pem"
log.to = "console"
log.level = "info"
log.maxDays = 7

webServer.addr = "127.0.0.1"
webServer.port = ${adminPort}
webServer.user = "admin"
webServer.password = ${JSON.stringify(adminPassword)}

[[httpPlugins]]
name = "codex-selfhost"
addr = "127.0.0.1:${centerPort}"
path = "/internal/frp-plugin"
ops = ["Login", "NewProxy", "CloseProxy", "Ping"]
`;
}

export function centerEnvironment({ domain, dataDirectory = '/var/lib/codex-selfhost', port = 36180, frpPort = 7000, configDirectory = '/etc/codex-selfhost' }) {
  domain = serverDomain(domain);
  return `SELFHOST_ORIGIN=https://${domain}
SELFHOST_PUBLIC_HOST=${domain}
SELFHOST_CENTER_PORT=${port}
SELFHOST_STATE_DIR=${dataDirectory}
SELFHOST_FRP_SERVER_PORT=${frpPort}
SELFHOST_FRP_TLS_NAME=${domain}
SELFHOST_TURN_SECRET_FILE=${configDirectory}/turn_secret
SELFHOST_TURN_REALM=${domain}
`;
}

export function coturnConfig({ domain, publicIp, secret, tlsDirectory = '/etc/codex-selfhost/tls' }) {
  domain = serverDomain(domain);
  if (typeof publicIp !== 'string' || !/^(?:\d{1,3}\.){3}\d{1,3}$/.test(publicIp) || publicIp.split('.').some(value => Number(value) > 255)) throw Error('TURN 公网 IPv4 无效');
  if (typeof secret !== 'string' || secret.length < 32 || /[\r\n\0]/.test(secret)) throw Error('TURN shared secret 无效');
  return `listening-port=3478
tls-listening-port=5349
realm=${domain}
server-name=${domain}
external-ip=${publicIp}
fingerprint
lt-cred-mech
use-auth-secret
static-auth-secret=${secret}
cert=${tlsDirectory}/turn-fullchain.pem
pkey=${tlsDirectory}/turn-privkey.pem
min-port=49160
max-port=49223
no-cli
no-multicast-peers
no-tcp-relay
no-tlsv1
no-tlsv1_1
stale-nonce=600
channel-lifetime=600
permission-lifetime=300
denied-peer-ip=0.0.0.0-0.255.255.255
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=100.64.0.0-100.127.255.255
denied-peer-ip=127.0.0.0-127.255.255.255
denied-peer-ip=169.254.0.0-169.254.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.0.0.0-192.0.2.255
denied-peer-ip=192.168.0.0-192.168.255.255
denied-peer-ip=198.18.0.0-198.19.255.255
denied-peer-ip=224.0.0.0-239.255.255.255
denied-peer-ip=240.0.0.0-255.255.255.255
`;
}

export function coturnUnit({ configDirectory = '/etc/codex-selfhost' } = {}) {
  return `[Unit]
Description=TURN relay for Codex on Cloud self-host center
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=120
StartLimitBurst=8

[Service]
Type=simple
User=turnserver
Group=turnserver
ExecStart=/usr/bin/turnserver -c ${configDirectory}/turnserver.conf
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
UMask=0077
LimitNOFILE=65536
MemoryMax=512M
TasksMax=2048

[Install]
WantedBy=multi-user.target
`;
}

export function centerUnit({ root = '/opt/codex-selfhost', configDirectory = '/etc/codex-selfhost', dataDirectory = '/var/lib/codex-selfhost' } = {}) {
  return `[Unit]
Description=Codex on Cloud self-host center
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=120
StartLimitBurst=8

[Service]
Type=simple
User=codex-selfhost
Group=codex-selfhost
WorkingDirectory=${root}/app
EnvironmentFile=${configDirectory}/server.env
ExecStart=${root}/bin/node ${root}/app/selfhost/main.mjs
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=${dataDirectory}
UMask=0077
LimitNOFILE=8192
MemoryMax=768M
TasksMax=256

[Install]
WantedBy=multi-user.target
`;
}

export function frpsUnit({ root = '/opt/codex-selfhost', configDirectory = '/etc/codex-selfhost' } = {}) {
  return `[Unit]
Description=Codex on Cloud frp server
After=network-online.target codex-selfhost-center.service
Wants=network-online.target
Requires=codex-selfhost-center.service
StartLimitIntervalSec=120
StartLimitBurst=8

[Service]
Type=simple
User=codex-selfhost
Group=codex-selfhost
ExecStart=${root}/bin/frps -c ${configDirectory}/frps.toml
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
UMask=0077
LimitNOFILE=65536
MemoryMax=512M
TasksMax=1024

[Install]
WantedBy=multi-user.target
`;
}

export function caddyUnit({ root = '/opt/codex-selfhost', configDirectory = '/etc/codex-selfhost', dataDirectory = '/var/lib/codex-selfhost' } = {}) {
  return `[Unit]
Description=Caddy for Codex on Cloud self-host center
After=network-online.target codex-selfhost-center.service
Wants=network-online.target codex-selfhost-center.service
StartLimitIntervalSec=120
StartLimitBurst=8

[Service]
Type=simple
ExecStart=${root}/bin/caddy run --config ${configDirectory}/Caddyfile
ExecReload=${root}/bin/caddy reload --config ${configDirectory}/Caddyfile
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadOnlyPaths=${configDirectory} /etc/letsencrypt
ReadWritePaths=${dataDirectory}
LimitNOFILE=65536
MemoryMax=512M
TasksMax=1024

[Install]
WantedBy=multi-user.target
`;
}

export function certbotHook(domain, { configDirectory = '/etc/codex-selfhost' } = {}) {
  domain = serverDomain(domain);
  return `#!/bin/sh
set -eu
install -d -o root -g codex-selfhost -m 0750 ${configDirectory}/tls
install -o root -g codex-selfhost -m 0640 /etc/letsencrypt/live/${domain}/fullchain.pem ${configDirectory}/tls/fullchain.pem
install -o root -g codex-selfhost -m 0640 /etc/letsencrypt/live/${domain}/privkey.pem ${configDirectory}/tls/privkey.pem
install -o root -g turnserver -m 0640 /etc/letsencrypt/live/${domain}/fullchain.pem ${configDirectory}/tls/turn-fullchain.pem
install -o root -g turnserver -m 0640 /etc/letsencrypt/live/${domain}/privkey.pem ${configDirectory}/tls/turn-privkey.pem
systemctl restart codex-selfhost-frps.service
systemctl reload codex-selfhost-caddy.service
systemctl restart codex-selfhost-coturn.service
`;
}
