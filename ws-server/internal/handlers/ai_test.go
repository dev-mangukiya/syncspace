package handlers

import (
	"strings"
	"testing"
)

func TestStripReasoning(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		expected string
	}{
		{
			name:     "No reasoning tags",
			input:    "Here is the solution to your bug.",
			expected: "Here is the solution to your bug.",
		},
		{
			name:     "Single think block at beginning",
			input:    "<think>The user has an off-by-one error in temperature conversion.</think>Fixed code:\n```python\nprint(1)\n```",
			expected: "Fixed code:\n```python\nprint(1)\n```",
		},
		{
			name:     "Multiline think block with whitespace",
			input:    "<think>\n1. Step one\n2. Step two\n3. Calculate 9/5\n</think>\n\n```python\ndef convert(c):\n    return (c * 9/5) + 32\n```\nExplanation below.",
			expected: "```python\ndef convert(c):\n    return (c * 9/5) + 32\n```\nExplanation below.",
		},
		{
			name:     "Multiple think tags",
			input:    "<think>first</think>Part 1<think>second</think>Part 2",
			expected: "Part 1Part 2",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := stripReasoning(tt.input)
			if got != tt.expected {
				t.Errorf("stripReasoning() = %q, expected %q", got, tt.expected)
			}
		})
	}
}

func TestExtractCodeBlockRealOutput(t *testing.T) {
	// Real output from openai/gpt-oss-120b on the seeded-bug template
	realModelOutput := `"""Temperature conversion utility module."""

def convert_temperature(value: float, unit: str) -> float:
    unit = unit.upper()
    if unit == 'C':
        return (value * 9 / 5) + 32
    elif unit == 'F':
        return (value - 32) * 5 / 9
    raise ValueError(f"Unsupported unit: {unit}")
`
	fullMarkdownOutput := "Here is the corrected code:\n\n```python\n" + realModelOutput + "```\n\n### Explanation\nFixed the formula."

	tests := []struct {
		name     string
		text     string
		lang     string
		expected string
	}{
		{
			name:     "Real gpt-oss-120b Python block",
			text:     fullMarkdownOutput,
			lang:     "python",
			expected: strings.TrimSpace(realModelOutput),
		},
		{
			name:     "Language tag uppercase",
			text:     "```PYTHON\nprint('hello')\n```",
			lang:     "python",
			expected: "print('hello')",
		},
		{
			name:     "Javascript code block",
			text:     "Fixed version:\n```javascript\nconst a = 10;\nconsole.log(a);\n```\nDone.",
			lang:     "javascript",
			expected: "const a = 10;\nconsole.log(a);",
		},
		{
			name:     "Generic code block without language tag",
			text:     "Check this out:\n```\nconst x = 42;\n```",
			lang:     "javascript",
			expected: "const x = 42;",
		},
		{
			name:     "No code block present",
			text:     "This is just an explanation with no code block.",
			lang:     "python",
			expected: "",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := extractCodeBlock(tt.text, tt.lang)
			if got != tt.expected {
				t.Errorf("extractCodeBlock() = %q, expected %q", got, tt.expected)
			}
		})
	}
}
