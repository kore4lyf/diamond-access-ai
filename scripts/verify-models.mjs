#!/usr/bin/env node
/**
 * verify-models.mjs — Verify Fireworks AI model availability
 *
 * Run before writing any code: node scripts/verify-models.mjs
 * Exits with code 0 if all models are live, code 1 if not.
 *
 * Reads FW_KEY from environment or .env file at project root.
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// --- Load FW_KEY from .env if not already in environment ---

if (!process.env.FW_KEY) {
  try {
    const envPath = join(__dirname, '..', '.env');
    const envContent = readFileSync(envPath, 'utf8');
    const match = envContent.match(/^FW_KEY=(.+)$/m);
    if (match) {
      process.env.FW_KEY = match[1].trim().replace(/^["']|["']$/g, '');
    }
  } catch {
    // .env not found — will fail below with a clear message
  }
}

// --- Configuration ---

// const FIREWORKS_URL = 'https://api.fireworks.ai/inference/v1/chat/completions';

// Deployment model ID — replace with your own from `firectl deployment list`
// const MODEL_ID = 'accounts/akfaleye-inml6ysynwm/deployments/t5rv9ps1';

const MODELS = [
  {
    tier: 'dev',
    id: 'accounts/fireworks/models/minimax-m3',
    label: 'MiniMax M3 (dev - serverless)',
  },
  {
    tier: 'prod',
    id: MODEL_ID,
    label: 'Gemma 4 31B IT (on-demand deployment)',
  },
];

// --- Helpers ---

async function testModel(model) {
  const apiKey = process.env.FW_KEY;
  if (!apiKey) {
    console.error('[FAIL] FW_KEY not set. Export it or add to .env:');
    console.error('       export FW_KEY="your-fireworks-api-key"');
    process.exit(1);
  }

  console.log(`[INFO] Verifying: ${model.label}`);
  console.log(`       Model ID: ${model.id}`);
  console.log(`       URL:      ${FIREWORKS_URL}`);

  try {
    const response = await fetch(FIREWORKS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: model.id,
        messages: [{ role: 'user', content: 'Say hello in one word.' }],
        max_tokens: 10,
      }),
    });

    if (response.ok) {
      const data = await response.json();
      const reply = data.choices?.[0]?.message?.content || '(no content)';
      console.log(`[OK]   Live. Response: "${reply}"`);
      return true;
    }

    const error = await response.text();
    console.error(`[FAIL] HTTP ${response.status}: ${error}`);
    return false;
  } catch (error) {
    console.error(`[FAIL] Network error: ${error.message}`);
    console.error('       Check your internet connection and FW_KEY.');
    return false;
  }
}

// --- Main ---

async function main() {
  console.log('=== Diamond Access AI — Model Verification ===\n');

  let allPassed = true;

  for (const model of MODELS) {
    const passed = await testModel(model);
    if (!passed) allPassed = false;
    console.log('');
  }

  if (allPassed) {
    console.log('[OK] All models verified. Ready for development.');
    process.exit(0);
  } else {
    console.error('[FAIL] One or more models failed. See above for details.');
    process.exit(1);
  }
}

main();
