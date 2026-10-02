#!/usr/bin/env node
import fs from 'fs';
import path from 'path';

// Standing Rule 0: Never hardcode or inline credentials.
const GROQ_API_KEY = process.env.GROQ_API_KEY;
if (!GROQ_API_KEY) {
  console.error("ERROR: GROQ_API_KEY environment variable is required.");
  process.exit(1);
}

const GROQ_BASE = process.env.AI_BASE_URL || 'https://api.groq.com/openai/v1';
const EXEC_BASE = process.env.EXEC_SERVICE_URL || 'http://localhost:8081';

const MODELS = [
  'openai/gpt-oss-120b',
  'openai/gpt-oss-20b',
  'qwen/qwen3.8-27b',
];

const BUGS = [
  {
    name: 'python-temperature',
    language: 'python',
    filename: 'test_temp.py',
    code: `def convert_temperature(value: float, unit: str) -> float:
    unit = unit.upper()
    if unit == 'C':
        return (value * 5 / 9) + 32 # Bug: 5/9 instead of 9/5
    elif unit == 'F':
        return (value - 32) * 5 / 9
    raise ValueError(f"Unknown unit: {unit}")

def test_converter():
    assert round(convert_temperature(0, 'C'), 1) == 32.0
    assert round(convert_temperature(100, 'C'), 1) == 212.0
    assert round(convert_temperature(212, 'F'), 1) == 100.0
    assert round(convert_temperature(32, 'F'), 1) == 0.0
    assert round(convert_temperature(-40, 'C'), 1) == -40.0
    print("ALL TESTS PASSED")

if __name__ == '__main__':
    test_converter()
`,
    prompt: 'Fix the bug in convert_temperature so all test assertions pass. Output the complete corrected file in a single python code block.'
  },
  {
    name: 'javascript-pagination',
    language: 'javascript',
    filename: 'test_paginate.js',
    code: `function paginate(items, page = 1, pageSize = 10) {
  if (page < 1 || pageSize < 1) {
    throw new RangeError("Page and pageSize must be positive integers");
  }
  const start = (page - 1) * pageSize;
  const end = start + pageSize + 1; // Bug: off-by-one
  return items.slice(start, end);
}

function runChecks() {
  const records = Array.from({ length: 30 }, (_, i) => ({ id: i + 1 }));
  const testCases = [
    { page: 1, size: 5, expectedLen: 5 },
    { page: 2, size: 5, expectedLen: 5 },
    { page: 3, size: 10, expectedLen: 10 },
  ];
  for (const tc of testCases) {
    const res = paginate(records, tc.page, tc.size);
    if (res.length !== tc.expectedLen) {
      throw new Error("Expected " + tc.expectedLen + " items, got " + res.length);
    }
  }
  console.log("ALL TESTS PASSED");
}

runChecks();
`,
    prompt: 'Fix the bug in paginate so all pagination assertions pass. Output the complete corrected file in a single javascript code block.'
  },
  {
    name: 'python-palindrome',
    language: 'python',
    filename: 'test_palindrome.py',
    code: `def is_palindrome(text: str) -> bool:
    cleaned = ''.join(c.lower() for c in text if c.isalnum())
    return cleaned == cleaned[::-2] # Bug: step size 2 instead of -1

def test_palindrome():
    assert is_palindrome("A man, a plan, a canal: Panama") == True
    assert is_palindrome("race a car") == False
    assert is_palindrome("Was it a car or a cat I saw?") == True
    assert is_palindrome("tab a bat") == True
    print("ALL TESTS PASSED")

if __name__ == '__main__':
    test_palindrome()
`,
    prompt: 'Fix the bug in is_palindrome so all test assertions pass. Output the complete corrected file in a single python code block.'
  }
];

function extractCodeBlock(text, language) {
  const langLower = language.toLowerCase();
  const textLower = text.toLowerCase();
  const markers = [
    '```' + langLower + '\n',
    '```' + langLower + '\r\n',
    '```\n',
    '```\r\n',
  ];

  for (const marker of markers) {
    const start = textLower.indexOf(marker);
    if (start === -1) continue;
    const codeStart = start + marker.length;
    const end = text.indexOf('```', codeStart);
    if (end === -1) continue;
    return text.slice(codeStart, end).trim();
  }
  return text.trim();
}

async function runInSandbox(code, language) {
  try {
    const resp = await fetch(`${EXEC_BASE}/api/exec/run`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Exec-Secret': process.env.EXEC_SECRET || 'syncspace_exec_secret_dev',
      },
      body: JSON.stringify({
        code,
        language,
        timeout_seconds: 5,
      })
    });
    const result = await resp.json();
    const passed = (result.exit_code === 0) && (result.stdout && result.stdout.includes('ALL TESTS PASSED'));
    return {
      passed,
      exitCode: result.exit_code,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } catch (err) {
    return {
      passed: false,
      exitCode: -1,
      stdout: '',
      stderr: err.message,
    };
  }
}

async function streamGroqCompletion(model, bug, attempt = 1) {
  const userContent = "Current file: " + bug.filename + " (" + bug.language + ")\n\n```" + bug.language + "\n" + bug.code + "\n```\n\nUser request: " + bug.prompt;
  const messages = [
    { role: 'system', content: 'You are an expert coding assistant. Output the complete corrected file in a single fenced code block with the language tag. Be concise.' },
    { role: 'user', content: userContent }
  ];

  const start = performance.now();
  let firstTokenTime = null;
  let fullText = '';

  const resp = await fetch(`${GROQ_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${GROQ_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.2,
      max_tokens: 512,
      stream: true,
      reasoning_format: 'parsed',
    })
  });

  if (!resp.ok) {
    if (resp.status === 429 && attempt <= 3) {
      process.stdout.write(` [429 rate limit, sleeping 7s (attempt ${attempt}/3)]... `);
      await new Promise(r => setTimeout(r, 7000));
      return streamGroqCompletion(model, bug, attempt + 1);
    }
    const errText = await resp.text();
    throw new Error(`Groq error (${resp.status}): ${errText}`);
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let done = false;

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
            fullText += delta;
          }
        } catch {}
      }
    }
  }

  const totalTime = performance.now() - start;
  return {
    ttftMs: Math.round(firstTokenTime || totalTime),
    totalTimeMs: Math.round(totalTime),
    fullText,
  };
}

async function captureRawResponse(model) {
  const bug = BUGS[0];
  const userContent = "Current file: " + bug.filename + " (" + bug.language + ")\n\n```" + bug.language + "\n" + bug.code + "\n```\n\nUser request: " + bug.prompt;
  const messages = [
    { role: 'system', content: 'You are an expert coding assistant. Output the complete corrected file in a single fenced code block with the language tag.' },
    { role: 'user', content: userContent }
  ];

  const resp = await fetch(`${GROQ_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${GROQ_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.2,
      max_tokens: 1024,
      stream: false,
      reasoning_format: 'parsed',
    })
  });

  const json = await resp.json();
  const modelSlug = model.replace(/[^a-zA-Z0-9_-]/g, '_');
  const targetDir = path.resolve('docs/evidence/phase-d');
  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(path.join(targetDir, `model_raw_${modelSlug}.json`), JSON.stringify(json, null, 2));
  console.log(`   Saved raw response for ${model} to docs/evidence/phase-d/model_raw_${modelSlug}.json`);
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log(' MODEL BAKE-OFF: openai/gpt-oss-120b vs openai/gpt-oss-20b vs qwen/qwen3.8-27b');
  console.log(' (3 bugs x 3 runs = 9 runs per model, 27 total runs)');
  console.log('═══════════════════════════════════════════════════════════════════\\n');

  // Step 1: Capture one raw response per model for reasoning analysis
  console.log('1. Capturing raw non-streamed responses to inspect reasoning fields...');
  for (const model of MODELS) {
    try {
      await captureRawResponse(model);
      await new Promise(r => setTimeout(r, 600));
    } catch (err) {
      console.error(`   Error capturing raw response for ${model}: ${err.message}`);
    }
  }

  // Step 2: Run the full 27-run bake-off
  const allRuns = [];
  console.log('\\n2. Starting full benchmark matrix (3 bugs x 3 runs per model)...\\n');

  for (const model of MODELS) {
    console.log(`─────────────────────────────────────────────────────────────────`);
    console.log(` MODEL: ${model}`);
    console.log(`─────────────────────────────────────────────────────────────────`);

    for (let bugIdx = 0; bugIdx < BUGS.length; bugIdx++) {
      const bug = BUGS[bugIdx];
      for (let run = 1; run <= 3; run++) {
        process.stdout.write(`   Bug ${bugIdx + 1} (${bug.name}) Run ${run}/3: `);
        try {
          const streamRes = await streamGroqCompletion(model, bug);
          const extractedCode = extractCodeBlock(streamRes.fullText, bug.language);
          const sandboxRes = await runInSandbox(extractedCode, bug.language);

          const runRecord = {
            model,
            bug: bug.name,
            language: bug.language,
            runIndex: run,
            ttftMs: streamRes.ttftMs,
            totalTimeMs: streamRes.totalTimeMs,
            correctness: sandboxRes.passed ? 'PASS' : 'FAIL',
            exitCode: sandboxRes.exitCode,
            stdoutSnippet: (sandboxRes.stdout || '').slice(0, 100),
            stderrSnippet: (sandboxRes.stderr || '').slice(0, 100),
          };

          allRuns.push(runRecord);
          console.log(`TTFT=${runRecord.ttftMs}ms, Total=${runRecord.totalTimeMs}ms, Sandbox=${runRecord.correctness} (exit ${runRecord.exitCode})`);
          // Rate-limiting delay
          await new Promise(r => setTimeout(r, 800));
        } catch (err) {
          console.log(`ERROR: ${err.message}`);
          allRuns.push({
            model,
            bug: bug.name,
            language: bug.language,
            runIndex: run,
            ttftMs: -1,
            totalTimeMs: -1,
            correctness: 'ERROR',
            exitCode: -1,
            stderrSnippet: err.message,
          });
        }
      }
    }
    console.log('');
  }

  // Step 3: Save raw per-run results
  const targetDir = path.resolve('docs/evidence/phase-d');
  fs.mkdirSync(targetDir, { recursive: true });
  const rawPath = path.join(targetDir, 'bakeoff_results.json');
  fs.writeFileSync(rawPath, JSON.stringify(allRuns, null, 2));
  console.log(`Raw per-run JSON saved to ${rawPath}\\n`);

  // Step 4: Compute summary metrics and apply decision rule
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log(' BAKE-OFF RESULTS & DECISION RULE EVALUATION');
  console.log('═══════════════════════════════════════════════════════════════════\\n');

  console.log('| Model | Pass Rate | Median TTFT (ms) | Median Total (ms) | Qualified (TTFT <= 1500ms) |');
  console.log('|---|---|---|---|---|');

  const summary = MODELS.map(model => {
    const modelRuns = allRuns.filter(r => r.model === model);
    const passes = modelRuns.filter(r => r.correctness === 'PASS').length;
    const total = modelRuns.length;
    const passRate = total > 0 ? (passes / total) : 0;

    const validTtfts = modelRuns.filter(r => r.ttftMs > 0).map(r => r.ttftMs).sort((a,b) => a-b);
    const medianTtft = validTtfts.length > 0 ? validTtfts[Math.floor(validTtfts.length / 2)] : 99999;

    const validTotals = modelRuns.filter(r => r.totalTimeMs > 0).map(r => r.totalTimeMs).sort((a,b) => a-b);
    const medianTotal = validTotals.length > 0 ? validTotals[Math.floor(validTotals.length / 2)] : 99999;

    const qualified = medianTtft <= 1500;
    return {
      model,
      passes,
      total,
      passRate: (passRate * 100).toFixed(1) + '%',
      rawPassRate: passRate,
      medianTtft,
      medianTotal,
      qualified,
    };
  });

  for (const s of summary) {
    console.log('| `' + s.model + '` | ' + s.passes + '/' + s.total + ' (' + s.passRate + ') | ' + s.medianTtft + 'ms | ' + s.medianTotal + 'ms | ' + (s.qualified ? 'YES' : 'NO (disqualified)') + ' |');
  }

  // Decision rule:
  // 1. Filter qualified (median TTFT <= 1500ms)
  // 2. Highest pass rate wins
  // 3. On a tie, lower median TTFT
  const qualifiedModels = summary.filter(s => s.qualified);
  qualifiedModels.sort((a, b) => {
    if (b.rawPassRate !== a.rawPassRate) {
      return b.rawPassRate - a.rawPassRate;
    }
    return a.medianTtft - b.medianTtft;
  });

  console.log('\\nDecision Rule Application:');
  if (qualifiedModels.length > 0) {
    const winner = qualifiedModels[0];
    console.log(`🏆 WINNER: ${winner.model} (Pass Rate: ${winner.passRate}, Median TTFT: ${winner.medianTtft}ms)`);
    console.log(`Default model should be set to: ${winner.model}`);
  } else {
    console.log('⚠️ No model satisfied the TTFT <= 1.5s threshold.');
  }
}

main().catch(err => {
  console.error('Bake-off fatal error:', err);
  process.exit(1);
});
