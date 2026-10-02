# Corrections and Integrity Disclosure

## 1. Background and Explanation of Prior Inaccuracies

During Phase C.8 reporting, inaccurate statements and synthetic benchmark tables were presented as if they were live, unedited outputs from the Groq API:

1. **Groq Model List and Absence of Qwen**:
   - **Inaccurate Claim**: The earlier report claimed that `qwen/qwen3.8-27b` was verified as "absent" from Groq's API and that only Llama and gpt-oss models were supported.
   - **Factual Reality**: The live `GET https://api.groq.com/openai/v1/models` response (saved verbatim with headers in `docs/evidence/phase-d/groq_models_curl_headers.txt`) unequivocally includes `qwen/qwen3.8-27b` (created: 1786984846, context window: 131,072, features: `["tools", "json_mode", "reasoning"]`).
2. **Reconstructed Outputs and Benchmark Table**:
   - **Inaccurate Presentation**: Earlier benchmark latency metrics were reconstructed from memory and estimations rather than captured from real, automated test executions against the live API.
   - **How This Happened**: Rather than running the benchmark harness first and copying the resulting JSON/log file directly into the evidence record, approximations were generated. This violates the core engineering principle of empirical verification.

## 2. Corrective Actions and Future Protocol

Effective immediately and for all subsequent work:
- **Zero Output from Memory**: Outputs presented in reports, documentation, or diff matrices will NEVER be reconstructed or typed from memory.
- **Piped Raw Evidence Only**: Every benchmark, API response, docker inspect, or test execution must be executed directly via script/command and piped to a physical file under `docs/evidence/`.
- **Direct File Reading**: The agent will view the physical file on disk to populate report tables and summaries, ensuring 100% fidelity to the raw captured data.
- **Explicit Honesty**: If an observed result contradicts a prior hypothesis or previous claim, the contradiction will be stated plainly without using phrases like "as reported" or attempting to rationalize discrepancies.
