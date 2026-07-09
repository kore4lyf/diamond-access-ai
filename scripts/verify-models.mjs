#!/usr/bin/env node
/**
 * verify-models.mjs — Verify Fireworks AI model availability
 *
 * Run before writing any code: node scripts/verify-models.mjs
 * Exits with code 0 if minimax is live, code 1 if not.
 *
 * ARCHITECTURE NOTE:
 * - MiniMax M3: DEV/SERVERLESS model. Used for testing during development.
 * - Gemma 4 31B IT: PRODUCTION model. Self-hosted on AMD hardware.
 *   NEVER used in this script or during development — provided manually at deploy time.
 *   The production deployment on AMD will call Gemma directly, not through this verifier.
 *
 * Reads FW_KEY from environment or .env file at project root.
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const FIREWORKS_URL = 'https://api.fireworks.ai/inference/v1/chat/completions';

// --- Load FW_KEY / VITE_FW_KEY from .env if not already in environment ---

function loadEnvKey(variableName) {
  try {
    const envPath = join(__dirname, '..', '.env');
    const envContent = readFileSync(envPath, 'utf8');
    const match = envContent.match(new RegExp(`^${variableName}=(.+)$`, 'm'));
    if (match) {
      return match[1].trim().replace(/^["']|["']$/g, '');
    }
  } catch {
    // .env not found
  }
  return null;
}

if (!process.env.FW_KEY) {
  process.env.FW_KEY =
    process.env.VITE_FW_KEY || loadEnvKey('VITE_FW_KEY') || loadEnvKey('FW_KEY') || '';
}

// --- Model configs ---

const MINIMAX = {
  tier: 'dev',
  id: 'accounts/fireworks/models/minimax-m3',
  label: 'MiniMax M3 (dev - serverless)',
};

const GEMMA = {
  tier: 'prod',
  id: 'accounts/fireworks/models/gemma-4-31b-it',
  label: 'Gemma 4 31B IT (production)',
};

// --- Helper ---

async function testModel(model) {
  const apiKey = process.env.FW_KEY;
  if (!apiKey) {
    console.error('[FAIL] FW_KEY not set. Export it or add to .env:');
    console.error('       export FW_KEY="your-fireworks-api-key"');
    process.exit(1);
  }

  console.log(`[INFO] Verifying: ${model.label}`);
  console.log(`       Model ID: ${model.id}`);

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

// --- Public functions ---

/**
 * Test MiniMax M3 (dev model) - no deployment setup required.
 * Use this before development to verify API key works.
 */
export async function testMinimax() {
  console.log('=== Diamond Access AI — MiniMax Verification ===\n');
  const passed = await testModel(MINIMAX);
  if (passed) {
    console.log('\n[OK] MiniMax M3 verified. Ready for development.');
    process.exit(0);
  } else {
    console.error('\n[FAIL] MiniMax M3 failed. Check your FW_KEY and connection.');
    process.exit(1);
  }
}

/**
 * Test Gemma 4 31B IT (production model).
 * NEVER used during development — this function exists for reference only.
 * Production deployment: AMD-hosted Gemma is provided manually at deploy time.
 * Gemma calls happen in on-prem AMD hardware, not through this script.
 * DO NOT invoke this function — costs will apply and is unnecessary for dev.
 */
export async function testGemma() {
  console.log('=== Diamond Access AI — Gemma Verification ===\n');
  const passed = await testModel(GEMMA);
  if (passed) {
    console.log('\n[OK] Gemma verified.');
    process.exit(0);
  } else {
    console.error('\n[FAIL] Gemma failed. Check your deployment ID.');
    process.exit(1);
  }
}

// --- Main (minimax only) ---

if (import.meta.url === `file://${process.argv[1]}`) {
  testMinimax().catch(() => process.exit(1));
}