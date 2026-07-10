/**
 * Diamond Access AI — Prompt module tests.
 *
 * Phase J: Persona + per-task prompt matrix. These tests are guardrails:
 *   - PERSONA_BLOCK contains the canonical anchor behaviors.
 *   - Each TASK_* constant has its expected response shape.
 *   - Builders substitute placeholders robustly (missing → fallback).
 *   - Privacy contract holds (no Gemma refs, persona isn't duplicated).
 *   - ARCHITECTURE holds (persona = system, task = user; not interleaved).
 */

import { describe, it, expect } from 'vitest';
import {
  PERSONA_BLOCK,
  PAGE_LOAD_TASK,
  COMMAND_TASK,
  VLM_TASK,
  CLARIFY_TASK,
  FAILURE_REVISE_TASK,
  PROFILE_TASK,
  buildCommandPrompt,
  buildPageLoadPrompt,
  buildVlmPrompt,
  buildClarifyPrompt,
  buildFailureRevisePrompt,
  buildProfileFillPrompt,
} from '../prompts';
import { emptySession } from '../storage';

describe('PERSONA_BLOCK', () => {
  it('declares Diamond by name', () => {
    expect(PERSONA_BLOCK).toMatch(/You are Diamond/);
  });

  it('includes voice rules', () => {
    expect(PERSONA_BLOCK).toMatch(/VOICE RULES/);
    expect(PERSONA_BLOCK).toMatch(/Speak like a thoughtful human/);
    expect(PERSONA_BLOCK).toMatch(/Certainly!/);
  });

  it('lists the 5 anchor behaviors', () => {
    expect(PERSONA_BLOCK).toMatch(/Never invent page content/);
    expect(PERSONA_BLOCK).toMatch(/3 sentences/);
    expect(PERSONA_BLOCK).toMatch(/ALWAYS go through the \{"action":"confirm"/);
    expect(PERSONA_BLOCK).toMatch(/CONVERSATION HISTORY/);
    expect(PERSONA_BLOCK).toMatch(/clarifying question/);
  });
});

describe('PAGE_LOAD_TASK', () => {
  it('specifies two spoken lines', () => {
    expect(PAGE_LOAD_TASK).toMatch(/two spoken lines/);
  });

  it('forbids bullet lists and JSON', () => {
    // Verify PAGE_LOAD_TASK explicitly tells the model not to emit list-
    // shaped output. The prompt legitimately uses `-` markers in its own
    // RULES section (that's template structure, not output shape), so we
    // check the OUTPUT description, not the template structure.
    expect(PAGE_LOAD_TASK).toMatch(/Never use bullet points/);
    expect(PAGE_LOAD_TASK).toMatch(/JSON/);
    expect(PAGE_LOAD_TASK).toMatch(/lists?/);
  });

  it('has placeholders for url/title/structure', () => {
    expect(PAGE_LOAD_TASK).toContain('{url}');
    expect(PAGE_LOAD_TASK).toContain('{title}');
    expect(PAGE_LOAD_TASK).toContain('{structure}');
  });
});

describe('COMMAND_TASK', () => {
  it('lists all five action schemas', () => {
    expect(COMMAND_TASK).toMatch(/"action":"none"/);
    expect(COMMAND_TASK).toMatch(/"action":"navigate"/);
    expect(COMMAND_TASK).toMatch(/"action":"click"/);
    expect(COMMAND_TASK).toMatch(/"action":"fill"/);
    expect(COMMAND_TASK).toMatch(/"action":"confirm"/);
  });

  it('forbids markdown fences', () => {
    expect(COMMAND_TASK).toMatch(/No \`\`\`json/);
  });

  it('has worked examples for click/navigate/fill/confirm', () => {
    expect(COMMAND_TASK).toMatch(/Add to Cart/i);
    expect(COMMAND_TASK).toMatch(/checkout/i);
    expect(COMMAND_TASK).toMatch(/email/i);
    expect(COMMAND_TASK).toMatch(/submit/i);
  });

  it('has placeholders for runtime context', () => {
    expect(COMMAND_TASK).toContain('{structure}');
    expect(COMMAND_TASK).toContain('{history}');
    expect(COMMAND_TASK).toContain('{goal}');
    expect(COMMAND_TASK).toContain('{transcript}');
    expect(COMMAND_TASK).toContain('{url}');
  });

  it('elementIndex 0 documented as a fallback', () => {
    expect(COMMAND_TASK).toMatch(/elementIndex 0/);
  });
});

describe('VLM_TASK', () => {
  it('specifies 3 response shapes (blank / gate / descriptive)', () => {
    expect(VLM_TASK).toMatch(/can't see anything/i);
    expect(VLM_TASK).toMatch(/gating access/i);
    expect(VLM_TASK).toMatch(/Otherwise:/);
  });

  it('forbids JSON and bullet lists', () => {
    expect(VLM_TASK).toMatch(/No bullet lists/);
  });
});

describe('CLARIFY_TASK', () => {
  it('specifies 1 sentence', () => {
    expect(CLARIFY_TASK).toMatch(/ONE spoken sentence/);
  });

  it('forbids JSON', () => {
    expect(CLARIFY_TASK).toMatch(/not JSON/);
  });
});

describe('FAILURE_REVISE_TASK', () => {
  it('specifies ONE attempt', () => {
    expect(FAILURE_REVISE_TASK).toMatch(/ONE attempt/);
  });

  it('escalates missed confirms on retry', () => {
    expect(FAILURE_REVISE_TASK).toMatch(/ALWAYS escalate to the \{"action":"confirm"/);
  });

  it('has a fallback schema (b)', () => {
    expect(FAILURE_REVISE_TASK).toMatch(/I couldn't recover/i);
  });
});

describe('PROFILE_TASK', () => {
  it('forbids VALUES from leaving the user machine', () => {
    expect(PROFILE_TASK).toMatch(/STAY ON THE USER'S MACHINE/i);
    expect(PROFILE_TASK).toMatch(/ONLY the LABELS/i);
  });

  it('instructs response shape with useProfileLabel', () => {
    expect(PROFILE_TASK).toMatch(/useProfileLabel/i);
  });

  it('forbids invented values', () => {
    expect(PROFILE_TASK).toMatch(/Never guess a value/i);
  });
});

describe('buildCommandPrompt', () => {
  it('substitutes placeholders', () => {
    const result = buildCommandPrompt({
      pageStructure: 'STRUCTURE_LINE',
      transcript: 'go to checkout',
      session: emptySession(),
      url: 'https://example.com',
    });

    expect(result).toContain('STRUCTURE_LINE');
    expect(result).toContain('go to checkout');
    expect(result).toContain('https://example.com');
    expect(result).not.toContain('{transcript}');
    expect(result).not.toContain('{history}');
    expect(result).not.toContain('{goal}');
    expect(result).not.toContain('{structure}');
    expect(result).not.toContain('{url}');
  });

  it('omits ACTIVE GOAL section when no active goal', () => {
    const result = buildCommandPrompt({
      pageStructure: '',
      transcript: 'summarize',
      session: emptySession(),
    });
    expect(result).not.toContain('ACTIVE GOAL:');
  });

  it('renders the active goal when present', () => {
    const result = buildCommandPrompt({
      pageStructure: '',
      transcript: 'continue',
      session: {
        ...emptySession(),
        activeGoal: 'Fill out the Acme Corp job application.',
        formState: {},
      },
    });
    expect(result).toContain('ACTIVE GOAL:');
    expect(result).toContain('Fill out the Acme Corp job application.');
  });

  it('renders conversation history in user/assistant shape', () => {
    const result = buildCommandPrompt({
      pageStructure: '',
      transcript: 'summarize',
      session: {
        ...emptySession(),
        conversation: [
          { user: 'go to x', assistant: 'Going to x.' },
          { user: 'summarize', assistant: 'Page summary here.' },
        ],
      },
    });
    expect(result).toContain('User: "go to x"');
    expect(result).toContain('Diamond: "Going to x."');
    expect(result).toContain('User: "summarize"');
  });

  it('caps history at the last 10 turns (MAX_TURNS)', () => {
    const history: { user: string; assistant: string }[] = [];
    for (let i = 0; i < 25; i++) {
      history.push({ user: `u${i}`, assistant: `a${i}` });
    }
    const result = buildCommandPrompt({
      pageStructure: '',
      transcript: 'now',
      session: { ...emptySession(), conversation: history },
    });
    expect(result).toContain('User: "u15"');
    expect(result).toContain('User: "u24"');
    expect(result).not.toContain('User: "u0"');
    expect(result).not.toContain('User: "u14"');
  });
});

describe('buildPageLoadPrompt', () => {
  it('substitutes url, title, structure', () => {
    const result = buildPageLoadPrompt({
      url: 'https://bbc.com/news',
      title: 'BBC News',
      structure: 'PAGE_STRUCT_LINE',
    });
    expect(result).toContain('https://bbc.com/news');
    expect(result).toContain('BBC News');
    expect(result).toContain('PAGE_STRUCT_LINE');
    expect(result).not.toContain('{url}');
    expect(result).not.toContain('{title}');
    expect(result).not.toContain('{structure}');
  });

  it('falls back to safe defaults for missing fields', () => {
    const result = buildPageLoadPrompt({
      url: '',
      title: '',
      structure: '',
    });
    expect(result).toContain('(no url)');
    expect(result).toContain('(no title)');
    expect(result).toContain('(empty page)');
  });
});

describe('buildVlmPrompt', () => {
  it('returns VLM_TASK verbatim', () => {
    expect(buildVlmPrompt()).toBe(VLM_TASK);
  });
});

describe('buildClarifyPrompt', () => {
  it('renumbers candidates and includes the original transcript', () => {
    const result = buildClarifyPrompt({
      transcript: 'click that',
      candidates: ['Add to Cart', 'Buy Now', 'Submit Application'],
    });
    expect(result).toContain('1. Add to Cart');
    expect(result).toContain('2. Buy Now');
    expect(result).toContain('3. Submit Application');
    expect(result).toContain('"click that"');
    expect(result).not.toContain('{transcript}');
    expect(result).not.toContain('{candidates_list}');
  });

  it('falls back to (unknown) transcript and (no candidates)', () => {
    const result = buildClarifyPrompt({
      transcript: '',
      candidates: [],
    });
    expect(result).toContain('(unknown)');
    expect(result).toContain('(no candidates)');
  });

  it('caps candidates at 5', () => {
    const result = buildClarifyPrompt({
      transcript: 'go',
      candidates: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'],
    });
    expect(result).toContain('5. e');
    expect(result).not.toContain('6. f');
  });
});

describe('buildFailureRevisePrompt', () => {
  it('substitutes placeholder fields', () => {
    const result = buildFailureRevisePrompt({
      previousResponse: '{"action":"click","elementIndex":99}',
      reason: 'element not found',
      newStructure: 'NEW_STRUCT',
    });
    expect(result).toContain('element not found');
    expect(result).toContain('NEW_STRUCT');
    expect(result).toContain('elementIndex":99');
    expect(result).not.toContain('{reason}');
    expect(result).not.toContain('{new_structure}');
  });

  it('falls back to safe defaults', () => {
    const result = buildFailureRevisePrompt({
      previousResponse: '',
      reason: '',
      newStructure: '',
    });
    expect(result).toContain('(empty)');
    expect(result).toContain('unspecified');
  });

  it('keeps the safety-net escalation rule visible', () => {
    const result = buildFailureRevisePrompt({
      previousResponse: 'x',
      reason: 'y',
      newStructure: 'z',
    });
    expect(result).toMatch(/ALWAYS escalate to the \{"action":"confirm"/);
  });
});

describe('buildProfileFillPrompt', () => {
  it('formats formLabels as element-indexed list with type', () => {
    const result = buildProfileFillPrompt({
      formLabels: [
        { elementIndex: 12, label: 'Email Address', type: 'email' },
        { elementIndex: 13, label: 'Phone Number', type: 'tel' },
      ],
      profileLabels: ['Home', 'Work'],
    });
    expect(result).toContain('elementIndex 12: "Email Address" (email)');
    expect(result).toContain('elementIndex 13: "Phone Number" (tel)');
    expect(result).toContain('- "Home"');
    expect(result).toContain('- "Work"');
  });

  it('falls back on empty inputs', () => {
    const result = buildProfileFillPrompt({
      formLabels: [],
      profileLabels: [],
    });
    expect(result).toContain('(no form fields)');
    expect(result).toContain('(no profile entries)');
  });
});

describe('architecture & privacy integration', () => {
  it('PERSONA_BLOCK is distinct from each TASK_* (no duplication)', () => {
    // The architecture migrated from "persona embedded in each task" 
    // to "persona = system role, task = user role". Verify the new 
    // shape holds — no PERSONA_BLOCK text leaks into TASK_*.
    const tasks: Array<[string, string]> = [
      ['PAGE_LOAD_TASK', PAGE_LOAD_TASK],
      ['COMMAND_TASK', COMMAND_TASK],
      ['VLM_TASK', VLM_TASK],
      ['CLARIFY_TASK', CLARIFY_TASK],
      ['FAILURE_REVISE_TASK', FAILURE_REVISE_TASK],
      ['PROFILE_TASK', PROFILE_TASK],
    ];
    for (const [name, task] of tasks) {
      expect(task, `${name} should not include PERSONA_BLOCK`).not.toContain(
        'FIVE ANCHOR BEHAVIORS',
      );
      expect(task, `${name} should not include PERSONA_BLOCK`).not.toContain(
        'VOICE RULES',
      );
    }
  });

  it('no Gemma / production-model references leak into prompts', () => {
    const all = [
      PERSONA_BLOCK,
      PAGE_LOAD_TASK,
      COMMAND_TASK,
      VLM_TASK,
      CLARIFY_TASK,
      FAILURE_REVISE_TASK,
      PROFILE_TASK,
    ];
    for (const text of all) {
      expect(text.toLowerCase()).not.toContain('gemma');
      expect(text).not.toContain('akfaleye');
      expect(text).not.toContain('t5rv9ps1');
    }
  });

  it('every TASK_* constant contains a TASK: marker', () => {
    expect(PAGE_LOAD_TASK).toMatch(/TASK:/);
    expect(COMMAND_TASK).toMatch(/TASK:/);
    expect(VLM_TASK).toMatch(/TASK:/);
    expect(CLARIFY_TASK).toMatch(/TASK:/);
    expect(FAILURE_REVISE_TASK).toMatch(/TASK:/);
    expect(PROFILE_TASK).toMatch(/TASK:/);
  });
});
