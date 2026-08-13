const { Client } = require('discord.js-selfbot-v13');
const { joinVoiceChannel } = require('@discordjs/voice');
const express = require('express');

const client = new Client({
    checkUpdate: false
});

const app = express();
const PORT = process.env.PORT || 8080;

// Healthcheck endpoints dành cho Railway & Render
app.get('/', (req, res) => res.send('🟢 Voice Farm Selfbot is active!'));
app.get('/health', (req, res) => res.status(200).send('OK'));

app.listen(PORT, () => {
    console.log(`🌐 Web server đang chạy tại port ${PORT}`);
});

client.on('ready', async () => {
    console.log(`✅ Đã đăng nhập tài khoản: ${client.user.tag}`);

    const guildId = process.env.GUILD_ID;
    const channelId = process.env.CHANNEL_ID;

    if (!guildId || !channelId) {
        console.error('❌ Lỗi: Thiếu biến môi trường GUILD_ID hoặc CHANNEL_ID!');
        return;
    }

    try {
        const guild = await client.guilds.fetch(guildId);
        const channel = await client.channels.fetch(channelId);

        if (!channel || !channel.isVoice()) {
            console.error('❌ Kênh được chọn không phải là Kênh Thoại (Voice Channel) hợp lệ!');
            return;
        }

        // Kết nối vào kênh thoại
        joinVoiceChannel({
            channelId: channel.id,
            guildId: guild.id,
            adapterCreator: guild.voiceAdapterCreator,
            selfMute: true,  // Tự động Tắt tiếng
            selfDeaf: true   // Tự động Tắt tai nghe
        });

        console.log(`🔊 Đã treo Voice thành công tại: [${channel.name}] - Server: [${guild.name}]`);
    } catch (err) {
        console.error('❌ Lỗi kết nối Kênh Thoại:', err.message);
    }
});

client.on('shardDisconnect', () => {
    console.warn('⚠️ Mất kết nối Discord, hệ thống sẽ tự động thử lại...');
});

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
if (!DISCORD_TOKEN) {
    console.error('❌ Lỗi: Chưa cung cấp DISCORD_TOKEN!');
    process.exit(1);
}

client.login(DISCORD_TOKEN);
