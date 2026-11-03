package main

import "testing"

func TestServerURL(t *testing.T) {
	valid := map[string]string{
		"https://example.com/":       "https://example.com",
		"https://example.com:443":    "https://example.com",
		"https://[2001:db8::1]:443/": "https://[2001:db8::1]",
		"http://127.0.0.1:1234":      "http://127.0.0.1:1234",
		"http://localhost:36080/":    "http://localhost:36080",
	}
	for input, expected := range valid {
		result, err := serverURL(input)
		if err != nil || result.String() != expected {
			t.Fatalf("Invalid normalized server for %q", input)
		}
	}
	for _, input := range []string{
		"example.com", "http://example.com", "http://192.168.1.1", "http://localhost.evil.test",
		"https://user:secret@example.com", "https://example.com/path", "https://example.com/?token=secret",
		"https://example.com/#secret", "file:///tmp/config", "wss://example.com",
	} {
		if _, err := serverURL(input); err == nil {
			t.Fatalf("Accepted an invalid server address: %q", input)
		}
	}
}
