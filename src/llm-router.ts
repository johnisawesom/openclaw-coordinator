import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { setState, getState } from './ecosystem-state.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const google = new GoogleGenerativeAI(process.env.GOOGLE_AI_API_KEY ?? '');

export type LLMTask = 'fix_suggestion' | 'qa_validation' | 'research_synthesis' | 'code_generation';

interface LLMRequest {
  task: LLMTask;
  prompt: string;
  systemPrompt?: string;
  maxTokens?: number;
}

interface LLMResponse {
  text: string;
  provider: 'anthropic' | 'google';
  model: string;
}

interface TaskConfig {
  anthropicModel: string;
  googleModel: string;
}

const TASK_CONFIG: Record<LLMTask, TaskConfig> = {
  fix_suggestion: {
    anthropicModel: 'claude-haiku-4-5-20251001',
    googleModel: 'gemini-1.5-flash',
  },
  qa_validation: {
    anthropicModel: 'claude-haiku-4-5-20251001',
    googleModel: 'gemini-1.5-flash',
  },
  research_synthesis: {
    anthropicModel: 'claude-sonnet-4-6',
    googleModel: 'gemini-1.5-pro',
  },
  code_generation: {
    anthropicModel: 'claude-sonnet-4-6',
    googleModel: 'gemini-1.5-pro',
  },
};

const BACKOFF_MS = [1000, 2000, 4000];
const RATE_LIMIT_WINDOW_MS = 60 * 1000;

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function isRateLimitActive(): Promise<boolean> {
  try {
    const state = await getState('rate_limit_hit');
    if (!state || state.value !== 'true') return false;
    const setAt = new Date(state.updatedAt).getTime();
    const age = Date.now() - setAt;
    if (age > RATE_LIMIT_WINDOW_MS) {
      console.log(`[LLM] rate_limit_hit expired (age=${Math.round(age / 1000)}s) -- clearing`);
      setState('rate_limit_hit', 'false').catch(() => {});
      return false;
    }
    console.warn(`[LLM] rate_limit_hit active (age=${Math.round(age / 1000)}s) -- skipping Anthropic`);
    return true;
  } catch {
    return false;
  }
}

async function callAnthropic(
  model: string,
  prompt: string,
  systemPrompt: string,
  maxTokens: number,
  task: LLMTask
): Promise<string> {
  const rateLimited = await isRateLimitActive();
  if (rateLimited) {
    throw new Error('RATE_LIMIT_EXHAUSTED');
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      console.log(`[LLM] ${task} -> ${model} (anthropic attempt ${attempt + 1})`);
      const response = await anthropic.messages.create({
        model,
        max_tokens: maxTokens,
        system: systemPrompt,
        messages: [{ role: 'user', content: prompt }],
      });
      const block = response.content[0];
      if (block.type !== 'text') throw new Error('Non-text response from Anthropic');
      console.log(`[LLM] ${task} -> ${model} succeeded`);
      return block.text;
    } catch (err: unknown) {
      const error = err as { status?: number; message?: string };
      if (error.status === 429) {
        console.warn(`[LLM] ${task} -> ${model} rate limited (attempt ${attempt + 1})`);
        if (attempt < 2) {
          await sleep(BACKOFF_MS[attempt] ?? 1000);
          continue;
        }
        console.warn(`[LLM] ${task} -> ${model} rate limit exhausted after 3 attempts -- setting ecosystem rate_limit_hit`);
        setState('rate_limit_hit', 'true', 'llm-router').catch(() => {});
        throw new Error('RATE_LIMIT_EXHAUSTED');
      }
      console.error(`[LLM] ${task} -> ${model} non-rate-limit error: status=${error.status ?? 'none'} message=${error.message ?? 'unknown'}`);
      throw err;
    }
  }
  throw new Error('RATE_LIMIT_EXHAUSTED');
}

async function callGoogle(
  model: string,
  prompt: string,
  systemPrompt: string,
  maxTokens: number,
  task: LLMTask
): Promise<string> {
  try {
    console.log(`[LLM] ${task} -> ${model} (google fallback)`);
    const generativeModel = google.getGenerativeModel({
      model,
      systemInstruction: systemPrompt,
    });
    const result = await generativeModel.generateContent({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: maxTokens },
    });
    const text = result.response.text();
    console.log(`[LLM] ${task} -> ${model} (google) succeeded`);
    return text;
  } catch (err: unknown) {
    const error = err as { message?: string };
    console.error(`[LLM] ${task} -> ${model} (google) failed: ${error.message ?? 'unknown'}`);
    throw new Error('GOOGLE_FAILED');
  }
}

export async function callLLM(request: LLMRequest): Promise<LLMResponse> {
  const { task, prompt, systemPrompt = '', maxTokens = 500 } = request;
  const config = TASK_CONFIG[task];

  try {
    const text = await callAnthropic(
      config.anthropicModel,
      prompt,
      systemPrompt,
      maxTokens,
      task
    );
    return { text, provider: 'anthropic', model: config.anthropicModel };
  } catch (err: unknown) {
    const error = err as { message?: string };
    if (error.message === 'RATE_LIMIT_EXHAUSTED') {
      try {
        const text = await callGoogle(
          config.googleModel,
          prompt,
          systemPrompt,
          maxTokens,
          task
        );
        return { text, provider: 'google', model: config.googleModel };
      } catch {
        console.error(`[LLM] BOTH_FAILED for task ${task} -- both providers exhausted`);
        throw new Error(`LLM_BOTH_FAILED:${task}`);
      }
    }
    console.error(`[LLM] BOTH_FAILED for task ${task} -- anthropic non-rate-limit error`);
    throw new Error(`LLM_BOTH_FAILED:${task}`);
  }
}
