package email

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"time"
)

// Service defines email dispatching operations
type Service interface {
	SendVerificationEmail(toEmail, username, verifyURL string) error
	IsConfigured() bool
}

// ResendService implements email sending via Resend API
type ResendService struct {
	apiKey    string
	fromEmail string
	client    *http.Client
}

// NewService creates a new email service instance
func NewService(apiKey, fromEmail string) Service {
	if fromEmail == "" {
		fromEmail = "SyncSpace <onboarding@resend.dev>"
	}
	return &ResendService{
		apiKey:    apiKey,
		fromEmail: fromEmail,
		client:    &http.Client{Timeout: 10 * time.Second},
	}
}

func (s *ResendService) IsConfigured() bool {
	return s.apiKey != ""
}

type resendSendRequest struct {
	From    string   `json:"from"`
	To      []string `json:"to"`
	Subject string   `json:"subject"`
	HTML    string   `json:"html"`
}

// SendVerificationEmail dispatches an account confirmation email
func (s *ResendService) SendVerificationEmail(toEmail, username, verifyURL string) error {
	if s.apiKey == "" {
		log.Printf("[EMAIL] RESEND_API_KEY unset. Verification link for %s: %s", toEmail, verifyURL)
		return nil
	}

	htmlContent := fmt.Sprintf(`
		<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; color: #1e293b;">
			<h2 style="color: #0f172a; margin-bottom: 16px;">Welcome to SyncSpace, %s!</h2>
			<p style="font-size: 15px; line-height: 1.6; color: #475569;">
				Thank you for signing up. Please verify your email address to unlock code execution in your collaborative workspaces.
			</p>
			<div style="margin: 28px 0;">
				<a href="%s" style="background-color: #3b82f6; color: #ffffff; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: 600; display: inline-block;">
					Verify Email Address
				</a>
			</div>
			<p style="font-size: 13px; color: #64748b; line-height: 1.5;">
				Or click this verification link: <br/>
				<a href="%s" style="color: #3b82f6;">%s</a>
			</p>
			<hr style="border: 0; border-top: 1px solid #e2e8f0; margin: 32px 0 16px 0;" />
			<p style="font-size: 12px; color: #94a3b8;">
				This link expires in 24 hours. If you did not create a SyncSpace account, please disregard this message.
			</p>
		</div>
	`, username, verifyURL, verifyURL, verifyURL)

	reqBody, err := json.Marshal(resendSendRequest{
		From:    s.fromEmail,
		To:      []string{toEmail},
		Subject: "Verify your email for SyncSpace",
		HTML:    htmlContent,
	})
	if err != nil {
		return fmt.Errorf("marshal resend request: %w", err)
	}

	req, err := http.NewRequest(http.MethodPost, "https://api.resend.com/emails", bytes.NewReader(reqBody))
	if err != nil {
		return fmt.Errorf("create resend request: %w", err)
	}

	req.Header.Set("Authorization", "Bearer "+s.apiKey)
	req.Header.Set("Content-Type", "application/json")

	resp, err := s.client.Do(req)
	if err != nil {
		log.Printf("[EMAIL] Failed to dispatch email via Resend to %s: %v", toEmail, err)
		return fmt.Errorf("send email via resend: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 400 {
		var errResp map[string]interface{}
		_ = json.NewDecoder(resp.Body).Decode(&errResp)
		log.Printf("[EMAIL] Resend delivery rejected (HTTP %d): %v", resp.StatusCode, errResp)
		if resp.StatusCode == http.StatusForbidden {
			return fmt.Errorf("resend sandbox restriction (HTTP 403): only registered account owner can receive emails")
		}
		return fmt.Errorf("resend returned status %d", resp.StatusCode)
	}

	log.Printf("[EMAIL] Verification email sent successfully to %s via Resend", toEmail)
	return nil
}
