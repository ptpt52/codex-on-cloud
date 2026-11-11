package main

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"os"
	"os/exec"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"go.bug.st/serial"
)

type agentIPv4 struct {
	Address string `json:"address"`
	Prefix  int    `json:"prefix"`
}
type agentInterface struct {
	Name      string      `json:"name"`
	Index     int         `json:"index"`
	Up        bool        `json:"up"`
	Error     bool        `json:"error"`
	Addresses []agentIPv4 `json:"addresses"`
}
type agentInventoryReport struct {
	Type        string           `json:"type"`
	SerialPorts []string         `json:"serialPorts"`
	Interfaces  []agentInterface `json:"interfaces"`
	Truncated   bool             `json:"truncated"`
	Error       string           `json:"error"`
}

func safeAgentText(value string, maximum int) string {
	value = strings.ToValidUTF8(value, "?")
	var result strings.Builder
	for _, r := range value {
		if unicode.IsControl(r) || unicode.Is(unicode.Cf, r) {
			continue
		}
		if result.Len()+utf8.RuneLen(r) > maximum {
			break
		}
		result.WriteRune(r)
	}
	return result.String()
}

func runSerialListWorker(output io.Writer) error {
	ports, err := serial.GetPortsList()
	result := struct {
		Ports     []string `json:"ports"`
		Error     string   `json:"error"`
		Truncated bool     `json:"truncated"`
	}{Ports: []string{}}
	if err != nil {
		result.Error = "serial_list_failed"
	}
	sort.Strings(ports)
	seen := make(map[string]bool)
	for _, port := range ports {
		if len(port) > 192 || !serialPath.MatchString(port) || seen[port] {
			continue
		}
		seen[port] = true
		if len(result.Ports) >= 128 {
			result.Truncated = true
			break
		}
		result.Ports = append(result.Ports, port)
	}
	return json.NewEncoder(output).Encode(result)
}

// Enumeration never opens a serial device. Isolate the driver enumeration in
// one fixed-action child with a three-second deadline and a 32 KiB output cap.
func agentSerialPorts(ctx context.Context) ([]string, string, bool) {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	executable, err := os.Executable()
	if err != nil {
		return []string{}, "serial_list_failed", false
	}
	command := exec.CommandContext(ctx, executable, "--serial-list-worker", strconv.Itoa(os.Getpid()))
	pipe, err := command.StdoutPipe()
	if err != nil {
		return []string{}, "serial_list_failed", false
	}
	command.Stderr = io.Discard
	if command.Start() != nil {
		return []string{}, "serial_list_failed", false
	}
	data, readErr := io.ReadAll(io.LimitReader(pipe, 32769))
	if len(data) > 32768 {
		_ = command.Process.Kill()
	}
	waitErr := command.Wait()
	if readErr != nil || waitErr != nil || len(data) > 32768 {
		return []string{}, "serial_list_failed", false
	}
	var value struct {
		Ports     []string `json:"ports"`
		Error     string   `json:"error"`
		Truncated bool     `json:"truncated"`
	}
	if json.Unmarshal(data, &value) != nil || len(value.Ports) > 128 || value.Error != "" && value.Error != "serial_list_failed" {
		return []string{}, "serial_list_failed", false
	}
	for _, port := range value.Ports {
		if len(port) > 192 || !serialPath.MatchString(port) {
			return []string{}, "serial_list_failed", false
		}
	}
	if value.Ports == nil {
		value.Ports = []string{}
	}
	return value.Ports, value.Error, value.Truncated
}

func collectAgentInventory(ctx context.Context) agentInventoryReport {
	result := agentInventoryReport{Type: "inventory", SerialPorts: []string{}, Interfaces: []agentInterface{}}
	interfaces, err := net.Interfaces()
	if err != nil {
		result.Error = "inventory_failed"
	}
	sort.Slice(interfaces, func(i, j int) bool { return interfaces[i].Index < interfaces[j].Index })
	addressCount := 0
	for _, iface := range interfaces {
		if len(result.Interfaces) >= 128 {
			result.Truncated = true
			break
		}
		item := agentInterface{Name: safeAgentText(iface.Name, 128), Index: iface.Index, Up: iface.Flags&net.FlagUp != 0, Addresses: []agentIPv4{}}
		if item.Name == "" || item.Index < 1 {
			result.Truncated = true
			continue
		}
		addresses, err := iface.Addrs()
		item.Error = err != nil
		seen := make(map[string]bool)
		for _, address := range addresses {
			ip, network, err := net.ParseCIDR(address.String())
			if err != nil || ip.To4() == nil {
				continue
			}
			prefix, _ := network.Mask.Size()
			value := agentIPv4{Address: ip.To4().String(), Prefix: prefix}
			if seen[address.String()] {
				continue
			}
			seen[address.String()] = true
			if len(item.Addresses) >= 32 || addressCount >= 1024 {
				result.Truncated = true
				break
			}
			item.Addresses = append(item.Addresses, value)
			addressCount++
		}
		result.Interfaces = append(result.Interfaces, item)
	}
	ports, serialError, truncated := agentSerialPorts(ctx)
	result.SerialPorts = ports
	result.Truncated = result.Truncated || truncated
	if result.Error == "" {
		result.Error = serialError
	}
	return boundedAgentInventory(result)
}

// Preserve a visible truncation marker instead of sending an oversized control
// message. No inventory history or device addresses are written to disk.
func boundedAgentInventory(result agentInventoryReport) agentInventoryReport {
	for {
		data, _ := json.Marshal(result)
		if len(data) <= 32768 {
			return result
		}
		result.Truncated = true
		if len(result.Interfaces) > 0 {
			result.Interfaces = result.Interfaces[:len(result.Interfaces)-1]
		} else if len(result.SerialPorts) > 0 {
			result.SerialPorts = result.SerialPorts[:len(result.SerialPorts)-1]
		} else {
			return result
		}
	}
}
