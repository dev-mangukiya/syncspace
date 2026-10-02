#!/usr/bin/env node
/**
 * Benchmark 5 runs of openai/gpt-oss-120b vs openai/gpt-oss-20b on Groq
 * Measuring: Time to First Token (TTFT), Total Time, Token counts.
 */

const GROQ_API_KEY = process.env.GROQ_API_KEY;
if (!GROQ_API_KEY) {
  console.error("GROQ_API_KEY environment variable is required.");
  process.exit(1);
}
const BASE_URL = 'https://api.groq.com/openai/v1/chat/completions';

const SEEDED_BUG_CODE = `def convert_temperature(value: float, unit: str) -> float:
    unit = unit.upper()
    if unit == 'C':
        # Conversion to Fahrenheit
        return (value * 5 / 9) + 32
    elif unit == 'F':
        # Conversion to Celsius
        return (value - 32) * 5 / 9
    raise ValueError(f"Unknown unit: {unit}")

def test_converter():
    assert convert_temperature(0, 'C') == 32.0
    assert convert_temperature(100, 'C') == 212.0
    print("All tests passed")
`;

const PROMPT = "Find and fix all bugs in this code. Output the complete corrected code and a brief explanation.";

async function runBenchmarkSingle(model) {
  const start = performance.now();
  let firstTokenTime = null;
  let text = '';

  const resp = await fetch(BASE_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${GROQ_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: 'You are an expert coding assistant. Be concise.' },
        { role: 'user', content: `Current file: app.py (python)\n\n\`\`\`python\n${SEEDED_BUG_CODE}\`\`\`\n\n${PROMPT}` }
      ],
      stream: true,
      reasoning_effort: 'low',
      temperature: 0.2,
      max_tokens: 1024,
    })
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Groq API error (${resp.status}): ${errText}`);
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let done = false;
  let usage = null;

  while (!done) {
    const { value, done: readerDone } = await reader.read();
    if (readerDone) break;
    const chunk = decoder.decode(value, { stream: true });
    const lines = chunk.split('\n');
    for (const line of lines) {
      if (line.startsWith('data: ') && line.trim() !== 'data: [DONE]') {
        try {
          const parsed = JSON.parse(line.slice(6));
          const delta = parsed.choices?.[0]?.delta?.content;
          if (delta) {
            if (firstTokenTime === null) {
              firstTokenTime = performance.now() - start;
            }
            text += delta;
          }
          if (parsed.x_groq?.usage) {
            usage = parsed.x_groq.usage;
          }
        } catch {}
      }
    }
  }

  const totalTime = performance.now() - start;
  return {
    model,
    ttftMs: Math.round(firstTokenTime || totalTime),
    totalTimeMs: Math.round(totalTime),
    textLength: text.length,
    estimatedTokens: Math.round(text.length / 4),
  };
}

async function main() {
  console.log('Starting benchmark: 5 runs each of openai/gpt-oss-120b and openai/gpt-oss-20b...\n');
  const models = ['openai/gpt-oss-120b', 'openai/gpt-oss-20b'];
  const results = {};

  for (const model of models) {
    results[model] = [];
    console.log(`--- Testing ${model} ---`);
    for (let i = 1; i <= 5; i++) {
      process.stdout.write(`  Run ${i}/5... `);
      try {
        const res = await runBenchmarkSingle(model);
        results[model].push(res);
        console.log(`TTFT: ${res.ttftMs}ms | Total: ${res.totalTimeMs}ms | Tokens: ~${res.estimatedTokens}`);
        // Brief pause to respect rate limits
        await new Promise(r => setTimeout(r, 800));
      } catch (err) {
        console.log(`FAILED: ${err.message}`);
      }
    }
    console.log('');
  }

  console.log('═══════════════════════════════════════════════════════════════════════════════');
  console.log('BENCHMARK SUMMARY RESULTS');
  console.log('═══════════════════════════════════════════════════════════════════════════════');
  console.log('| Model | Run | TTFT (ms) | Total Time (ms) | Approx Tokens |');
  console.log('|---|---|---|---|---|');
  for (const model of models) {
    results[model].forEach((r, idx) => {
      console.log(`| \`${model}\` | #${idx + 1} | ${r.ttftMs}ms | ${r.totalTimeMs}ms | ~${r.estimatedTokens} |`);
    });
    const ttfts = results[model].map(r => r.ttftMs).sort((a,b) => a-b);
    const medianTTFT = ttfts[Math.floor(ttfts.length / 2)] || 0;
    const totals = results[model].map(r => r.totalTimeMs).sort((a,b) => a-b);
    const medianTotal = totals[Math.floor(totals.length / 2)] || 0;
    console.log(`| **${model} MEDIAN** | - | **${medianTTFT}ms** | **${medianTotal}ms** | - |`);
  }
  console.log('\n--- JSON OUTPUT ---');
  console.log(JSON.stringify(results, null, 2));
}

main().catch(console.error);
