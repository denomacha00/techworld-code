import { type ChatMessage, type ContentPart, type ModelInfo, type ProviderConfig, type StreamDelta, type ThinkingBlock, type ToolCall } from '../types';
import { type BillingUsd, parseBillingUsd } from './billing';

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
// A model can read as "unavailable" for a beat and then come back: the provider sometimes toggles a model
// off (channel drained, plan-sync lag) and restores it on its own — the user watched a model that WAS on
// their plan get rejected, then work again moments later. So "model not available" is NOT taken as final on
// the first hit — it's re-checked this many times (short, growing waits between) before we surface the
// terminal "pick another model" error. Own budget, like CHANNEL_RETRIES, so it never eats the network one.
const MODEL_UNAVAIL_RETRIES = 6; // per the user: retry the model at least 5× before declaring it gone
const STREAM_IDLE_MS = 60000; // if no stream data arrives for this long, surface an error instead of hanging
// Time-to-first-byte watchdog. This upstream withholds response headers until the model starts generating,
// and channels are BIMODAL (measured): a healthy channel delivers the first byte in ~4-35s, a dead one
// never delivers — it hangs until the proxy's ~100-126s origin timeout, then returns 500/524. Re-rolling
// onto a fresh channel is exactly what a manual retry did, but automatic. Crucially we NEVER stop capping:
// a dead channel does not recover if you "wait it out", so every attempt is capped and re-rolled. What's
// bounded instead is the NUMBER of re-rolls — after this many stuck channels in a row we fail cleanly with
// a "servers busy" message instead of hanging 120s per attempt forever (the retry storm the user hit).
const MAX_TTFB_REROLLS = 5;  // stuck channels to escape before giving up cleanly (≈ 45s + 5×20s ceiling)
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

/** A "model not available / no channel for it" response. Often TRANSIENT — the provider drops a model for
 *  a moment (channel drained, plan-sync lag) and restores it — so the request loop re-checks it a few times
 *  before treating it as final. Kept distinct from isChannelRejection (a 403 the key can re-roll past): this
 *  is "no channel can serve this model right now", which we wait out briefly rather than instantly re-roll. */
export function isModelUnavailable(rawDetail: string): boolean {
  return /no available channel|model_not_found|无可用|not allowed to access model|does not exist or you do not have access/i.test(rawDetail);
}

/** A prompt-cache breakpoint. Anthropic caches the whole prefix up to a block tagged with this and
 *  reuses it on the next request within the 5-minute TTL — a cache READ is ~10× cheaper and lands the
 *  first byte far sooner than reprocessing the tools + system + history from scratch every turn. */
type CacheControl = { type: 'ephemeral' };

/** Turn the plain system string into a single cacheable text block. The system prompt + memory + repo
 *  rules are the largest stable chunk of every request, so caching them is the biggest single speed win. */
export function withSystemCacheBreakpoint(system: string): Array<{ type: 'text'; text: string; cache_control: CacheControl }> {
  return [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
}

/** Tag the LAST tool definition so the entire (frozen) tool array caches. Clones — never mutates the
 *  shared TOOLS constant, or the cache_control would leak into every future request and other clients. */
export function withToolsCacheBreakpoint(tools: unknown[]): unknown[] {
  if (tools.length === 0) { return tools; }
  const out = tools.slice();
  const last = out[out.length - 1];
  if (last && typeof last === 'object') {
    out[out.length - 1] = { ...(last as Record<string, unknown>), cache_control: { type: 'ephemeral' } };
  }
  return out;
}

/** Tag the last block of the last message so the growing conversation (file reads, tool output) caches
 *  incrementally: each turn writes the new tail and the next turn reads the whole prior prefix cheaply.
 *  Clones the touched message/parts so the caller's history array is never mutated. */
export function withMessageCacheBreakpoint<T extends { role: string; content: unknown }>(messages: T[]): T[] {
  if (messages.length === 0) { return messages; }
  const out = messages.slice();
  const i = out.length - 1;
  const last = out[i];
  if (!last) { return out; }
  if (typeof last.content === 'string') {
    if (!last.content) { return out; } // an empty string block can't carry cache_control
    out[i] = { ...last, content: [{ type: 'text', text: last.content, cache_control: { type: 'ephemeral' } }] };
  } else if (Array.isArray(last.content) && last.content.length > 0) {
    const parts = (last.content as Array<Record<string, unknown>>).map((part) => ({ ...part }));
    (parts[parts.length - 1] as Record<string, unknown>).cache_control = { type: 'ephemeral' };
    out[i] = { ...last, content: parts };
  }
  return out;
}

/** Detect a gateway rejection about cache_control, so we can drop caching and retry on the plain path —
 *  a stricter or older gateway degrades to no-cache instead of hard-failing the task on a 400/422. */
export function isCacheRejection(status: number, rawDetail: string): boolean {
  if (status !== 400 && status !== 422) { return false; }
  return /cache_control|cache control|prompt.?cach|ephemeral|cache_creation/i.test(rawDetail);
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

/** How long to wait for the first byte before re-rolling a stuck channel, in ms — PROGRESSIVE, not flat,
 *  and ALWAYS armed (thinking on OR off). A stuck channel never recovers by waiting, so every attempt gets a
 *  finite deadline and re-rolls onto a fresh channel; leaving Brain-on runs uncapped is exactly what let a
 *  dead channel hang to the proxy's ~120s timeout and storm retries (what the user saw as "stacking"). The
 *  re-roll COUNT is bounded separately (MAX_TTFB_REROLLS), not by removing the cap.
 *
 *  Thinking OFF: the first probe (ttfbRerolls === 0) is almost always a real cold start — the first request
 *  of a run, or the first after the 5-minute prompt-cache TTL lapses, reprocesses the whole system+tools+
 *  history from scratch, which legitimately takes 20-35s to first byte. So it waits 45s (long enough that a
 *  cold-but-healthy channel delivers even on a full 120k context, short enough to still escape a dead channel
 *  before the proxy's ~100-126s 500/524). Once a channel has proven stuck, re-rolls hunt at 20s each — healthy
 *  channels answer in ~4-35s (measured). Worst case: 45 + 5×20 = 145s in capped chunks, then a clean "busy".
 *
 *  Thinking ON: a long first byte is EXPECTED (the model reasons before it emits), so the deadline is far
 *  more generous — but still FINITE and below the proxy timeout, so a genuinely dead channel with Brain on
 *  re-rolls instead of hanging. First probe 90s, re-rolls 60s (both < 120s; worst case 90 + 5×60 = 390s). */
export function firstByteCapMs(ttfbRerolls: number, thinkingEnabled: boolean): number {
  if (thinkingEnabled) { return ttfbRerolls === 0 ? 90000 : 60000; }
  return ttfbRerolls === 0 ? 45000 : 20000;
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

type AnthropicPart = ({ type: 'text'; text: string } | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } } | { type: 'tool_use'; id: string; name: string; input: unknown } | { type: 'tool_result'; tool_use_id: string; content: string } | { type: 'thinking'; thinking: string; signature: string } | { type: 'redacted_thinking'; data: string }) & { cache_control?: { type: 'ephemeral' } };
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
  // Prompt caching. On by default: tags the tools + system + last message with cache_control so the
  // gateway reuses the prefix on the next turn (a cache read is ~10× cheaper and much faster to first
  // byte than reprocessing everything). Flips off for the rest of this client's life only if a gateway
  // proves it rejects cache_control, so an older/stricter server degrades to the plain path instead of
  // hard-failing the task. Prompt caching is GA on the Messages API — no beta header needed.
  private sendCacheControl = true;
  // One continuous retry counter across the whole outage, so the user sees a number that climbs
  // (attempt 1, 2, 3…) proving it's actively retrying — not a "1/6" that resets and looks stuck.
  // Only a fully-completed turn resets it; a fresh connection mid-outage does not.
  private attemptSeq = 0;

  constructor(private readonly provider: ProviderConfig, private readonly apiKey: string, private readonly options: GenerationOptions = {}) {
    this.thinkingOn = options.thinking === true;
  }

  /** Turn extended thinking off for this client after a gateway rejection. */
  disableThinking(): void { this.thinkingOn = false; }
  /** Flip extended thinking on/off mid-life — wired to the Brain toggle via AgentSession.activeClient so a
   *  run already streaming starts (or stops) emitting reasoning on its NEXT turn without a client rebuild.
   *  streamCompletion reads this.thinkingOn fresh each call, so the change lands on the following turn. */
  setThinking(on: boolean): void { this.thinkingOn = on; }
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

  /** Read this key's REAL spend from the gateway's billing meter (dollars deducted so far) and its cap.
   *  This is the exact number the provider charges — it already includes the input/output price
   *  difference and any hedge overhead — so it's shown in place of the token-based estimate. Best-effort:
   *  returns undefined on any failure (older gateway, network blip) so the counter simply falls back to
   *  the estimate and a run is never affected. `meterInCents` divides total_usage by 100 (OpenAI
   *  convention); the caller passes the user's setting. */
  async fetchBillingUsd(meterInCents: boolean, signal?: AbortSignal): Promise<BillingUsd | undefined> {
    try {
      const sig = signal ?? AbortSignal.timeout(15000);
      const [usageRes, subRes] = await Promise.all([
        fetch(this.endpoint('/dashboard/billing/usage'), { headers: this.headers(), signal: sig }),
        fetch(this.endpoint('/dashboard/billing/subscription'), { headers: this.headers(), signal: sig }),
      ]);
      if (!usageRes.ok) { return undefined; }
      const usage = await usageRes.json() as { total_usage?: unknown };
      if (typeof usage.total_usage !== 'number') { return undefined; }
      let hardLimitUsd: number | undefined;
      if (subRes.ok) {
        const sub = await subRes.json() as { hard_limit_usd?: unknown };
        if (typeof sub.hard_limit_usd === 'number') { hardLimitUsd = sub.hard_limit_usd; }
      }
      return parseBillingUsd({ totalUsage: usage.total_usage, hardLimitUsd }, meterInCents);
    } catch { return undefined; }
  }

  async *streamCompletion(messages: ChatMessage[], tools: unknown[], signal?: AbortSignal): AsyncGenerator<StreamDelta> {
    const { system, msgs } = this.toAnthropic(messages);
    const maxTokens = this.options.maxTokens && this.options.maxTokens > 0 ? this.options.maxTokens : MAX_TOKENS;
    const hasTools = Array.isArray(tools) && tools.length > 0;
    // thinkOn selects the first-byte cap VALUE (longer when reasoning is on). Computed once per call = per
    // turn; the Brain toggle mutates this.thinkingOn live (setThinking), so a mid-run flip lands on the NEXT
    // turn's streamCompletion — no client rebuild needed.
    const thinkOn = thinkingParams({ thinkingOn: this.thinkingOn, maxTokens, sendDisabledThinking: this.sendDisabledThinking, thinkingBudget: this.options.thinkingBudget, temperature: this.options.temperature }).thinking?.type === 'enabled';
    // Rebuildable so the graceful-degrade paths below (thinking rejected, cache_control rejected) can
    // reconstruct the exact request after flipping a flag, instead of hand-patching the body object.
    // thinkingParams is recomputed each build so a flipped sendDisabledThinking drops {type:'disabled'}.
    const buildBody = (): Record<string, unknown> => {
      const b: Record<string, unknown> = { model: this.requireModel(), max_tokens: maxTokens, stream: true };
      // Reasoning/creativity fields. CRITICAL for speed: the default (thinking off) sends {type:'disabled'},
      // which is ≈10× faster to first byte than omitting the param — see thinkingParams.
      const think = thinkingParams({ thinkingOn: this.thinkingOn, maxTokens, sendDisabledThinking: this.sendDisabledThinking, thinkingBudget: this.options.thinkingBudget, temperature: this.options.temperature });
      if (think.thinking) { b.thinking = think.thinking; }
      if (typeof think.temperature === 'number') { b.temperature = think.temperature; }
      // Cache breakpoints go on the LARGEST STABLE prefix first (tools, then system), and last on the
      // message tail so the growing history caches incrementally. Applied only when caching is on.
      b.messages = this.sendCacheControl ? withMessageCacheBreakpoint(msgs) : msgs;
      if (system) { b.system = this.sendCacheControl ? withSystemCacheBreakpoint(system) : system; }
      if (hasTools) { b.tools = this.sendCacheControl ? withToolsCacheBreakpoint(tools) : tools; b.tool_choice = { type: 'auto' }; }
      return b;
    };
    let body = buildBody();

    // Persist through transient failures: retry network errors and 429/5xx with backoff.
    // Do NOT retry auth/quota/bad-request errors — those need the user to act.
    const RETRY_STATUS = new Set([408, 429, 500, 502, 503, 504, 520, 522, 523, 524]);
    let response: Response | undefined;
    let channelRetries = 0;
    let modelRetries = 0;
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
      let ttfbFired = false;
      let ttfbTimer: ReturnType<typeof setTimeout> | undefined;
      // ALWAYS arm a first-byte deadline (thinking on OR off) — a stuck channel never recovers by waiting,
      // and leaving Brain-on runs uncapped is what let a dead channel hang to the proxy's ~120s timeout and
      // storm retries. The cap VALUE is longer when thinking is on (the model legitimately reasons first).
      { const c = activeController; ttfbTimer = setTimeout(() => { ttfbFired = true; c.abort(); }, firstByteCapMs(ttfbRerolls, thinkOn)); }
      try {
        // Accept: text/event-stream tells the gateway (and every proxy hop) this is an SSE request, so
        // it flushes each event as it arrives instead of buffering the whole reply — the same header the
        // Anthropic SDK / Claude Code send. Buffering upstream is a common cause of a slow-to-start stream
        // that then trips a proxy idle-timeout (524) — exactly the retries the user was seeing.
        response = await fetch(this.endpoint('/messages'), { method: 'POST', headers: { ...this.headers(), 'content-type': 'application/json', Accept: 'text/event-stream' }, signal: activeController.signal, body: JSON.stringify(body) });
      } catch (error) {
        if (signal?.aborted) { throw new Error('Stopped.'); }
        // Headers didn't arrive before the cap: this channel is stuck (it would hang to the proxy's ~120s
        // timeout and 500/524). Re-roll onto a fresh one — exactly what a manual retry did, but automatic.
        // Don't spend the network-error budget on it. Bounded by MAX_TTFB_REROLLS: after that many stuck
        // channels in a row the upstream is genuinely out, so fail cleanly instead of hanging forever.
        if (ttfbFired) {
          ttfbRerolls += 1;
          if (ttfbRerolls > MAX_TTFB_REROLLS) {
            throw new TechwordApiError('The Techword servers are busy right now — every channel timed out. Please try again in a moment.', false);
          }
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
          body = buildBody();
          yield { status: 'Adjusting request for this server…' };
          attempt -= 1; // a one-time config re-roll, not a network failure — don't spend the retry budget
          await this.sleep(200, signal);
          continue;
        }
      }
      // The gateway rejected cache_control (older/stricter server). Drop prompt caching for the rest of
      // this client's life and retry on the plain path — degrade quietly instead of failing the task.
      if (isCacheRejection(response.status, detail) && this.sendCacheControl) {
        this.sendCacheControl = false;
        body = buildBody();
        yield { status: 'Adjusting request for this server…' };
        attempt -= 1; // a one-time config re-roll, not a network failure — don't spend the retry budget
        await this.sleep(200, signal);
        continue;
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
      // "Model not available" is often a transient provider flap (a model toggled off for a beat, then
      // back). Don't take the first one as final: re-check on its own budget with short, growing waits so a
      // model that was genuinely on the plan isn't abandoned over a momentary blip. Only after
      // MODEL_UNAVAIL_RETRIES misses do we fall through to httpError() and tell the user to pick another.
      if (isModelUnavailable(detail) && modelRetries < MODEL_UNAVAIL_RETRIES && !signal?.aborted) {
        modelRetries += 1;
        yield { status: `Model didn't answer — retrying (${modelRetries}/${MODEL_UNAVAIL_RETRIES})…` };
        attempt -= 1; // a provider flap, not a network failure — don't spend the network-error budget
        await this.sleep(Math.min(1200 * modelRetries, 4000), signal);
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
      if (signal?.aborted) { resolve(); return; }
      // Remove the abort listener when the timer wins too — { once } only auto-removes it when it FIRES,
      // so without this the listeners pile up on the shared signal across many backoffs in one run.
      const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
      const onAbort = (): void => { clearTimeout(timer); resolve(); };
      signal?.addEventListener('abort', onAbort, { once: true });
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
    // Model not available on this plan — and it survived the transient re-checks in the request loop
    // (isModelUnavailable / MODEL_UNAVAIL_RETRIES), so it's genuinely gone, not a momentary flap. TERMINAL.
    if (isModelUnavailable(rawDetail)) {
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
