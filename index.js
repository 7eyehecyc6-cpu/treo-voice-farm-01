const { Client } = require('discord.js-selfbot-v13');
const http = require('http');
const https = require('https');

const TOKEN = process.env.DISCORD_TOKEN || '';
const GUILD_ID = process.env.GUILD_ID || '';
const CHANNEL_ID = process.env.CHANNEL_ID || '';
const PORT = process.env.PORT || 8080;
const APP_URL = process.env.APP_URL || process.env.RENDER_EXTERNAL_URL || '';

if (!TOKEN || !GUILD_ID || !CHANNEL_ID) {
    console.error('[VOICE] Missing required env vars');
    process.exit(1);
}

const client = new Client({
    checkUpdate: false,
    ws: {
        properties: {
            $os: 'Windows',
            $browser: 'Discord Client',
            $device: 'Desktop',
            $referrer: '',
            $referring_domain: ''
        }
    }
});

let voiceConnection = null;
let reconnectTimer = null;
let reconnectAttempts = 0;
const MAX_RECONNECT = 50;

async function joinVoice() {
    try {
        const guild = client.guilds.cache.get(GUILD_ID);
        if (!guild) {
            const fetched = await client.guilds.fetch(GUILD_ID).catch(() => null);
            if (!fetched) return false;
        }
        
        const g = client.guilds.cache.get(GUILD_ID);
        const channel = await g.channels.fetch(CHANNEL_ID).catch(() => null);
        
        if (!channel || !channel.isVoice()) return false;

        console.log(`[VOICE] Joining: ${g.name} -> ${channel.name}`);

        voiceConnection = await client.voice.joinChannel(channel, {
            selfDeaf: true,
            selfMute: false,
            selfVideo: false
        });

        reconnectAttempts = 0;

        voiceConnection.on('ready', () => {
            console.log('[VOICE] ✅ Voice connection READY — 24/7 mode active');
        });

        voiceConnection.on('disconnect', () => {
            voiceConnection = null;
            scheduleReconnect();
        });

        return true;
    } catch (e) {
        console.error(`[VOICE] Join error: ${e.message}`);
        voiceConnection = null;
        scheduleReconnect();
        return false;
    }
}

function scheduleReconnect() {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectAttempts++;
    const delay = Math.min(5000 * reconnectAttempts, 30000);
    if (reconnectAttempts > MAX_RECONNECT) {
        reconnectAttempts = 0;
        reconnectTimer = setTimeout(() => joinVoice(), 300000);
        return;
    }
    reconnectTimer = setTimeout(() => joinVoice(), delay);
}

client.on('ready', async () => {
    console.log(`[VOICE] Logged in as: ${client.user.tag}`);
    await joinVoice();
});

client.on('voiceStateUpdate', (oldState, newState) => {
    if (newState.id !== client.user?.id) return;
    if (!newState.channelId) {
        voiceConnection = null;
        scheduleReconnect();
    }
});

// --- HTTP SERVER & KEEP-ALIVE PING SYSTEM ---
const server = http.createServer((req, res) => {
    if (req.url === '/health' || req.url === '/ping') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
            status: 'online', 
            voiceReady: Boolean(voiceConnection?.ready),
            timestamp: new Date().toISOString()
        }));
    } else {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('Host Keep-Alive Service is Running!');
    }
});

server.listen(PORT, () => console.log(`[HTTP] Anti-Sleep Server listening on port ${PORT}`));

// Hàm tự gửi HTTP request đến chính URL để không bị ngủ
function startKeepAlivePing() {
    if (!APP_URL) {
        console.log('[PING] APP_URL chưa được cấu hình. Bỏ qua tự động ping.');
        return;
    }

    const fullUrl = APP_URL.startsWith('http') ? APP_URL : `https://${APP_URL}`;
    const pingEndpoint = `${fullUrl.replace(/\/+$/, '')}/ping`;

    console.log(`[PING] Khởi chạy Keep-Alive Ping tới: ${pingEndpoint}`);

    // Gửi Ping mỗi 10 phút (600,000 ms)
    setInterval(() => {
        const requester = pingEndpoint.startsWith('https') ? https : http;
        requester.get(pingEndpoint, (res) => {
            console.log(`[PING] Keep-Alive Ping Sent | Status: ${res.statusCode}`);
        }).on('error', (err) => {
            console.error(`[PING] Ping Error: ${err.message}`);
        });
    }, 10 * 60 * 1000);
}

startKeepAlivePing();

client.login(TOKEN).catch(() => process.exit(1));