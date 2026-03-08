const { EventEmitter } = require('events');

class SSEBus extends EventEmitter {
  constructor() {
    super();
    this.clients = new Set();
  }

  addClient(res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('\n');
    this.clients.add(res);

    res.on('close', () => {
      this.clients.delete(res);
    });
  }

  broadcast(event, data) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of this.clients) {
      client.write(payload);
    }
  }

  sendPhase(phase, status, message, extra = {}) {
    this.broadcast('phase', { phase, status, message, ...extra });
  }

  sendLog(message) {
    this.broadcast('log', { message, ts: Date.now() });
  }

  sendError(phase, message) {
    this.broadcast('error', { phase, message, ts: Date.now() });
  }

  sendDone(success, message) {
    this.broadcast('done', { success, message, ts: Date.now() });
  }
}

module.exports = { SSEBus };
