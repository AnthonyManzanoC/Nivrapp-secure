'use strict';

// LiveKit 2.19.1 contains an unconditional data-channel plaintext diagnostic in its worker.
// Suppress all worker console output before loading the unmodified cryptographic implementation.
// Errors are still delivered through Worker error events and the SDK's structured error messages.
for (const method of ['log', 'debug', 'info', 'warn', 'error', 'trace', 'table', 'dir']) {
  console[method] = () => {};
}
importScripts('./livekit-client.e2ee.worker.js');
