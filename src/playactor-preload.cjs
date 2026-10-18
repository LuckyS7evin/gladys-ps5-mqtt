// Preloaded into every `playactor` child process (NODE_OPTIONS --require, see
// ./playactor.js). playactor takes over the keep-alive socket of its sess/ctrl
// request as the Remote Play control channel; Node >= 22.23 destroys a pooled
// keep-alive socket as soon as unsolicited data arrives on it, so `standby`
// silently died on the console's first reply. Never pool sockets in this
// process. Same shim as ps5-mqtt (MIT), see
// https://github.com/FunkeyFlo/ps5-mqtt/issues/678
const http = require('node:http');

const OriginalAgent = http.Agent;

http.Agent = class extends OriginalAgent {
  constructor(options) {
    super(options);
    this.removeAllListeners('free');
    this.on('free', () => {});
  }
};
