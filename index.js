const express = require('express');
const WebSocket = require('ws');
const dgram = require('dgram');
const nacl = require('tweetnacl');

const TOKEN = process.env.DISCORD_TOKEN || '';
const GUILD_ID = process.env.GUILD_ID || '';
const CHANNEL_ID = process.env.CHANNEL_ID || '';
const PORT = process.env.PORT || 8080;

const GATEWAY_URL = 'wss://gateway.discord.gg/?v=10&encoding=json';
const VOICE_GATEWAY_VERSION = 4;
const FRAME_SIZE_AUDIO = 960;
const SILENCE_FRAME = Buffer.from([0xf8, 0xff, 0xfe]);
const SILENCE_INTERVAL = 5000; // milliseconds

// Express Server cho Render Health Checks
const app = express();
app.get('/', (req, res) => res.json({ status: 'alive' }));
app.get('/health', (req, res) => res.status(200).send('OK'));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[HTTP] Web server ready on port ${PORT}`);
});

class VoiceClient {
  constructor() {
    this.gwWs = null;
    this.voiceWs = null;
    this.udpSock = null;
    this.ssrc = 0;
    this.voiceIp = null;
    this.voicePort = null;
    this.encryptionKey = null;
    this.encryptionMode = 'xsalsa20_poly1305';
    this.seq = 0;
    this.timestamp = 0;
    this.sessionId = null;
    this.sequence = null;
    this.running = true;
    this.connected = false;
    this.reconnectCount = 0;
    this.gwHbInterval = null;
    this.voiceHbInterval = null;
    this.silenceInterval = null;
  }

  async run() {
    if (!TOKEN || !GUILD_ID || !CHANNEL_ID) {
      console.error('[ERROR] Missing environment variables: DISCORD_TOKEN, GUILD_ID, or CHANNEL_ID');
      return;
    }

    while (this.running) {
      try {
        const ok = await this.connectGateway();
        if (!ok) {
          await this.sleep(10000);
          continue;
        }

        while (this.running && this.connected) {
          await this.sleep(10000);
        }

        if (!this.running) break;

        this.reconnectCount++;
        const wait = Math.min(5000 * this.reconnectCount, 30000);
        await this.cleanupVoice();
        await this.sleep(wait);
      } catch (err) {
        console.warn(`[WARN] Client error: ${err.message}`);
        this.reconnectCount++;
        const wait = Math.min(5000 * this.reconnectCount, 30000);
        await this.sleep(wait);
      }
    }
  }

  connectGateway() {
    return new Promise((resolve) => {
      this.gwWs = new WebSocket(GATEWAY_URL);

      this.gwWs.on('message', async (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.s !== undefined) this.sequence = msg.s;

          // OP 10 HELLO
          if (msg.op === 10) {
            this.startGwHeartbeat(msg.d.heartbeat_interval);

            this.gwWs.send(JSON.stringify({
              op: 2,
              d: {
                token: TOKEN,
                properties: { $os: 'linux', $browser: 'voice-farm', $device: 'voice-farm' },
                compress: false,
                large_threshold: 50,
                shard: [0, 1]
              }
            }));
          }

          // READY
          if (msg.t === 'READY') {
            this.sessionId = msg.d.session_id;
            this.gwWs.send(JSON.stringify({
              op: 4,
              d: { guild_id: GUILD_ID, channel_id: CHANNEL_ID, self_mute: false, self_deaf: true }
            }));
          }

          // VOICE_SERVER_UPDATE
          if (msg.op === 0 && msg.t === 'VOICE_SERVER_UPDATE') {
            this.voiceToken = msg.d.token;
            this.voiceEndpoint = msg.d.endpoint;
            const connected = await this.connectVoice();
            resolve(connected);
          }

          if (msg.op === 9) {
            resolve(false);
          }
        } catch (e) {
          console.error('[ERROR] Gateway payload error:', e);
        }
      });

      this.gwWs.on('error', (err) => {
        console.error('[ERROR] Gateway WebSocket error:', err.message);
        resolve(false);
      });

      this.gwWs.on('close', () => {
        this.stopGwHeartbeat();
        this.connected = false;
      });
    });
  }

  startGwHeartbeat(interval) {
    this.stopGwHeartbeat();
    this.gwHbInterval = setInterval(() => {
      if (this.gwWs && this.gwWs.readyState === WebSocket.OPEN) {
        this.gwWs.send(JSON.stringify({ op: 1, d: this.sequence }));
      }
    }, interval);
  }

  stopGwHeartbeat() {
    if (this.gwHbInterval) clearInterval(this.gwHbInterval);
  }

  connectVoice() {
    return new Promise((resolve) => {
      if (!this.voiceEndpoint || !this.voiceToken) return resolve(false);

      const vurl = `wss://${this.voiceEndpoint}/?v=${VOICE_GATEWAY_VERSION}`;
      this.voiceWs = new WebSocket(vurl);

      this.voiceWs.on('message', async (data) => {
        try {
          const msg = JSON.parse(data.toString());

          if (msg.op === 8) {
            this.startVoiceHeartbeat(msg.d.heartbeat_interval);
            this.voiceWs.send(JSON.stringify({
              op: 0,
              d: { server_id: GUILD_ID, user_id: null, session_id: this.voiceToken, token: this.voiceToken }
            }));
          }

          if (msg.op === 2) {
            this.ssrc = msg.d.ssrc;
            this.voiceIp = msg.d.ip;
            this.voicePort = msg.d.port;

            if (msg.d.modes.includes('xsalsa20_poly1305')) {
              this.encryptionMode = 'xsalsa20_poly1305';
            }

            const udpSuccess = await this.performUdpDiscovery();
            if (!udpSuccess) return resolve(false);
          }

          if (msg.op === 4) {
            this.encryptionKey = Uint8Array.from(msg.d.secret_key);
            this.connected = true;
            this.startSilenceLoop();
            resolve(true);
          }
        } catch (e) {
          console.error('[ERROR] Voice WS message error:', e);
        }
      });

      this.voiceWs.on('error', (err) => {
        console.error('[ERROR] Voice WS Error:', err.message);
        resolve(false);
      });

      this.voiceWs.on('close', () => {
        this.stopVoiceHeartbeat();
        this.connected = false;
      });
    });
  }

  startVoiceHeartbeat(interval) {
    this.stopVoiceHeartbeat();
    this.voiceHbInterval = setInterval(() => {
      if (this.voiceWs && this.voiceWs.readyState === WebSocket.OPEN) {
        this.voiceWs.send(JSON.stringify({ op: 3, d: Date.now() }));
      }
    }, interval);
  }

  stopVoiceHeartbeat() {
    if (this.voiceHbInterval) clearInterval(this.voiceHbInterval);
  }

  performUdpDiscovery() {
    return new Promise((resolve) => {
      this.udpSock = dgram.createSocket('udp4');

      const packet = Buffer.alloc(74);
      packet.writeUInt32BE(this.ssrc, 0);

      this.udpSock.on('message', (msg) => {
        try {
          const ipEnd = msg.indexOf(0, 8);
          const ourIp = msg.toString('utf8', 8, ipEnd);
          const ourPort = msg.readUInt16BE(6);

          if (this.voiceWs && this.voiceWs.readyState === WebSocket.OPEN) {
            this.voiceWs.send(JSON.stringify({
              op: 1,
              d: { protocol: 'udp', data: { address: ourIp, port: ourPort, mode: this.encryptionMode } }
            }));
          }
          resolve(true);
        } catch (err) {
          console.error('[ERROR] Parsing UDP response:', err);
          resolve(false);
        }
      });

      this.udpSock.send(packet, 0, packet.length, this.voicePort, this.voiceIp, (err) => {
        if (err) {
          console.error('[ERROR] UDP Send failed:', err);
          resolve(false);
        }
      });
    });
  }

  encryptFrame(opusFrame) {
    const hdr = Buffer.alloc(12);
    hdr[0] = 0x80;
    hdr[1] = 0x78;
    hdr.writeUInt16BE(this.seq, 2);
    hdr.writeUInt32BE(this.timestamp, 4);
    hdr.writeUInt32BE(this.ssrc, 8);

    const nonce = new Uint8Array(24);
    nonce.set(hdr, 0);

    const encrypted = nacl.secretbox(opusFrame, nonce, this.encryptionKey);
    return Buffer.concat([hdr, Buffer.from(encrypted)]);
  }

  startSilenceLoop() {
    this.stopSilenceLoop();
    let count = 0;

    this.silenceInterval = setInterval(() => {
      if (!this.running || !this.connected || !this.udpSock) {
        this.stopSilenceLoop();
        return;
      }

      try {
        const pkt = this.encryptFrame(SILENCE_FRAME);
        this.udpSock.send(pkt, 0, pkt.length, this.voicePort, this.voiceIp);

        this.seq = (this.seq + 1) % 65536;
        this.timestamp = (this.timestamp + FRAME_SIZE_AUDIO) % 4294967296;
        count++;

        if (count % 60 === 0) {
          console.log(`[INFO] Alive - ${count} frames sent`);
        }
      } catch (e) {
        console.error('[ERROR] Silence loop error:', e.message);
        this.connected = false;
        this.stopSilenceLoop();
      }
    }, SILENCE_INTERVAL);
  }

  stopSilenceLoop() {
    if (this.silenceInterval) clearInterval(this.silenceInterval);
  }

  async cleanupVoice() {
    this.stopSilenceLoop();
    this.stopVoiceHeartbeat();
    if (this.voiceWs) {
      try { this.voiceWs.close(); } catch (e) {}
      this.voiceWs = null;
    }
    if (this.udpSock) {
      try { this.udpSock.close(); } catch (e) {}
      this.udpSock = null;
    }
  }

  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

const client = new VoiceClient();
client.run().catch((err) => console.error('[FATAL]', err));
