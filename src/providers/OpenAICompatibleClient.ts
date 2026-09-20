import { type ChatMessage, type ContentPart, type ModelInfo, type ProviderConfig, type StreamDelta, type ThinkingBlock, type ToolCall } from '../types';

// NOTE: The Techword API serves the Anthropic Messages API at /v1/messages. The OpenAI
// /v1/chat/completions path is blocked upstream by a Cloudflare bot check, so this client speaks
// the Anthropic Messages API wire format on /v1/messages.
const MAX_TOKENS = 16384;
const ANTHROPIC_VERSION = '2023-06-01';
const MAX_RETRIES = 6;
// The gateway load-balances each request onto an upstream "channel". A key may be cleared for only
// some channels, so a request can be randomly rejected (403) even though the key is perfectly valid —
// retrying re-rolls the channel and usually lands on an allowed one. This is the budget for that
// re-roll, kept separate from MAX_RETRIES so a run of bad rolls never eats the network-error budget.
const CHANNEL_RETRIES = 10;
const STREAM_IDLE_MS = 60000; // if no stream data arrives for this long, surface an error instead of hanging
// Time-to-first-byte watchdog. This upstream withholds response headers until the model starts generating,
// and channels vary wildly (measured ~4s on a fast channel vs ~37s+ on a stuck one for identical requests).
// A stuck channel would block in fetch() until the proxy's ~100s origin timeout → 524. So on the fast path
// we cap the headers wait and re-roll onto a fresh channel — the same thing a manual retry did.
const TTFB_TIMEOUT_MS = 25000; // headers not here in 25s = a stuck channel (fast channels deliver in <6s)
const TTFB_REROLL_BUDGET = 3;  // after this many re-rolls the upstream is slow everywhere — stop capping, wait it out
const DEFAULT_THINKING_BUDGET = 2048; // modest reasoning budget: real thinking in Activity without ballooning cost
const MIN_THINKING_BUDGET = 1024;     // Anthropic's floor for budget_tokens

interface OpenAIModelResponse { data?: Array<{ id?: string; name?: string }>; }

/** Thrown when the gateway rejects the extended-thinking request (param unsupported, bad budget, or a
 *  signature it won't validate). The session catches this, turns thinking off, and retries once without
 *  it — so a gateway that can't do thinking degrades to the normal path instead of failing the task. */
export class ThinkingUnsupportedError extends Error {
  constructor(message: string) { super(message); this.name = 'ThinkingUnsupportedError'; }
}

/** Detect a gateway rejection that's specifically about extended thinking, so we can retry without it. */
export function isThinkingRejection(status: number, rawDetail: string): boolean {
  if (status !== 400 && status !== 422) { return false; }
  return /thinking|budget_tokens|extended.?thinking|reasoning|signature/i.test(rawDetail);
}

/** The request fields that control reasoning/creativity, decided from the client's settings. Extracted so
 *  the speed-critical rule can be unit-tested: the upstream runs slow hidden reasoning UNLESS thinking is
 *  EXPLICITLY disabled, so the default (thinking off) MUST send {type:'disabled'} — never omit it. */
export function thinkingParams(input: {
  thinkingOn: boolean;
  maxTokens: number;
  sendDisabledThinking: boolean;
  thinkingBudget?: number;
  temperature?: number;
}): { thinking?: { type: 'enabled'; budget_tokens: number } | { type: 'disabled' }; temperature?: number } {
  const thinkOn = input.thinkingOn && input.maxTokens > MIN_THINKING_BUDGET + 256;
  if (thinkOn) {
    // Extended thinking on: Anthropic requires temperature unset and the budget strictly below max_tokens.
    const want = input.thinkingBudget && input.thinkingBudget > 0 ? input.thinkingBudget : DEFAULT_THINKING_BUDGET;
    const budget = Math.max(MIN_THINKING_BUDGET, Math.min(want, input.maxTokens - 256));
    return { thinking: { type: 'enabled', budget_tokens: budget } };
  }
  const out: { thinking?: { type: 'disabled' }; temperature?: number } = {};
  if (input.sendDisabledThinking) { out.thinking = { type: 'disabled' }; } // the ≈10× speed lever
  if (typeof input.temperature === 'number') { out.temperature = Math.min(1, Math.max(0, input.temperature)); }
  return out;
}

/** Should this attempt cap the time-to-first-byte and re-roll a stuck channel? Only when thinking is OFF
 *  (a long first byte is EXPECTED with extended thinking, so never cut it there) and we're still within the
 *  re-roll budget (past it, the upstream is slow everywhere — stop cutting good connections, wait it out). */
export function shouldCapFirstByte(thinkingEnabled: boolean, ttfbRerolls: number): boolean {
  return !thinkingEnabled && ttfbRerolls < TTFB_REROLL_BUDGET;
}

/** An API error tagged with whether it's worth retrying. `terminal` errors (dead key, no tokens,
 *  model not on plan) must stop the task — retrying can never succeed. Everything else is transient. */
export class TechwordApiError extends Error {
  constructor(message: string, readonly terminal: boolean) { super(message); this.name = 'TechwordApiError'; }
}

/** Should the agent give up, or keep retrying? Only a TechwordApiError marked terminal stops a task;
 *  network drops, timeouts, and stream stalls are all transient and should be retried indefinitely. */
export function isTerminalError(error: unknown): boolean {
  return error instanceof TechwordApiError && error.terminal;
}

interface AnthropicContentBlock { type: string; text?: string; id?: string; name?: string; input?: unknown; input_json_delta?: string; thinking?: string; signature?: string; data?: string; }
interface AnthropicEvent {
  type: string;
  index?: number;
  delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string; thinking?: string; signature?: string };
  content_block?: AnthropicContentBlock;
  message?: { usage?: { input_tokens?: number; output_tokens?: number } };
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { message?: string };
}

type AnthropicPart = { type: 'text'; text: string } | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } } | { type: 'tool_use'; id: string; name: string; input: unknown } | { type: 'tool_result'; tool_use_id: string; content: string } | { type: 'thinking'; thinking: string; signature: string } | { type: 'redacted_thinking'; data: string };
interface AnthropicMessage { role: 'user' | 'assistant'; content: string | AnthropicPart[]; }

export interface GenerationOptions {
  maxTokens?: number;
  temperature?: number;
  /** Ask the model to emit real reasoning (extended thinking). Shown in Activity, not the chat answer. */
  thinking?: boolean;
  /** Token budget for reasoning. Clamped to [1024, maxTokens - 1024]. Defaults to 2048. */
  thinkingBudget?: number;
}

export class OpenAICompatibleClient {
  // Runtime thinking switch: starts from options.thinking, but flips off for the rest of this client's
  // life the moment the gateway rejects a thinking request — so we don't keep re-sending a param it hates.
  private thinkingOn: boolean;
  // Speed lever. The upstream runs slow hidden reasoning UNLESS thinking is EXPLICITLY disabled, so every
  // non-thinking turn sends {type:'disabled'} (measured ≈10× faster first byte: ~4s vs ~40s). Starts true;
  // flips off only if a gateway proves it rejects even the disabled param, so a stricter server degrades
  // to omitting it instead of hard-failing the task.
  private sendDisabledThinking = true;
  // One continuous retry counter across the whole outage, so the user sees a number that climbs
  // (attempt 1, 2, 3…) proving it's actively retrying — not a "1/6" that resets and looks stuck.
  // Only a fully-completed turn resets it; a fresh connection mid-outage does not.
  private attemptSeq = 0;

  constructor(private readonly provider: ProviderConfig, private readonly apiKey: string, private readonly options: GenerationOptions = {}) {
    this.thinkingOn = options.thinking === true;
  }

  /** Turn extended thinking off for this client after a gateway rejection. */
  disableThinking(): void { this.thinkingOn = false; }
  get thinkingEnabled(): boolean { return this.thinkingOn; }

  /** Next retry number in the continuous sequence (for the "retrying (attempt N)…" status). */
  bumpAttempt(): number { this.attemptSeq += 1; return this.attemptSeq; }
  /** Reset the retry counter — called only when a turn completes cleanly. */
  resetAttempts(): void { this.attemptSeq = 0; }

  static normalizeBaseUrl(input: string): string {
    const url = new URL(input.trim());
    const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1';
    if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
      throw new Error('Provider URL must use HTTPS. HTTP is allowed only for localhost.');
    }
    if (url.username || url.password || url.search || url.hash) {
      throw new Error('Provider URL cannot contain credentials, a query string, or a fragment.');
    }
    url.pathname = url.pathname.replace(/\/+$/, '');
    return url.toString().replace(/\/$/, '');
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    let response: Response;
    try {
      response = await fetch(this.endpoint('/models'), { headers: this.headers(), signal: signal ?? AbortSignal.timeout(20000) });
    } catch (error) { throw this.describeNetworkError(error); }
    if (!response.ok) { throw await this.failure(response); }
    const body = await response.json() as OpenAIModelResponse;
    return (body.data ?? []).flatMap((model) => model.id ? [{ id: model.id, displayName: model.name }] : []);
  }

  async *streamCompletion(messages: ChatMessage[], tools: unknown[], signal?: AbortSignal): AsyncGenerator<StreamDelta> {
    const { system, msgs } = this.toAnthropic(messages);
    const maxTokens = this.options.maxTokens && this.options.maxTokens > 0 ? this.options.maxTokens : MAX_TOKENS;
    const body: Record<string, unknown> = { model: this.requireModel(), max_tokens: maxTokens, messages: msgs, stream: true };
    // Reasoning/creativity fields. CRITICAL for speed: the default (thinking off) sends {type:'disabled'},
    // which is ≈10× faster to first byte than omitting the param — see thinkingParams.
    const think = thinkingParams({ thinkingOn: this.thinkingOn, maxTokens, sendDisabledThinking: this.sendDisabledThinking, thinkingBudget: this.options.thinkingBudget, temperature: this.options.temperature });
    const thinkOn = think.thinking?.type === 'enabled';
    if (think.thinking) { body.thinking = think.thinking; }
    if (typeof think.temperature === 'number') { body.temperature = think.temperature; }
    if (system) { body.system = system; }
    if (Array.isArray(tools) && tools.length > 0) { body.tools = tools; body.tool_choice = { type: 'auto' }; }

    // Persist through transient failures: retry network errors and 429/5xx with backoff.
    // Do NOT retry auth/quota/bad-request errors — those need the user to act.
    const RETRY_STATUS = new Set([408, 429, 500, 502, 503, 504, 520, 522, 523, 524]);
    let response: Response | undefined;
    let channelRetries = 0;
    let ttfbRerolls = 0;
    // One user-abort listener for the whole call. It aborts whichever attempt is in flight (activeController),
    // and — after a successful fetch — the very controller whose body we're streaming, so a user Stop also
    // interrupts reader.read() below. { once } auto-removes it when it fires; if it never fires, the finally
    // at the end of the method removes it. A TTFB timeout aborts activeController directly (not via signal),
    // so it never consumes this listener.
    let activeController: AbortController | undefined;
    const onUserAbort = (): void => activeController?.abort();
    signal?.addEventListener('abort', onUserAbort, { once: true });
    try {
    for (let attempt = 0; ; attempt += 1) {
      if (signal?.aborted) { throw new Error('Stopped.'); }
      activeController = new AbortController();
      const capFirstByte = shouldCapFirstByte(thinkOn, ttfbRerolls);
      let ttfbFired = false;
      let ttfbTimer: ReturnType<typeof setTimeout> | undefined;
      if (capFirstByte) { const c = activeController; ttfbTimer = setTimeout(() => { ttfbFired = true; c.abort(); }, TTFB_TIMEOUT_MS); }
      try {
        // Accept: text/event-stream tells the gateway (and every proxy hop) this is an SSE request, so
        // it flushes each event as it arrives instead of buffering the whole reply — the same header the
        // Anthropic SDK / Claude Code send. Buffering upstream is a common cause of a slow-to-start stream
        // that then trips a proxy idle-timeout (524) — exactly the retries the user was seeing.
        response = await fetch(this.endpoint('/messages'), { method: 'POST', headers: { ...this.headers(), 'content-type': 'application/json', Accept: 'text/event-stream' }, signal: activeController.signal, body: JSON.stringify(body) });
      } catch (error) {
        if (signal?.aborted) { throw new Error('Stopped.'); }
        // Headers didn't arrive in time: this channel is stuck. Re-roll onto a fresh one (the gateway picks
        // a new channel each try) on its own budget — exactly what a manual retry did. Don't fail, don't
        // spend the network-error budget. Once the budget is gone, shouldCapFirstByte() stops capping and
        // the next attempt just waits the connection out under the idle watchdog instead.
        if (ttfbFired) {
          ttfbRerolls += 1;
          yield { status: `Finding a faster server — retrying (attempt ${this.bumpAttempt()})…` };
          attempt -= 1;
          await this.sleep(300, signal);
          continue;
        }
        if (attempt < MAX_RETRIES) { yield { status: `Connection problem — retrying (attempt ${this.bumpAttempt()})…` }; await this.backoff(attempt, signal); continue; }
        throw this.describeNetworkError(error);
      } finally {
        if (ttfbTimer) { clearTimeout(ttfbTimer); }
      }
      if (response.ok) { break; }
      const detail = await response.text();
      // A channel-routing rejection: the key is valid but got load-balanced onto a channel it can't
      // use. Re-roll quickly (the gateway picks a fresh channel each try) on its own budget. Don't
      // count it against attempt/MAX_RETRIES. This is what the user was doing by hand with "retry".
      if (this.isChannelRejection(response.status, detail) && channelRetries < CHANNEL_RETRIES && !signal?.aborted) {
        channelRetries += 1;
        yield { status: `Routing to an available server — retrying (${channelRetries}/${CHANNEL_RETRIES})…` };
        attempt -= 1; // this try shouldn't consume the network-error budget
        await this.sleep(300, signal);
        continue;
      }
      // The gateway rejected the thinking param. Two cases, neither of which should fail the task:
      //  - We asked to ENABLE thinking → tell the session to turn it off and retry on the normal path.
      //  - It rejected our {type:'disabled'} speed default → stop sending that param and retry, so a
      //    stricter gateway degrades to the plain path instead of hard-failing on a 400/422.
      if (isThinkingRejection(response.status, detail)) {
        if (thinkOn) { throw new ThinkingUnsupportedError('Extended thinking is not available on this gateway — continuing without it.'); }
        if (this.sendDisabledThinking) {
          this.sendDisabledThinking = false;
          delete body.thinking;
          yield { status: 'Adjusting request for this server…' };
          attempt -= 1; // a one-time config re-roll, not a network failure — don't spend the retry budget
          await this.sleep(200, signal);
          continue;
        }
      }
      if (RETRY_STATUS.has(response.status) && attempt < MAX_RETRIES && !signal?.aborted) {
        // 520/522/523/524 are the proxy hop timing out on the upstream, not the provider being "busy".
        // Say "reconnecting" for those (calmer, and true); reserve "busy" for a real 429/503 from upstream.
        const proxyTimeout = response.status >= 520;
        const label = proxyTimeout ? 'Reconnecting to Techword' : `Provider busy (${response.status})`;
        yield { status: `${label} — retrying (attempt ${this.bumpAttempt()})…` };
        await this.backoff(attempt, signal);
        continue;
      }
      throw this.httpError(response.status, detail, response.statusText);
    }
    if (!response || !response.body) { throw new Error('Techword API returned an empty response.'); }

    const decoder = new TextDecoder();
    const reader = response.body.getReader();
    let buffer = '';
    const openBlocks = new Map<number, { id: string; name: string; json: string }>();
    // Extended-thinking blocks are streamed the same way: a start, a run of deltas, a stop. Track the
    // open one per index so we can accumulate its text + signature, then seal it into thinkingBlocks.
    const openThinks = new Map<number, { kind: 'thinking' | 'redacted_thinking'; text: string; signature: string; data: string }>();
    const thinkingBlocks: ThinkingBlock[] = [];
    const toolCalls: ToolCall[] = [];
    let inputTokens = 0;
    let outputTokens = 0;
    let carry = ''; // holds a trailing partial that might be the start of a filtered word across chunks
    let stopReason: string | undefined; // why the model stopped, from message_delta — drives continue-vs-done in the loop

    while (true) {
      // Idle watchdog: if no data arrives for a while, don't hang silently — surface an error.
      let timer: ReturnType<typeof setTimeout> | undefined;
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('idle')), STREAM_IDLE_MS); })
        ]);
      } catch {
        void reader.cancel().catch(() => undefined);
        if (signal?.aborted) { throw new Error('Stopped.'); }
        // The stream went idle mid-reply (dropped connection, proxy hiccup). Non-terminal: the agent
        // loop reconnects and continues on its own, so a long autonomous run survives a network blip.
        throw new TechwordApiError('Connection dropped mid-reply.', false);
      } finally {
        if (timer) { clearTimeout(timer); }
      }
      const { value, done } = result;
      if (done) { break; }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data:')) { continue; }
        const data = line.slice(5).trim();
        if (!data) { continue; }
        let event: AnthropicEvent;
        try { event = JSON.parse(data) as AnthropicEvent; } catch { continue; }
        switch (event.type) {
          case 'message_start':
            inputTokens = event.message?.usage?.input_tokens ?? inputTokens;
            break;
          case 'content_block_start':
            if (event.content_block?.type === 'tool_use') {
              openBlocks.set(event.index ?? 0, { id: event.content_block.id ?? `tool_${event.index ?? 0}`, name: event.content_block.name ?? '', json: '' });
            } else if (event.content_block?.type === 'thinking' || event.content_block?.type === 'redacted_thinking') {
              openThinks.set(event.index ?? 0, {
                kind: event.content_block.type,
                text: event.content_block.thinking ?? '',
                signature: event.content_block.signature ?? '',
                data: event.content_block.data ?? '',
              });
              if (event.content_block.thinking) { yield { thinking: event.content_block.thinking }; }
            }
            break;
          case 'content_block_delta':
            if (event.delta?.type === 'thinking_delta' && event.delta.thinking) {
              const think = openThinks.get(event.index ?? 0);
              if (think) { think.text += event.delta.thinking; }
              yield { thinking: event.delta.thinking }; // stream reasoning to Activity in real time
            }
            else if (event.delta?.type === 'signature_delta' && event.delta.signature) {
              const think = openThinks.get(event.index ?? 0);
              if (think) { think.signature += event.delta.signature; }
            }
            else if (event.delta?.type === 'text_delta' && event.delta.text) {
              let chunk = carry + event.delta.text;
              carry = '';
              // Hold back a trailing partial that could be the start of "Kiro" across chunk boundaries.
              const partial = /[Kk][ir]{0,2}o?$/i.exec(chunk);
              if (partial && partial.index > -1 && partial[0].toLowerCase() !== 'kiro') { carry = chunk.slice(partial.index); chunk = chunk.slice(0, partial.index); }
              chunk = chunk.replace(/kiro/gi, 'Techword Code');
              if (chunk) { yield { text: chunk }; }
            }
            else if (event.delta?.type === 'input_json_delta') { const block = openBlocks.get(event.index ?? 0); if (block) { block.json += event.delta.partial_json ?? ''; } }
            break;
          case 'content_block_stop': {
            const block = openBlocks.get(event.index ?? 0);
            if (block) {
              let input: Record<string, unknown> = {};
              try { input = JSON.parse(block.json || '{}') as Record<string, unknown>; } catch { input = {}; }
              if (block.name) { toolCalls.push({ id: block.id, name: block.name, arguments: input }); }
              openBlocks.delete(event.index ?? 0);
            }
            const think = openThinks.get(event.index ?? 0);
            if (think) {
              // Keep the block for replay: Anthropic rejects a follow-up turn whose preceding thinking
              // block (the one before a tool_use) isn't sent back verbatim with its signature.
              if (think.kind === 'redacted_thinking') { thinkingBlocks.push({ type: 'redacted_thinking', data: think.data }); }
              else if (think.signature) { thinkingBlocks.push({ type: 'thinking', thinking: think.text, signature: think.signature }); }
              openThinks.delete(event.index ?? 0);
            }
            break;
          }
          case 'message_delta':
            if (typeof event.usage?.output_tokens === 'number') { outputTokens = event.usage.output_tokens; }
            if (typeof event.usage?.input_tokens === 'number') { inputTokens = event.usage.input_tokens; }
            if (event.delta?.stop_reason) { stopReason = event.delta.stop_reason; }
            yield { usage: { prompt: inputTokens, completion: outputTokens, total: inputTokens + outputTokens } };
            break;
          case 'error': {
            const msg = event.error?.message ?? 'unknown error';
            if (thinkOn && /thinking|budget_tokens|signature|reasoning/i.test(msg)) { throw new ThinkingUnsupportedError('Extended thinking is not available on this gateway — continuing without it.'); }
            throw new Error(`Techword API stream error: ${msg}`);
          }
          default:
            break;
        }
      }
    }
    if (carry) { yield { text: carry.replace(/kiro/gi, 'Techword Code') }; }
    // If the model produced tool calls, the effective stop reason is tool_use even when the
    // provider omitted it. A missing stop_reason with no output means the stream dropped.
    if (!stopReason && toolCalls.length > 0) { stopReason = 'tool_use'; }
    this.resetAttempts(); // the turn finished cleanly — the next outage starts counting from 1 again
    yield { toolCalls, thinkingBlocks, usage: { prompt: inputTokens, completion: outputTokens, total: inputTokens + outputTokens }, done: true, stopReason };
    } finally {
      // The turn is over (finished, threw, or the caller pressed Stop mid-stream). Drop the listener so it
      // can't fire against a later request that reuses this signal — { once } only covers the case where it
      // actually fired, and a clean finish or a thrown error leaves it attached.
      signal?.removeEventListener('abort', onUserAbort);
    }
  }

  /** Translate the internal (OpenAI-style) history into Anthropic system + messages. */
  private toAnthropic(messages: ChatMessage[]): { system: string; msgs: AnthropicMessage[] } {
    let system = '';
    for (const message of messages) {
      if (message.role === 'system' && typeof message.content === 'string') { system += (system ? '\n\n' : '') + message.content; }
    }
    const rest = messages.filter((message) => message.role !== 'system');
    const msgs: AnthropicMessage[] = [];
    for (let i = 0; i < rest.length; i += 1) {
      const message = rest[i];
      if (!message) { continue; }
      if (message.role === 'user') {
        msgs.push({ role: 'user', content: this.userContent(message.content) });
      } else if (message.role === 'assistant') {
        const parts: AnthropicPart[] = [];
        // Replay thinking FIRST, verbatim with signature — Anthropic requires the thinking block that
        // preceded a tool_use to come back unmodified, or it rejects the follow-up turn.
        for (const block of message.thinking_blocks ?? []) {
          if (block.type === 'thinking') { parts.push({ type: 'thinking', thinking: block.thinking, signature: block.signature }); }
          else { parts.push({ type: 'redacted_thinking', data: block.data }); }
        }
        const text = typeof message.content === 'string' ? message.content : '';
        if (text.trim()) { parts.push({ type: 'text', text }); }
        for (const call of message.tool_calls ?? []) {
          let input: unknown = {};
          try { input = JSON.parse(call.function.arguments || '{}'); } catch { input = {}; }
          parts.push({ type: 'tool_use', id: call.id, name: call.function.name, input });
        }
        msgs.push({ role: 'assistant', content: parts.length > 0 ? parts : [{ type: 'text', text: '(no output)' }] });
      } else if (message.role === 'tool') {
        // Merge consecutive tool results into one user message (Anthropic requires this).
        const results: AnthropicPart[] = [];
        while (i < rest.length && rest[i]?.role === 'tool') {
          const toolMessage = rest[i];
          if (toolMessage) { results.push({ type: 'tool_result', tool_use_id: toolMessage.tool_call_id ?? '', content: typeof toolMessage.content === 'string' ? toolMessage.content : '' }); }
          i += 1;
        }
        i -= 1;
        msgs.push({ role: 'user', content: results });
      }
    }
    return { system, msgs };
  }

  private userContent(content: string | ContentPart[]): string | AnthropicPart[] {
    if (typeof content === 'string') { return content; }
    const parts: AnthropicPart[] = [];
    for (const part of content) {
      if (part.type === 'text') { parts.push({ type: 'text', text: part.text }); }
      else if (part.type === 'image_url') {
        const match = /^data:([^;]+);base64,(.*)$/s.exec(part.image_url.url);
        if (match && match[1] && match[2]) { parts.push({ type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } }); }
      }
    }
    return parts.length > 0 ? parts : '';
  }

  // Fast-start backoff. Most gateway 5xx/524 are a one-off proxy hiccup that clears on the very next
  // try, so the first two retries fire almost instantly (250ms, 600ms) — the stream recovers before the
  // user notices, the way Claude Code feels. Only a real outage climbs to the slower waits, and it's
  // capped at 15s so an autonomous run never stalls longer than that between attempts.
  private static readonly BACKOFF_MS = [250, 600, 1500, 4000, 8000, 15000];

  /** Backoff with jitter; near-instant for the first retries, climbing for a sustained outage. Resolves early if the user stops. */
  private backoff(attempt: number, signal?: AbortSignal): Promise<void> {
    const schedule = OpenAICompatibleClient.BACKOFF_MS;
    const base = schedule[Math.min(attempt, schedule.length - 1)] ?? 15000;
    return this.sleep(base + Math.floor(Math.random() * 250), signal);
  }

  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
    });
  }

  private isChannelRejection(status: number, rawDetail: string): boolean {
    return isChannelRejection(status, rawDetail);
  }

  private endpoint(path: string): string {
    const base = OpenAICompatibleClient.normalizeBaseUrl(this.provider.baseUrl);
    return `${base.endsWith('/v1') ? base : `${base}/v1`}${path}`;
  }

  private headers(): Record<string, string> {
    return {
      'x-api-key': this.apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      Authorization: `Bearer ${this.apiKey}`,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      Accept: 'application/json'
    };
  }

  private requireModel(): string {
    if (!this.provider.selectedModel) {
      throw new Error('Select a model in Techword Code settings before starting a task.');
    }
    return this.provider.selectedModel;
  }

  private async failure(response: Response): Promise<Error> {
    return this.httpError(response.status, await response.text(), response.statusText);
  }

  private httpError(status: number, rawDetail: string, statusText = ''): Error {
    if (/<!doctype html|<html|cloudflare|attention required|just a moment/i.test(rawDetail)) {
      if (status === 403 || status === 503) {
        return new Error(`The API provider's firewall (Cloudflare) blocked this request. Ask your provider to allow the API path, or route requests through your own proxy (see proxy/README.md).`);
      }
      return new Error(`Techword API returned an unexpected page (HTTP ${status}). The provider may be temporarily unavailable.`);
    }
    const body = rawDetail.toLowerCase();
    // Out of tokens / quota / balance. TERMINAL — retrying can't make money appear.
    if (status === 402 || /insufficient|quota|balance|out of credit|no more credit|exceeded your current|欠费|余额|额度/.test(body)) {
      return new TechwordApiError('Your Techword tokens are used up. Top up your balance to keep coding, or contact your provider.', true);
    }
    // Invalid or expired key. TERMINAL — a dead key never revives on retry.
    if (status === 401 || /invalid api key|invalid key|api key.*(invalid|expired)|token.*(invalid|expired)|unauthorized|no permission|令牌|无效/.test(body)) {
      return new TechwordApiError('Your Techword API key is invalid or has expired. Open Settings and enter a valid key, or contact your provider to renew it.', true);
    }
    // Rate limited. Transient — wait and retry.
    if (status === 429 || /rate limit|too many requests|请求过于频繁/.test(body)) {
      return new TechwordApiError('Too many requests right now (rate limit). Waiting, then retrying…', false);
    }
    // Channel-routing rejection that survived all re-rolls: this model is served only by channels
    // your key can't use. Give a clean, white-label message — never leak the raw channel names. TERMINAL.
    if (/not allowed to use channel|无权使用渠道|channel.*not allowed/i.test(body)) {
      return new TechwordApiError('This model kept routing to a server your Techword key isn\'t enabled for. Pick another model in Settings, or ask your provider to enable this one for your key.', true);
    }
    // Model not available on this plan. TERMINAL.
    if (/no available channel|model_not_found|无可用|not allowed to access model|does not exist or you do not have access/.test(body)) {
      return new TechwordApiError('That model is not available on your Techword plan. Pick another model in Settings, or contact your provider to enable it.', true);
    }
    const detail = rawDetail.slice(0, 400).replace(/(Bearer\s+)[^\s]+/gi, '$1[REDACTED]').replace(/(sk-)[a-z0-9]+/gi, '$1[REDACTED]');
    // Other 4xx (bad request, etc.) are terminal; unknown 5xx are transient and worth a retry.
    return new TechwordApiError(`Techword API request failed (${status}): ${detail || statusText}`, status >= 400 && status < 500 && status !== 408);
  }

  // Network-layer failures are non-terminal: the connection may be back a moment later, so the agent
  // loop keeps reconnecting. Only a dead key or exhausted tokens (tagged terminal in httpError) stop it.
  private describeNetworkError(error: unknown): Error {
    if (error instanceof Error && (error.name === 'TimeoutError' || /timeout/i.test(error.message))) {
      return new TechwordApiError('Techword API did not respond in time.', false);
    }
    if (error instanceof Error && (error.message === 'fetch failed' || error.name === 'TypeError')) {
      const cause = (error as { cause?: unknown }).cause;
      const detail = cause && typeof cause === 'object' ? String((cause as { code?: unknown; message?: unknown }).code ?? (cause as { message?: unknown }).message ?? '') : '';
      return new TechwordApiError(`Could not reach Techword API${detail ? ` (${detail})` : ''}. Checking your connection…`, false);
    }
    return error instanceof Error ? error : new Error(String(error));
  }
}

// A load-balancing rejection: the key is VALID but this request was routed to a channel the key
// isn't cleared for (gateway 403). Worth an instant re-roll onto a different channel. Kept distinct
// from "model not available on your plan" (NO available channel at all), which the user must act on,
// and from a real auth failure (invalid/expired key), which must reach the user unretried.
export function isChannelRejection(status: number, rawDetail: string): boolean {
  if (status !== 403) { return false; }
  return /not allowed to use channel|无权使用渠道|无可用渠道分组|channel.*not allowed/i.test(rawDetail);
}
