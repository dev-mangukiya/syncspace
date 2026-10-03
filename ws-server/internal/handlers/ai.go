package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
	"time"
)

type AIHandler struct {
	apiKey     string
	model      string
	baseURL    string
	configured bool
	available  bool
	statusMsg  string
}

func NewAIHandler() *AIHandler {
	model := os.Getenv("GROQ_MODEL")
	if model == "" {
		model = "openai/gpt-oss-20b" // Default model: cost-effective, 64k output context, 100% accuracy
	}
	baseURL := os.Getenv("AI_BASE_URL")
	if baseURL == "" {
		baseURL = "https://api.groq.com/openai/v1"
	}
	apiKey := strings.TrimSpace(os.Getenv("GROQ_API_KEY"))
	if idx := strings.Index(apiKey, "#"); idx != -1 {
		apiKey = strings.TrimSpace(apiKey[:idx])
	}

	handler := &AIHandler{
		apiKey:     apiKey,
		model:      model,
		baseURL:    baseURL,
		configured: apiKey != "",
		available:  false,
	}

	if !handler.configured {
		handler.statusMsg = "AI isn't configured on this server"
		log.Println("[AI] GROQ_API_KEY is not set. AI panel will report unconfigured.")
	} else {
		// Verify model availability against provider's live model list
		if err := checkModelAvailability(baseURL, apiKey, model); err != nil {
			log.Printf("[AI] WARNING: Configured model %q is not available: %v", model, err)
			handler.available = false
			handler.statusMsg = fmt.Sprintf("AI unavailable: %v", err)
		} else {
			handler.available = true
			log.Printf("[AI] Configured model %q verified and ready", model)
		}
	}

	return handler
}

func checkModelAvailability(baseURL, apiKey, targetModel string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, "GET", baseURL+"/models", nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+apiKey)

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return fmt.Errorf("failed to reach model list endpoint: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("provider returned status %d: %s", resp.StatusCode, string(body))
	}

	var result struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return fmt.Errorf("failed to parse models response: %w", err)
	}

	for _, m := range result.Data {
		if m.ID == targetModel {
			return nil
		}
	}

	return fmt.Errorf("model %q not found in provider's active model list", targetModel)
}

// AIInfoResponse returns status and reported model name for UI rendering
type AIInfoResponse struct {
	Configured bool   `json:"configured"`
	Available  bool   `json:"available"`
	Model      string `json:"model"`
	StatusMsg  string `json:"status_msg,omitempty"`
}

// Info reports active AI configuration to the frontend
func (h *AIHandler) Info(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, AIInfoResponse{
		Configured: h.configured,
		Available:  h.available,
		Model:      h.model,
		StatusMsg:  h.statusMsg,
	})
}

// ChatRequest is the incoming request from the frontend
type ChatRequest struct {
	Message  string           `json:"message"`
	Code     string           `json:"code"`
	Language string           `json:"language"`
	FilePath string           `json:"file_path"`
	History  []HistoryMessage `json:"history,omitempty"`
}

// HistoryMessage represents a previous conversation turn
type HistoryMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

// ChatResponse is what we send back
type ChatResponse struct {
	Reply      string `json:"reply"`
	CodeBlock  string `json:"code_block,omitempty"`
	TokensUsed int    `json:"tokens_used,omitempty"`
	Model      string `json:"model,omitempty"`
}

// OpenAI-compatible API types
type CompletionRequest struct {
	Model           string       `json:"model"`
	Messages        []APIMessage `json:"messages"`
	Temperature     float64      `json:"temperature"`
	MaxTokens       int          `json:"max_tokens"`
	ReasoningEffort string       `json:"reasoning_effort,omitempty"`
	ReasoningFormat string       `json:"reasoning_format,omitempty"`
}

type APIMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type CompletionResponse struct {
	Choices []struct {
		Message struct {
			Content   string `json:"content"`
			Reasoning string `json:"reasoning,omitempty"`
		} `json:"message"`
	} `json:"choices"`
	Error *struct {
		Message string `json:"message"`
	} `json:"error,omitempty"`
	Usage struct {
		PromptTokens     int `json:"prompt_tokens"`
		CompletionTokens int `json:"completion_tokens"`
		TotalTokens      int `json:"total_tokens"`
	} `json:"usage"`
}

const systemPrompt = `You are SyncSpace AI, an expert coding assistant embedded in a collaborative code editor.

RULES:
1. Be concise and direct. No preamble, no "Sure!", no "Great question!".
2. When fixing code: output the COMPLETE corrected file in a single fenced code block with the language tag. Explain what you changed in 1-2 brief sentences below the code block.
3. Keep entire response under 400 words.
4. When explaining: use short bullet points. Reference specific line numbers.
5. Always preserve the original code's intent, variable names, and structure unless asked otherwise.
6. Use markdown formatting. Bold key terms. Use inline code for identifiers.
7. If the code has no issues, say so clearly.
8. Never apologize.`

func (h *AIHandler) Chat(w http.ResponseWriter, r *http.Request) {
	if !h.configured {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{
			"error": "AI isn't configured on this server",
			"setup": "Set GROQ_API_KEY environment variable.",
		})
		return
	}

	if !h.available {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{
			"error": h.statusMsg,
		})
		return
	}

	// Limit request body to 64KB
	r.Body = http.MaxBytesReader(w, r.Body, 64*1024)

	var req ChatRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request"})
		return
	}

	if req.Message == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "message is required"})
		return
	}

	// Input length validation
	if len(req.Message) > 4096 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "message too long (max 4096 chars)"})
		return
	}
	if len(req.Code) > 32768 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "code context too large (max 32KB)"})
		return
	}

	// Build messages array
	messages := []APIMessage{
		{Role: "system", Content: systemPrompt},
	}

	// Include conversation history (max 6 turns to control context window)
	maxHistory := 6
	if len(req.History) > maxHistory {
		req.History = req.History[len(req.History)-maxHistory:]
	}
	for _, hist := range req.History {
		if hist.Role == "user" || hist.Role == "assistant" {
			messages = append(messages, APIMessage{Role: hist.Role, Content: hist.Content})
		}
	}

	// Build the current user message with code context
	userPrompt := req.Message
	if req.Code != "" {
		userPrompt = fmt.Sprintf("Current file: `%s` (%s)\n\n```%s\n%s\n```\n\nUser request: %s",
			req.FilePath, req.Language, req.Language, req.Code, req.Message)
	}
	messages = append(messages, APIMessage{Role: "user", Content: userPrompt})

	// Call API with timeout
	ctx, cancel := context.WithTimeout(r.Context(), 35*time.Second)
	defer cancel()

	completionReq := CompletionRequest{
		Model:           h.model,
		Messages:        messages,
		Temperature:     0.2, // Low temperature for high precision coding
		MaxTokens:       1536, // Adequate for complete file replacements
		ReasoningEffort: "low",    // Keep reasoning effort low for minimal latency
		ReasoningFormat: "parsed", // Direct reasoning tokens to message.reasoning so message.content is purely clean output
	}

	body, err := json.Marshal(completionReq)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to build request"})
		return
	}

	httpReq, _ := http.NewRequestWithContext(ctx, "POST", h.baseURL+"/chat/completions", bytes.NewReader(body))
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Authorization", "Bearer "+h.apiKey)

	resp, err := http.DefaultClient.Do(httpReq)
	if err != nil {
		if ctx.Err() == context.DeadlineExceeded {
			writeJSON(w, http.StatusGatewayTimeout, map[string]string{"error": "AI request timed out (30s limit)"})
			return
		}
		log.Printf("[AI] API error: %v", err)
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "failed to reach AI service"})
		return
	}
	defer resp.Body.Close()

	// Limit response read to 256KB
	respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 256*1024))

	var completionResp CompletionResponse
	if err := json.Unmarshal(respBody, &completionResp); err != nil {
		log.Printf("[AI] Parse error: %v, body: %s", err, string(respBody[:min(len(respBody), 200)]))
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "failed to parse AI response"})
		return
	}

	// If rate-limited by provider, retry once after short backoff
	if completionResp.Error != nil && strings.Contains(strings.ToLower(completionResp.Error.Message), "rate limit") {
		log.Println("[AI] Provider rate limit hit, backing off 6s and retrying...")
		time.Sleep(6 * time.Second)
		httpReq2, _ := http.NewRequestWithContext(ctx, "POST", h.baseURL+"/chat/completions", bytes.NewReader(body))
		httpReq2.Header.Set("Content-Type", "application/json")
		httpReq2.Header.Set("Authorization", "Bearer "+h.apiKey)
		if resp2, err2 := http.DefaultClient.Do(httpReq2); err2 == nil {
			defer resp2.Body.Close()
			respBody2, _ := io.ReadAll(io.LimitReader(resp2.Body, 256*1024))
			var completionResp2 CompletionResponse
			if err3 := json.Unmarshal(respBody2, &completionResp2); err3 == nil && completionResp2.Error == nil {
				completionResp = completionResp2
			}
		}
	}

	if completionResp.Error != nil {
		log.Printf("[AI] Provider error: %s", completionResp.Error.Message)
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": completionResp.Error.Message})
		return
	}

	if len(completionResp.Choices) == 0 {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "empty AI response"})
		return
	}

	// Strip any reasoning tags if present, ensuring pure final response
	replyText := stripReasoning(completionResp.Choices[0].Message.Content)

	log.Printf("[AI] %s | %d tokens (prompt=%d, completion=%d) | model=%s",
		req.FilePath, completionResp.Usage.TotalTokens,
		completionResp.Usage.PromptTokens, completionResp.Usage.CompletionTokens,
		h.model)

	// Extract code block if present
	chatResp := ChatResponse{
		Reply:      replyText,
		TokensUsed: completionResp.Usage.TotalTokens,
		Model:      h.model,
	}
	if codeBlock := extractCodeBlock(replyText, req.Language); codeBlock != "" {
		chatResp.CodeBlock = codeBlock
	}

	writeJSON(w, http.StatusOK, chatResp)
}

// stripReasoning removes any <think>...</think> tags if present in model output
func stripReasoning(content string) string {
	for {
		start := strings.Index(content, "<think>")
		if start == -1 {
			break
		}
		end := strings.Index(content[start:], "</think>")
		if end == -1 {
			content = content[:start]
			break
		}
		content = content[:start] + content[start+end+len("</think>"):]
	}
	return strings.TrimSpace(content)
}

// extractCodeBlock pulls the first code block from markdown text
func extractCodeBlock(text, language string) string {
	langLower := strings.ToLower(strings.TrimSpace(language))
	textLower := strings.ToLower(text)
	markers := []string{
		"```" + langLower + "\n",
		"```" + langLower + "\r\n",
		"```\n",
		"```\r\n",
	}

	for _, marker := range markers {
		start := strings.Index(textLower, marker)
		if start == -1 {
			continue
		}
		codeStart := start + len(marker)
		end := strings.Index(text[codeStart:], "```")
		if end == -1 {
			continue
		}
		return strings.TrimSpace(text[codeStart : codeStart+end])
	}
	return ""
}
