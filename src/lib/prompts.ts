/**
 * Diamond Access AI — System Prompts
 *
 * Phase E: Verbatim system prompt from DOC-CALL-STRATEGY §3, plus
 *          auxiliary prompts for PAGE_LOAD summarization and VLM.
 *
 * Guardrails:
 *   - DEV_MODEL_ID only (MiniMax M3 — both text and vision)
 *   - No Gemma references
 *   - No secrets
 */

// ---------------------------------------------------------------------------
// System prompt (verbatim — DOC-CALL-STRATEGY §3)
// ---------------------------------------------------------------------------

/**
 * System prompt for Diamond's command handler.
 *
 * Copied verbatim from DOC-CALL-STRATEGY.md §3.
 * If DOC-CALL-STRATEGY.md changes, update this constant.
 */
export const SYSTEM_PROMPT = `You are Diamond, an AI accessibility assistant for blind and low-vision users.
You help users interact with web pages through voice commands.

RULES:
1. Never invent page content. If you can't find something on the page, say so clearly.
2. Be concise. All responses are spoken aloud — keep them under 3 sentences unless the user asks for detail.
3. For actions (click, fill, navigate), respond ONLY with the JSON action object matching one of the schemas below. No prose, no explanation before or after the JSON.
4. For irreversible actions (submit order, delete, purchase, send), always ask for verbal confirmation first. Use the confirm action schema.
5. When listing items, always include the count and offer to hear more.
6. Refer to prior conversation context naturally — "You mentioned X earlier..."
7. If you don't understand the command, ask the user to rephrase. Never guess.

ACTION SCHEMAS (use when the command requires an action):
{"action": "none", "speech": "<response text>"}
{"action": "navigate", "url": "<path>", "description": "<what you're doing>"}
{"action": "click", "elementIndex": <number>, "description": "<what you're clicking>"}
{"action": "fill", "fields": [{"elementIndex": <number>, "value": "<text>"}], "description": "<what you're filling>"}
{"action": "confirm", "speech": "<confirmation prompt>", "pendingAction": {<action object>}}

RULES FOR JSON:
- Respond ONLY with valid JSON matching one of the schemas above.
- No prose before or after the JSON object.
- elementIndex corresponds to the numbered interactive elements in the page structure you receive.`;

// ---------------------------------------------------------------------------
// Auxiliary prompts
// ---------------------------------------------------------------------------

/**
 * Prompt template for the auto-summary on page load.
 * {url} — current page URL
 * {structure} — page structure from DOM walk
 */
export const PAGE_LOAD_PROMPT_TEMPLATE =
  'You are on {url}. Here is the page:\n{structure}\n\nSummarize in one sentence what this page is for.';

/**
 * System prompt for the VLM (vision) call when DOM is sparse.
 */
export const VLM_SYSTEM_PROMPT = `You are Diamond's vision component. Describe this webpage screenshot concisely for a blind user. Include what type of page it is, what main sections are visible, and what actions are available. Keep it under 3 sentences.`;

/**
 * Prompt added to COMMAND when VLM description is available.
 */
export function buildVlmContextPrompt(description: string): string {
  return `Visual context (screenshot analysis):\n${description}\n\n`;
}

// ---------------------------------------------------------------------------
// Context block builder (Phase G)
// ---------------------------------------------------------------------------

import type { SessionState } from './storage';

/**
 * Build a multi-layer command prompt incorporating conversation context.
 *
 * Layer order per DOC-CONTEXT-MEMORY §3:
 *   SYSTEM PROMPT
 *   [ACTIVE GOAL] (if set)
 *   [CONVERSATION HISTORY] (last MAX_TURNS turns)
 *   PAGE STRUCTURE
 *   URL:
 *   USER COMMAND:
 *
 * @remarks
 * - `formState` values are NEVER included in the prompt (PII guard §6).
 * - History is defensively sliced to the last 10 turns.
 * - Empty active goal section is omitted.
 */
export function buildCommandPrompt(opts: {
  systemPrompt: string;
  pageStructure: string;
  transcript: string;
  session: SessionState;
  url?: string;
}): string {
  const parts: string[] = [opts.systemPrompt];

  // Active goal
  if (opts.session.activeGoal) {
    parts.push('');
    parts.push('ACTIVE GOAL:');
    parts.push(opts.session.activeGoal);
  }

  // Conversation history (defensively slice to MAX_TURNS)
  const history = opts.session.conversation.slice(-10);
  if (history.length > 0) {
    parts.push('');
    parts.push('CONVERSATION HISTORY:');
    for (const turn of history) {
      parts.push(`User: "${turn.user}"`);
      parts.push(`Diamond: "${turn.assistant}"`);
    }
  }

  // Page structure
  parts.push('');
  parts.push('PAGE STRUCTURE:');
  parts.push(opts.pageStructure);

  // URL
  if (opts.url) {
    parts.push('');
    parts.push('URL:');
    parts.push(opts.url);
  }

  // User command
  parts.push('');
  parts.push('USER COMMAND:');
  parts.push(opts.transcript);

  return parts.join('\n');
}
