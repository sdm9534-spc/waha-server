const { default: makeWASocket, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const express = require('express');
const http = require('http');
const app = express();
app.use(express.json());

const sessions = {};
const pendingRequests = {};

// ⭐ Health check
app.get('/', (req, res) => {
    res.json({ status: 'online', sessions: Object.keys(sessions).length });
});

app.get('/sessions', (req, res) => {
    res.json({ success: true, sessions: Object.keys(sessions).map(p => ({ phone: p })) });
});

app.post('/start-session', async (req, res) => {
    try {
        const { phone, sessionId } = req.body;
        if (!phone || !sessionId) return res.json({ success: false, error: 'Missing phone or sessionId' });
        if (sessions[phone]) return res.json({ success: true, status: 'already_connected' });
        
        const { state, saveCreds } = await useMultiFileAuthState(`./sessions/${sessionId}`);
        const sock = makeWASocket({ auth: state, printQRInTerminal: true, browser: ['WA Store', 'Chrome', '1.0.0'] });
        
        let responded = false;
        sock.ev.on('creds.update', saveCreds);
        
        sock.ev.on('connection.update', (update) => {
            const { connection, qr } = update;
            if (qr && !responded) {
                responded = true;
                return res.json({ success: true, status: 'qr', qr: qr });
            }
            if (connection === 'open') {
                sessions[phone] = { sock, sessionId };
                if (!responded) { responded = true; return res.json({ success: true, status: 'connected' }); }
            }
        });
        
        sock.ev.on('messages.upsert', (m) => {
            try {
                const msg = m.messages[0];
                if (!msg?.message) return;
                let text = msg.message.conversation || msg.message.extendedTextMessage?.text || msg.message.imageMessage?.caption || '';
                const code = text.match(/\b(\d{4,8})\b/);
                if (code) {
                    pendingRequests[phone] = { code: code[1], timestamp: Date.now() };
                    console.log(`📩 Code for ${phone}: ${code[1]}`);
                }
            } catch(e) {}
        });
        
    } catch(err) {
        if (!res.headersSent) res.json({ success: false, error: err.message });
    }
});

app.post('/request-code', (req, res) => {
    const { phone } = req.body;
    if (pendingRequests[phone] && Date.now() - pendingRequests[phone].timestamp < 300000) {
        return res.json({ success: true, code: pendingRequests[phone].code });
    }
    res.json({ success: true, status: 'waiting' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server on port ${PORT}`));

// ⭐ Keep-alive
setInterval(() => {
    http.get('http://localhost:' + PORT + '/');
}, 300000);
