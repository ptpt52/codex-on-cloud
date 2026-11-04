package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/url"
	"regexp"
	"sync"
	"time"
)

const resumeWindow = 30 * time.Second
const resumeAttempts = 8

type resumeState struct {
	token, id             string
	targetHost            string
	localPort, targetPort int
	deadline              time.Time
	active                bool
}

var mappingPattern = regexp.MustCompile(`^[a-f0-9]{32}$`)

func (s *resumeState) accept(ready readyMessage) error {
	host := ready.targetIP()
	if host == "" {
		return failure("protocol_error")
	}
	if s.token != "" {
		if ready.ResumeProtocol != 1 || ready.ResumeToken != "" || ready.ID != s.id || ready.LocalPort != s.localPort || host != s.targetHost || ready.TargetPort != s.targetPort || ready.ResumeMs < 1 || ready.ResumeMs > int(resumeWindow/time.Millisecond) {
			return failure("protocol_error")
		}
		deadline := time.Now().Add(time.Duration(ready.ResumeMs) * time.Millisecond)
		if deadline.Before(s.deadline) {
			s.deadline = deadline
		}
		return nil
	}
	if ready.ResumeProtocol == 0 && ready.ResumeToken == "" && ready.ResumeMs == 0 {
		return nil // Older servers keep their explicit re-pairing behavior.
	}
	if ready.ResumeProtocol != 1 || !tokenPattern.MatchString(ready.ResumeToken) || !mappingPattern.MatchString(ready.ID) || ready.ResumeMs != int(resumeWindow/time.Millisecond) {
		return failure("protocol_error")
	}
	s.token, s.id, s.localPort, s.targetPort = ready.ResumeToken, ready.ID, ready.LocalPort, ready.TargetPort
	s.targetHost = host
	return nil
}

// Reconnect only management authorization. A failed TCP stream is never passed
// back to proxy(), and the original one-time pairing code is never submitted twice.
func canResume(err error) bool {
	var d *diagnostic
	if !errors.As(err, &d) {
		return false
	}
	switch d.code {
	case "helper_reconnecting", "resume_busy", "network_disconnected", "network_timeout", "network_failed", "dns_failed", "server_unavailable":
		return true
	}
	return false
}

type runOutput struct {
	sync.Mutex
	writer io.Writer
	counts [3]int
}

func (o *runOutput) print(category int, format string, args ...any) {
	o.Lock()
	defer o.Unlock()
	if o.counts[category] >= 20 {
		return
	}
	fmt.Fprintf(o.writer, format+"\n", args...)
	o.counts[category]++
	if o.counts[category] == 20 {
		labels := []string{"连接错误", "通道状态", "恢复状态"}
		fmt.Fprintf(o.writer, "%s提示已达到本次运行的 20 条上限，最新状态请查看网页。\n", labels[category])
	}
}

func run(ctx context.Context, server *url.URL, code string, writer io.Writer) error {
	if !tokenPattern.MatchString(code) {
		return errors.New("配对码格式不正确，请重新从网页复制")
	}
	output := &runOutput{writer: writer}
	state := &resumeState{}
	attempts := 0
	for {
		state.active = false
		err := runSession(ctx, server, code, state, output)
		code = "" // Pair exactly once; resume uses only the scoped capability.
		if ctx.Err() != nil || err == nil {
			return nil
		}
		if state.token == "" || !canResume(err) {
			return err
		}
		if state.active || state.deadline.IsZero() {
			state.deadline, attempts = time.Now().Add(resumeWindow), 0
		}
		if attempts >= resumeAttempts || !time.Now().Before(state.deadline) {
			return failure("resume_expired")
		}
		delay := time.Second * time.Duration(1<<min(attempts, 3))
		attempts++
		if remaining := time.Until(state.deadline); delay > remaining {
			delay = remaining
		}
		output.print(2, "连接中断，正在自动恢复映射（第 %d 次，最多 30 秒）；原 TCP 连接已关闭，请由客户端重新连接。", attempts)
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return nil
		case <-timer.C:
		}
		if !time.Now().Before(state.deadline) {
			return failure("resume_expired")
		}
	}
}
