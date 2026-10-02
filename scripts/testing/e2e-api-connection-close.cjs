// Loaded only by the isolated Playwright CLI/worker processes. Browser traffic
// must retain Chromium's normal socket reuse; this policy is for Node API calls.
/* global require, module, process, URL */
// eslint-disable-next-line @typescript-eslint/no-require-imports -- Node preload must run before the Playwright CLI.
const http = require('node:http');
// eslint-disable-next-line @typescript-eslint/no-require-imports -- Native overload normalization for the scoped preload.
const { urlToHttpOptions } = require('node:url');

function installApiConnectionClose(port, transport = http) {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error('INVALID_ISOLATED_E2E_API_PORT');
  }
  const original = transport.request;
  function scopedRequest(...args) {
    const input = args[0];
    let options;
    try {
      if (input instanceof URL || typeof input === 'string') {
        options = { ...urlToHttpOptions(new URL(input)),
          ...(args[1] && typeof args[1] === 'object' ? args[1] : {}) };
      } else if (input && typeof input === 'object') options = input;
    } catch { /* Non-URL overloads remain unmodified. */ }
    const outgoing = original.apply(this, args);
    if ((options?.protocol || 'http:') === 'http:'
        && ['127.0.0.1', 'localhost'].includes(String(options?.hostname || options?.host || '').toLowerCase())
        && Number(options?.port || 80) === port && String(options?.path || '').startsWith('/api/')) {
      outgoing.setHeader('Connection', 'close');
    }
    return outgoing;
  }
  transport.request = scopedRequest;
  return () => { if (transport.request === scopedRequest) transport.request = original; };
}

module.exports = { installApiConnectionClose };
if (process.env.VERIDIA_E2E_API_CONNECTION_CLOSE_PORT) {
  installApiConnectionClose(Number(process.env.VERIDIA_E2E_API_CONNECTION_CLOSE_PORT));
}
