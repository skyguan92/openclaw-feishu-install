/**
 * Mock Gateway that establishes a real Feishu WebSocket long connection.
 *
 * - Listens on HTTP :18789 for health checks (simulates OpenClaw gateway)
 * - Calls POST /callback/ws/endpoint with AppID + AppSecret to get WebSocket URL
 * - Connects via WebSocket and maintains ping/pong heartbeat using pbbp2 protobuf
 */

const http = require('http');
const https = require('https');
const WebSocket = require('ws');
const protobuf = require('protobufjs');

const HEALTH_PORT = 18789;
const FEISHU_DOMAIN = 'https://open.feishu.cn';

// ── Protobuf schema (pbbp2) ────────────────────────────────────────────
// Inline definition matching Feishu's pbbp2.proto
const root = protobuf.Root.fromJSON({
  nested: {
    pbbp2: {
      nested: {
        Header: {
          fields: {
            key: { type: 'string', id: 1, rule: 'required' },
            value: { type: 'string', id: 2, rule: 'required' },
          },
        },
        Frame: {
          fields: {
            SeqID: { type: 'uint64', id: 1, rule: 'required' },
            LogID: { type: 'uint64', id: 2, rule: 'required' },
            service: { type: 'int32', id: 3, rule: 'required' },
            method: { type: 'int32', id: 4, rule: 'required' },
            headers: { type: 'pbbp2.Header', id: 5, rule: 'repeated' },
            payloadEncoding: { type: 'string', id: 6 },
            payloadType: { type: 'string', id: 7 },
            payload: { type: 'bytes', id: 8 },
            LogIDNew: { type: 'string', id: 9 },
          },
        },
      },
    },
  },
});

const Frame = root.lookupType('pbbp2.Frame');
const FRAME_TYPE = { control: 0, data: 1 };
const MSG_TYPE = { ping: 'ping', pong: 'pong', event: 'event' };

// ── Core mock gateway ──────────────────────────────────────────────────

class MockGateway {
  constructor(bus) {
    this.bus = bus;
    this.httpServer = null;
    this.wsConnection = null;
    this.pingTimer = null;
    this.serviceId = 0;
    this.connected = false;
  }

  log(msg) {
    if (this.bus) {
      this.bus.sendLog(`[MockGateway] ${msg}`);
    } else {
      console.log(`[MockGateway] ${msg}`);
    }
  }

  // Start HTTP health check server
  async startHealthServer() {
    return new Promise((resolve, reject) => {
      this.httpServer = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: 'ok',
          mock: true,
          wsConnected: this.connected,
        }));
      });

      this.httpServer.listen(HEALTH_PORT, '127.0.0.1', () => {
        this.log(`Health server listening on http://127.0.0.1:${HEALTH_PORT}`);
        resolve();
      });

      this.httpServer.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          this.log(`Port ${HEALTH_PORT} already in use, assuming gateway is running`);
          resolve(); // not fatal
        } else {
          reject(err);
        }
      });
    });
  }

  // Call Feishu endpoint API to get WebSocket URL
  async pullConnectConfig(appId, appSecret) {
    this.log('Requesting WebSocket endpoint from Feishu...');

    return new Promise((resolve, reject) => {
      const postData = JSON.stringify({ AppID: appId, AppSecret: appSecret });

      const url = new URL('/callback/ws/endpoint', FEISHU_DOMAIN);
      const options = {
        hostname: url.hostname,
        port: 443,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData),
          locale: 'zh',
        },
        timeout: 15000,
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          try {
            const result = JSON.parse(data);
            this.log(`Endpoint response code: ${result.code}`);

            if (result.code !== 0) {
              reject(new Error(`Feishu endpoint error: code=${result.code}, msg=${result.msg}`));
              return;
            }

            const wsUrl = result.data.URL;
            const clientConfig = result.data.ClientConfig;

            // Parse device_id and service_id from URL query
            const parsed = new URL(wsUrl);
            this.serviceId = parseInt(parsed.searchParams.get('service_id') || '0', 10);

            this.log(`WebSocket URL obtained: ${wsUrl.substring(0, 60)}...`);
            this.log(`PingInterval: ${clientConfig.PingInterval}s, ReconnectCount: ${clientConfig.ReconnectCount}`);

            resolve({
              wsUrl,
              pingInterval: (clientConfig.PingInterval || 120) * 1000,
              reconnectCount: clientConfig.ReconnectCount,
              reconnectInterval: (clientConfig.ReconnectInterval || 120) * 1000,
            });
          } catch (e) {
            reject(new Error(`Failed to parse endpoint response: ${e.message}`));
          }
        });
      });

      req.on('error', (e) => reject(new Error(`Endpoint request failed: ${e.message}`)));
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Endpoint request timed out'));
      });

      req.write(postData);
      req.end();
    });
  }

  // Connect WebSocket and maintain heartbeat
  async connectWebSocket(wsUrl, pingInterval) {
    this.log('Connecting WebSocket...');

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);

      ws.on('open', () => {
        this.log('WebSocket connected!');
        this.wsConnection = ws;
        this.connected = true;

        // Start ping loop
        this.startPingLoop(pingInterval);

        resolve(true);
      });

      ws.on('message', (buffer) => {
        try {
          const frame = Frame.decode(new Uint8Array(buffer));
          const typeHeader = (frame.headers || []).find(h => h.key === 'type');
          const type = typeHeader ? typeHeader.value : 'unknown';

          if (frame.method === FRAME_TYPE.control) {
            if (type === MSG_TYPE.pong) {
              this.log('Received pong');
              // Update config from pong payload if present
              if (frame.payload && frame.payload.length > 0) {
                try {
                  const pongData = JSON.parse(new TextDecoder().decode(frame.payload));
                  this.log(`Pong config: PingInterval=${pongData.PingInterval}s`);
                } catch {}
              }
            }
          } else if (frame.method === FRAME_TYPE.data) {
            this.log(`Received event: type=${type}, message_id=${
              (frame.headers || []).find(h => h.key === 'message_id')?.value || 'n/a'
            }`);

            // ACK the event
            const ackPayload = JSON.stringify({ code: 200 });
            const ackFrame = Frame.create({
              ...frame,
              payload: new TextEncoder().encode(ackPayload),
            });
            const encoded = Frame.encode(ackFrame).finish();
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(encoded);
              this.log('Event ACKed');
            }
          }
        } catch (e) {
          this.log(`Failed to decode message: ${e.message}`);
        }
      });

      ws.on('error', (e) => {
        this.log(`WebSocket error: ${e.message}`);
        this.connected = false;
        reject(e);
      });

      ws.on('close', (code, reason) => {
        this.log(`WebSocket closed: code=${code}`);
        this.connected = false;
        if (this.pingTimer) {
          clearInterval(this.pingTimer);
          this.pingTimer = null;
        }
      });

      // Timeout for connection
      setTimeout(() => {
        if (!this.connected) {
          ws.terminate();
          reject(new Error('WebSocket connection timed out'));
        }
      }, 15000);
    });
  }

  startPingLoop(interval) {
    if (this.pingTimer) clearInterval(this.pingTimer);

    this.pingTimer = setInterval(() => {
      if (!this.wsConnection || this.wsConnection.readyState !== WebSocket.OPEN) {
        this.log('WebSocket not open, stopping ping');
        clearInterval(this.pingTimer);
        return;
      }

      const pingFrame = Frame.create({
        SeqID: 0,
        LogID: 0,
        service: this.serviceId,
        method: FRAME_TYPE.control,
        headers: [{ key: 'type', value: MSG_TYPE.ping }],
      });

      const encoded = Frame.encode(pingFrame).finish();
      this.wsConnection.send(encoded);
      this.log('Ping sent');
    }, interval);
  }

  // Full start: health server + Feishu WebSocket connection
  async start(appId, appSecret) {
    await this.startHealthServer();

    const config = await this.pullConnectConfig(appId, appSecret);
    await this.connectWebSocket(config.wsUrl, config.pingInterval);

    this.log('Mock Gateway fully started and connected to Feishu');
  }

  async stop() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.wsConnection) {
      this.wsConnection.close();
      this.wsConnection = null;
    }
    if (this.httpServer) {
      return new Promise(resolve => this.httpServer.close(resolve));
    }
    this.connected = false;
  }
}

module.exports = { MockGateway };
