#!/usr/bin/env node
/**
 * verify-models.mjs — Verify Gemma 4 model ID on Fireworks AI
 * 
 * Run before writing any code: node scripts/verify-models.mjs
 * Exits with code 0 if model is live, code 1 if not.
 * 
 * Requires FW_KEY environment variable (Fireworks API key).
 */

const MODEL_ID = 'accounts/fireworks/models/gemma-4-26b-a4b-it';
const FIREWORKS_URL = 'https://api.fireworks.ai/inference/v1/chat/completions';

async function verify() {
  const apiKey = process.env.FW_KEY;
  if (!apiKey) {
    console.error('❌ FW_KEY environment variable not set');
    console.error('   Run: export FW_KEY="your-fireworks-api-key"');
    process.exit(1);
  }

  console.log(`🔍 Verifying model: ${MODEL_ID}`);
  console.log(`   URL: ${FIREWORKS_URL}`);

  try {
    const response = await fetch(FIREWORKS_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: MODEL_ID,
        messages: [{ role: 'user', content: 'Say hello in one word.' }],
        max_tokens: 10
      })
    });

    if (response.ok) {
      const data = await response.json();
      const reply = data.choices?.[0]?.message?.content || '(no content)';
      console.log(`✅ Model is live! Response: "${reply}"`);
      console.log(`   Model ID: ${MODEL_ID}`);
      process.exit(0);
    } else {
      const error = await response.text();
      console.error(`❌ Model returned ${response.status}: ${error}`);
      
      // Try fallback model ID (without -it suffix)
      const fallbackId = 'accounts/fireworks/models/gemma-4-26b-a4b';
      console.log(`\n🔍 Trying fallback: ${fallbackId}`);
      
      const fallbackResponse = await fetch(FIREWORKS_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: fallbackId,
          messages: [{ role: 'user', content: 'Say hello in one word.' }],
          max_tokens: 10
        })
      });

      if (fallbackResponse.ok) {
        const fallbackData = await fallbackResponse.json();
        const fallbackReply = fallbackData.choices?.[0]?.message?.content || '(no content)';
        console.log(`✅ Fallback model is live! Response: "${fallbackReply}"`);
        console.log(`   Use this model ID: ${fallbackId}`);
        process.exit(0);
      } else {
        const fallbackError = await fallbackResponse.text();
        console.error(`❌ Fallback also failed (${fallbackResponse.status}): ${fallbackError}`);
        console.error('\n📋 Next steps:');
        console.error('   1. Check Fireworks docs for correct Gemma 4 model ID');
        console.error('   2. Contact hackathon organizers for model ID clarification');
        console.error('   3. See DOC-MODEL-ADR.md for verification plan');
        process.exit(1);
      }
    }
  } catch (error) {
    console.error(`❌ Network error: ${error.message}`);
    console.error('   Check your internet connection and FW_KEY');
    process.exit(1);
  }
}

verify();
