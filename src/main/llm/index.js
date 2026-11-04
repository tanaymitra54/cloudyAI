'use strict';

const deepseek = require('./deepseek');
const opencodego = require('./opencodego');
const commandcodeapi = require('./commandcodeapi');
const cli = require('./cli');
const config = require('../config');

// Single entry point for every backend. Cancels any in-flight request before
// starting a new one, because a stale answer in a live call is worse than none.
class AnswerEngine {
  constructor({ onDelta, onDone, onError }) {
    this.onDelta = onDelta;
    this.onDone = onDone;
    this.onError = onError;
    this.controller = null;
    this.seq = 0;
  }

  cancel() {
    this.controller?.abort();
    this.controller = null;
  }

  get busy() {
    return this.controller !== null;
  }

  /**
   * Pay the connection setup before the first real question: DNS, TLS, and the
   * provider's session routing all happen here instead of inside a live answer.
   */
  warm() {
    const cfg = config.load();
    const noop = () => {};
    const run =
      cfg.provider === 'opencode-go'
        ? () => opencodego.complete({ cfg: cfg.opencodeGo, system: 'Reply with one word.', user: 'hi', onDelta: noop, maxTokens: 1 })
        : cfg.provider === 'commandcode-api'
          ? () => commandcodeapi.complete({ cfg: cfg.commandCodeApi, system: 'Reply with one word.', user: 'hi', onDelta: noop, maxTokens: 1 })
          : cfg.provider === 'deepseek'
            ? () => deepseek.complete({ cfg: cfg.deepseek, system: 'Reply with one word.', user: 'hi', onDelta: noop, maxTokens: 1 })
            : null;
    if (!run) return;
    run().catch(() => {});
  }

  callProvider(provider, modelOverride, { system, user, images, signal, onDelta }) {
    const cfg = config.load();
    if (provider === 'deepseek') {
      const section = modelOverride ? { ...cfg.deepseek, model: modelOverride } : cfg.deepseek;
      return deepseek.complete({ cfg: section, system, user, images, signal, onDelta });
    }
    if (provider === 'opencode-go') {
      const section = modelOverride ? { ...cfg.opencodeGo, model: modelOverride } : cfg.opencodeGo;
      return opencodego.complete({ cfg: section, system, user, images, signal, onDelta });
    }
    if (provider === 'commandcode-api') {
      const section = modelOverride ? { ...cfg.commandCodeApi, model: modelOverride } : cfg.commandCodeApi;
      return commandcodeapi.complete({ cfg: section, system, user, images, signal, onDelta });
    }
    if (images?.length) {
      return Promise.reject(
        new Error('Screenshots need a vision provider.\nSwitch to opencode-go, commandcode-api, or deepseek in Settings and try again.')
      );
    }
    return cli.complete({ provider, cfg: cfg[provider] || {}, system, user, signal, onDelta });
  }

  async ask({ system, user, images = null }) {
    const cfg = config.load();
    const seq = this.seq + 1;
    this.cancel();
    this.seq = seq;

    const main = new AbortController();
    this.controller = main;

    const attempts = [];
    let winner = null; // which attempt produced the first visible token

    const attempt = (provider, modelOverride) => {
      const own = new AbortController();
      attempts.push(own);
      const signal = AbortSignal.any ? AbortSignal.any([main.signal, own.signal]) : main.signal;

      const onDelta = (delta) => {
        if (seq !== this.seq) return;
        if (!winner) {
          winner = own;
          // First token wins: drop the slower request instead of paying for both.
          for (const other of attempts) if (other !== own) other.abort();
        }
        if (winner === own) this.onDelta?.(delta);
      };

      return this.callProvider(provider, modelOverride, { system, user, images, signal, onDelta })
        .then((r) => ({ own, text: r.text }))
        .catch((err) => ({ own, error: err }));
    };

    const hedge = cfg.hedge || {};
    const useHedge =
      hedge.enabled && (cfg.provider === 'opencode-go' || cfg.provider === 'commandcode-api' || cfg.provider === 'deepseek');

    const jobs = [attempt(cfg.provider, null)];
    if (useHedge) {
      // Only fire the backup if the primary is slow to start, so the common case
      // costs one request rather than two.
      jobs.push(
        new Promise((resolve) => {
          setTimeout(() => {
            if (winner || seq !== this.seq) return resolve({ skipped: true });
            resolve(attempt(cfg.provider, hedge.model));
          }, hedge.delayMs ?? 700);
        })
      );
    }

    const results = await Promise.all(jobs);
    if (seq !== this.seq) return '';

    const picked =
      (winner && results.find((r) => r.own === winner && !r.error)) ||
      results.find((r) => !r.error && !r.skipped) ||
      null;

    this.controller = null;

    if (!picked) {
      const failure = results.find((r) => r.error);
      const message = failure?.error?.name === 'AbortError' ? '' : failure?.error?.message || 'No provider responded';
      if (message && seq === this.seq) this.onError?.(message);
      return '';
    }

    if (seq === this.seq) this.onDone?.(picked.text);
    return picked.text;
  }
}

module.exports = { AnswerEngine };
