package handlers

import (
	"testing"
)

func TestIsValidFilePath(t *testing.T) {
	tests := []struct {
		path string
		want bool
	}{
		// Valid paths
		{"main.go", true},
		{"src/main.go", true},
		{"src/utils/helpers.py", true},
		{"README.md", true},
		{"package.json", true},
		{"a.txt", true},
		{"dir/sub/file.ts", true},

		// Invalid — directory traversal
		{"../etc/passwd", false},
		{"src/../../../etc/passwd", false},
		{"..hidden", false},

		// Invalid — leading dot (hidden files)
		{".env", false},
		{".gitignore", false},
		{".hidden/file.txt", false},

		// Invalid — leading slash (absolute path)
		{"/etc/passwd", false},
		{"/root/file.txt", false},

		// Invalid — double slash
		{"src//main.go", false},

		// Invalid — special characters
		{"file name.go", false},
		{"file@name.go", false},
		{"file$name.go", false},
		{"file;name.go", false},
		{"file|name.go", false},
		{"file&name.go", false},
		{"file`name.go", false},

		// Invalid — empty
		{"", false},

		// Invalid — too long (256 chars)
		{string(make([]byte, 256)), false},
	}

	for _, tt := range tests {
		t.Run(tt.path, func(t *testing.T) {
			got := isValidFilePath(tt.path)
			if got != tt.want {
				t.Errorf("isValidFilePath(%q) = %v, want %v", tt.path, got, tt.want)
			}
		})
	}
}

func TestDetectLanguage(t *testing.T) {
	tests := []struct {
		path string
		want string
	}{
		{"main.go", "go"},
		{"index.js", "javascript"},
		{"index.jsx", "javascript"},
		{"app.ts", "typescript"},
		{"app.tsx", "typescript"},
		{"script.py", "python"},
		{"Gemfile.rb", "ruby"},
		{"main.rs", "rust"},
		{"App.java", "java"},
		{"data.json", "json"},
		{"README.md", "markdown"},
		{"index.html", "html"},
		{"styles.css", "css"},
		{"config.yml", "yaml"},
		{"config.yaml", "yaml"},
		{"query.sql", "sql"},
		{"script.sh", "shell"},
		{"script.bash", "shell"},
		{"notes.txt", "plaintext"},
		{"unknown.xyz", "plaintext"},
		{"noextension", "plaintext"},
		{"src/deep/path/file.py", "python"},
	}

	for _, tt := range tests {
		t.Run(tt.path, func(t *testing.T) {
			got := detectLanguage(tt.path)
			if got != tt.want {
				t.Errorf("detectLanguage(%q) = %q, want %q", tt.path, got, tt.want)
			}
		})
	}
}

func TestExtractCodeBlock(t *testing.T) {
	tests := []struct {
		name     string
		text     string
		language string
		want     string
	}{
		{
			name:     "python code block",
			text:     "Here's the fix:\n\n```python\ndef hello():\n    print('hi')\n```\n\nDone.",
			language: "python",
			want:     "def hello():\n    print('hi')",
		},
		{
			name:     "generic code block",
			text:     "```\nsome code\n```",
			language: "go",
			want:     "some code",
		},
		{
			name:     "no code block",
			text:     "There is no code here, just text.",
			language: "python",
			want:     "",
		},
		{
			name:     "multiple code blocks extracts first",
			text:     "```go\nfunc A() {}\n```\n\n```go\nfunc B() {}\n```",
			language: "go",
			want:     "func A() {}",
		},
		{
			name:     "unclosed code block",
			text:     "```python\ndef broken():\n    pass",
			language: "python",
			want:     "",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := extractCodeBlock(tt.text, tt.language)
			if got != tt.want {
				t.Errorf("extractCodeBlock() = %q, want %q", got, tt.want)
			}
		})
	}
}
