package main

import (
	"testing"
)

func TestGetSupportedLanguages(t *testing.T) {
	langs := getSupportedLanguages()
	if len(langs) == 0 {
		t.Fatal("expected at least one supported language")
	}

	foundPy := false
	foundJS := false
	foundTS := false
	for _, l := range langs {
		if l == "python" {
			foundPy = true
		}
		if l == "javascript" {
			foundJS = true
		}
		if l == "typescript" {
			foundTS = true
		}
		if l == "go" {
			t.Error("Go should not be in supported languages as it cannot meet strict noexec isolation")
		}
	}

	if !foundPy || !foundJS || !foundTS {
		t.Errorf("expected python, javascript, typescript; got %v", langs)
	}
}

func TestParseMemBytes(t *testing.T) {
	cases := []struct {
		input    string
		expected int64
	}{
		{"", 0},
		{"100B", 100},
		{"1KiB", 1024},
		{"1MiB", 1048576},
		{"14.2MiB", 14889779},
		{"1GiB", 1073741824},
	}

	for _, tc := range cases {
		got := parseMemBytes(tc.input)
		// Allow rounding difference within 1KB for float parsing
		diff := got - tc.expected
		if diff < -1024 || diff > 1024 {
			t.Errorf("parseMemBytes(%q) = %d, expected ~%d", tc.input, got, tc.expected)
		}
	}
}
