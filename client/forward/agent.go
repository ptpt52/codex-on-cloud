package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"reflect"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

type forwardNodeContext struct{}
type agentGrant struct {
	Version int    `json:"version"`
	Server  string `json:"server"`
	Node    string `json:"node"`
	Agent   string `json:"agent"`
	Secret  string `json:"secret"`
}

func parseAgentKey(key string) (agentGrant, *url.URL, error) {
	var grant agentGrant
	invalid := errors.New("助手授权 key 格式无效，请从控制台完整复制")
	if len(key) > 2048 || !strings.HasPrefix(key, "COCA1.") {
		return grant, nil, invalid
	}
	data, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(key, "COCA1."))
	if err != nil {
		return grant, nil, invalid
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&grant) != nil || decoder.Decode(new(any)) != io.EOF || grant.Version != 1 || !mappingPattern.MatchString(grant.Agent) || !tokenPattern.MatchString(grant.Secret) || grant.Node != "" && !mappingPattern.MatchString(grant.Node) {
		return grant, nil, invalid
	}
	server, err := serverURL(grant.Server)
	if err != nil {
		return grant, nil, invalid
	}
	return grant, server, nil
}

type agentRuleConfig struct {
	Direction  string        `json:"direction"`
	DeviceName string        `json:"deviceName"`
	Protocol   string        `json:"protocol"`
	LocalPort  int           `json:"localPort"`
	TargetHost string        `json:"targetHost"`
	TargetPort int           `json:"targetPort"`
	Serial     *serialConfig `json:"serial"`
}
type managedRule struct {
	ID        string          `json:"id"`
	Revision  int64           `json:"revision"`
	Name      string          `json:"name"`
	MappingID string          `json:"mappingId"`
	Code      string          `json:"code"`
	Config    agentRuleConfig `json:"config"`
}

func (r managedRule) valid() bool {
	c := r.Config
	if !mappingPattern.MatchString(r.ID) || !mappingPattern.MatchString(r.MappingID) || !tokenPattern.MatchString(r.Code) || r.Revision < 1 || r.Revision > 9007199254740991 || !validDeviceName(r.Name) || c.LocalPort < 1024 || c.LocalPort > 65535 {
		return false
	}
	if c.Direction != "" && c.Direction != "reverse" {
		return false
	}
	if c.Direction == "reverse" && !validDeviceName(c.DeviceName) {
		return false
	}
	if c.Serial != nil {
		return c.Direction == "reverse" && c.Protocol == "serial" && (c.Serial.valid("windows") || c.Serial.valid("darwin")) && c.TargetPort == 0 && c.TargetHost == ""
	}
	return (c.Protocol == "" || c.Protocol == "tcp" || c.Protocol == "ssh" || c.Protocol == "telnet") && net.ParseIP(c.TargetHost) != nil && c.TargetPort >= 1 && c.TargetPort <= 65535
}

func (r managedRule) matches(ready readyMessage) bool {
	c := r.Config
	if ready.ID != r.MappingID || ready.LocalPort != c.LocalPort || ready.Direction != c.Direction || !sameSerial(c.Serial, ready.Serial) {
		return false
	}
	if c.Direction == "reverse" {
		if ready.DeviceName != c.DeviceName {
			return false
		}
	}
	if c.Serial != nil {
		return ready.Protocol == "serial"
	}
	// Older v1 TCP handshakes omit the descriptive ssh/telnet/tcp label.
	if ready.Protocol != "" && ready.Protocol != "tcp" && ready.Protocol != c.Protocol {
		return false
	}
	return ready.TargetPort == c.TargetPort && net.ParseIP(ready.TargetHost).Equal(net.ParseIP(c.TargetHost))
}

// Console output has no file or retained history, at most 120 short writes per
// minute. Per-rule diagnostics retain their existing category bounds.
type agentOutput struct {
	sync.Mutex
	writer io.Writer
	since  time.Time
	count  int
}

func (o *agentOutput) Write(data []byte) (int, error) {
	o.Lock()
	defer o.Unlock()
	if time.Since(o.since) >= time.Minute {
		o.since = time.Now()
		o.count = 0
	}
	if o.count >= 120 {
		return len(data), nil
	}
	o.count++
	part := data
	if len(part) > 8192 {
		part = part[:8192]
	}
	_, err := o.writer.Write(part)
	return len(data), err
}

type ruleOutput struct {
	name   string
	writer io.Writer
}

func (o ruleOutput) Write(data []byte) (int, error) {
	_, err := fmt.Fprintf(o.writer, "[%s] %s", o.name, data)
	return len(data), err
}

type ruleResult struct {
	Type      string `json:"type"`
	ID        string `json:"id"`
	MappingID string `json:"mappingId"`
	Revision  int64  `json:"revision"`
	Error     string `json:"error"`
}
type agentWorker struct {
	rule   managedRule
	cancel context.CancelFunc
	done   chan struct{}
	result ruleResult
}
type agentRuntime struct {
	ctx     context.Context
	server  *url.URL
	output  *agentOutput
	workers map[string]*agentWorker
	results chan ruleResult
	mu      sync.Mutex
	wg      sync.WaitGroup
}

func (a *agentRuntime) apply(rules []managedRule) error {
	if len(rules) > 16 {
		return failure("protocol_error")
	}
	next := make(map[string]managedRule)
	for _, rule := range rules {
		if !rule.valid() {
			return failure("protocol_error")
		}
		if _, ok := next[rule.ID]; ok {
			return failure("protocol_error")
		}
		next[rule.ID] = rule
	}
	changed := false
	deadline, cancel := context.WithTimeout(a.ctx, 5*time.Second)
	defer cancel()
	for id, worker := range a.workers {
		rule, ok := next[id]
		if ok && worker.rule.MappingID == rule.MappingID {
			if !reflect.DeepEqual(worker.rule, rule) {
				return failure("agent_rule_mismatch")
			}
			continue
		}
		worker.cancel()
		changed = true
	}
	for id, worker := range a.workers {
		if rule, ok := next[id]; ok && worker.rule.MappingID == rule.MappingID {
			continue
		}
		select {
		case <-worker.done:
			delete(a.workers, id)
		case <-deadline.Done():
			return failure("protocol_error")
		}
	}
	for _, rule := range rules {
		if _, ok := a.workers[rule.ID]; ok {
			continue
		}
		ctx, stop := context.WithCancel(a.ctx)
		worker := &agentWorker{rule: rule, cancel: stop, done: make(chan struct{})}
		a.workers[rule.ID] = worker
		changed = true
		a.wg.Add(1)
		go func() {
			defer a.wg.Done()
			defer close(worker.done)
			// Entering the helper's revocable long-lived key authorizes this
			// node to configure local TCP and serial targets for this process.
			err := runWithRule(ctx, a.server, rule.Code, ruleOutput{rule.Name, a.output}, func(context.Context, readyMessage) error { return nil }, &rule)
			result := ruleResult{Type: "rule-result", ID: rule.ID, MappingID: rule.MappingID, Revision: rule.Revision}
			if err != nil && ctx.Err() == nil {
				result.Error = safeAgentText(connectionFailure(err).Error(), 256)
				fmt.Fprintf(a.output, "[%s] 映射未生效：%s\n", rule.Name, result.Error)
			}
			a.mu.Lock()
			worker.result = result
			a.mu.Unlock()
			if ctx.Err() == nil {
				select {
				case a.results <- result:
				default:
				}
			}
		}()
	}
	if changed {
		fmt.Fprintf(a.output, "当前正在执行 %d 条映射规则：\n", len(rules))
		for _, r := range rules {
			if r.Config.Serial != nil {
				fmt.Fprintf(a.output, "- %s：服务器 127.0.0.1:%d → 串口 %s\n", r.Name, r.Config.LocalPort, r.Config.Serial.label())
			} else if r.Config.Direction == "reverse" {
				fmt.Fprintf(a.output, "- %s：服务器 127.0.0.1:%d → 助手网络 %s\n", r.Name, r.Config.LocalPort, net.JoinHostPort(r.Config.TargetHost, fmt.Sprint(r.Config.TargetPort)))
			} else {
				fmt.Fprintf(a.output, "- %s：助手 127.0.0.1:%d → 节点网络 %s\n", r.Name, r.Config.LocalPort, net.JoinHostPort(r.Config.TargetHost, fmt.Sprint(r.Config.TargetPort)))
			}
		}
	}
	return nil
}
func (a *agentRuntime) close() {
	for _, worker := range a.workers {
		worker.cancel()
	}
	a.wg.Wait()
}

type agentReady struct {
	Type    string `json:"type"`
	Version int    `json:"version"`
	ID      string `json:"id"`
	Name    string `json:"name"`
	Node    struct {
		Entry string `json:"entry"`
		ID    string `json:"id"`
	} `json:"node"`
	RuleLimit         int `json:"ruleLimit"`
	InventoryInterval int `json:"inventoryIntervalMs"`
}

func runAgent(ctx context.Context, key string, writer io.Writer) error {
	grant, server, err := parseAgentKey(key)
	if err != nil {
		return err
	}
	ctx = context.WithValue(ctx, forwardNodeContext{}, grant.Node)
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	output := &agentOutput{writer: writer}
	manager := &agentRuntime{ctx: ctx, server: server, output: output, workers: make(map[string]*agentWorker), results: make(chan ruleResult, 32)}
	defer manager.close()
	link := &managementLink{ctx: ctx}
	defer link.close(true)
	requestInventory := make(chan struct{}, 1)
	inventoryDone := make(chan struct{})
	go func() {
		defer close(inventoryDone)
		ticker := time.NewTicker(30 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			case <-requestInventory:
			}
			if link.available() {
				_ = link.write(collectAgentInventory(ctx))
			}
		}
	}()
	defer func() { cancel(); <-inventoryDone }()
	var nonce [16]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		return errors.New("无法生成助手实例身份")
	}
	instance := hex.EncodeToString(nonce[:])
	for attempt := 0; ; attempt++ {
		if ctx.Err() != nil {
			return nil
		}
		conn, err := dialHeaders(ctx, server, "/forward/agent", grant.Agent+"."+grant.Secret, http.Header{"X-Codex-Agent-Instance": {instance}})
		if err == nil {
			err = agentSession(ctx, conn, grant, server, manager, link, requestInventory)
			link.offline(conn)
		}
		if ctx.Err() != nil {
			return nil
		}
		if err == nil {
			return nil
		}
		if !canResume(err) {
			return err
		}
		delay := min(time.Second*time.Duration(1<<min(attempt, 4)), 15*time.Second)
		fmt.Fprintf(output, "控制台连接中断，%d 秒后重连；已断开的 TCP 和串口数据不会重放。\n", int(delay/time.Second))
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return nil
		case <-timer.C:
		}
	}
}

func agentSession(ctx context.Context, conn *websocket.Conn, grant agentGrant, server *url.URL, manager *agentRuntime, link *managementLink, inventory chan<- struct{}) error {
	stop := context.AfterFunc(ctx, func() {
		conn.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(1000, "client_stopping"), time.Now().Add(time.Second))
		conn.Close()
	})
	defer stop()
	kind, data, err := conn.ReadMessage()
	if err != nil {
		return connectionFailure(err)
	}
	var ready agentReady
	if kind != websocket.TextMessage || json.Unmarshal(data, &ready) != nil || ready.Type != "agent-ready" || ready.Version != 1 || ready.ID != grant.Agent || !validDeviceName(ready.Name) || ready.Node.ID != grant.Node || ready.RuleLimit < 1 || ready.RuleLimit > 16 || ready.InventoryInterval != 30000 {
		return failure("protocol_error")
	}
	entry, err := serverURL(ready.Node.Entry)
	if err != nil || entry.String() != server.String() {
		return failure("node_changed")
	}
	if err = link.install(conn); err != nil {
		return err
	}
	conn.SetReadDeadline(time.Now().Add(45 * time.Second))
	fmt.Fprintf(manager.output, "正在被控制台节点控制：%s（节点 %s）\n助手：%s · %s\n", entry, ready.Node.ID, ready.Name, ready.ID)
	fmt.Fprintln(manager.output, "此 key 允许该节点动态配置本机网络及串口；仅监听回环地址。Ctrl+C 停止所有映射。")
	for _, worker := range manager.workers {
		manager.mu.Lock()
		result := worker.result
		manager.mu.Unlock()
		if result.Type != "" {
			_ = link.write(result)
		}
	}
	type packet struct {
		kind int
		data []byte
		err  error
	}
	packets := make(chan packet, 1)
	reading := make(chan struct{})
	readCtx, cancelRead := context.WithCancel(ctx)
	go func() {
		defer close(reading)
		for {
			kind, data, err := conn.ReadMessage()
			select {
			case packets <- packet{kind, data, err}:
			case <-readCtx.Done():
				return
			}
			if err != nil {
				return
			}
		}
	}()
	defer func() { cancelRead(); conn.Close(); <-reading }()
	for {
		select {
		case <-ctx.Done():
			return nil
		case result := <-manager.results:
			if err := link.write(result); err != nil {
				return connectionFailure(err)
			}
		case packet := <-packets:
			if packet.err != nil {
				return connectionFailure(packet.err)
			}
			var message struct {
				Type    string        `json:"type"`
				Version int           `json:"version"`
				Rules   []managedRule `json:"rules"`
			}
			if packet.kind != websocket.TextMessage || json.Unmarshal(packet.data, &message) != nil {
				return failure("protocol_error")
			}
			switch message.Type {
			case "inventory-request":
				select {
				case inventory <- struct{}{}:
				default:
				}
			case "rules":
				if message.Version != 1 {
					return failure("protocol_error")
				}
				if err := manager.apply(message.Rules); err != nil {
					return err
				}
			default:
				return failure("protocol_error")
			}
		}
	}
}
