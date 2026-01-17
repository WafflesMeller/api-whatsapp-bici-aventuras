const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const express = require('express');
const pino = require('pino');
const cors = require('cors');
const multer = require('multer');

// ================== APP ==================
const app = express();
app.use(express.json());
app.use(cors());

const upload = multer({ storage: multer.memoryStorage() });

// ================== ESTADO GLOBAL ==================
let sock = null;
let status = 'disconnected'; // disconnected | connecting | connected
let qrCode = null;
let isConnecting = false;
let reconnectAttempts = 0;

// ================== LOGGER ==================
const log = (msg) => {
    console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);
};

// ================== CONEXIÓN WHATSAPP ==================
async function connectToWhatsApp() {
    if (isConnecting) return;
    isConnecting = true;
    status = 'connecting';

    try {
        const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

        sock = makeWASocket({
            auth: state,
            logger: pino({ level: 'silent' }),
            browser: ['MegaPixelBot', 'Chrome', '1.0.0'],
            markOnlineOnConnect: true,
            syncFullHistory: false,
            keepAliveIntervalMs: 20_000,
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                qrCode = qr;
                status = 'disconnected';
                log('QR generado, esperando escaneo');
            }

            if (connection === 'open') {
                status = 'connected';
                qrCode = null;
                reconnectAttempts = 0;
                isConnecting = false;
                log('CONEXIÓN ESTABLECIDA Y ACTIVA');
            }

            if (connection === 'close') {
                const code = lastDisconnect?.error?.output?.statusCode;
                const reason = lastDisconnect?.error?.message || 'Desconocido';

                log(`Conexión cerrada: ${reason}`);

                sock = null;
                status = 'disconnected';
                isConnecting = false;

                if (code === DisconnectReason.loggedOut) {
                    log('❌ LOGOUT REAL. Se requiere nuevo QR.');
                    return;
                }

                if (code === DisconnectReason.conflict) {
                    log('⚠️ CONFLICTO DE SESIÓN detectado');
                }

                const delay = Math.min(10_000 + reconnectAttempts * 5_000, 60_000);
                reconnectAttempts++;

                log(`Reintentando conexión en ${delay / 1000}s...`);

                setTimeout(() => {
                    connectToWhatsApp();
                }, delay);
            }
        });

    } catch (error) {
        log(`Error crítico al conectar: ${error.message}`);
        sock = null;
        status = 'disconnected';
        isConnecting = false;

        setTimeout(() => {
            connectToWhatsApp();
        }, 15_000);
    }
}

// ================== KEEP ALIVE REAL ==================
setInterval(async () => {
    try {
        if (sock && status === 'connected') {
            await sock.sendPresenceUpdate('available');
            log('Keep-alive enviado');
        }
    } catch (err) {
        log('Error en keep-alive');
    }
}, 5 * 60 * 1000); // cada 5 minutos

// ================== INICIAR BOT ==================
connectToWhatsApp();

// ================== ENDPOINTS ==================

app.get('/', (_, res) => {
    res.send('BOT ACTIVO');
});

app.get('/status', (req, res) => {
    res.json({
        status,
        qr: qrCode
    });
});

const formatNumber = (numero) => {
    let n = numero.replace(/\D/g, '');
    if (n.startsWith('0')) n = '58' + n.slice(1);
    return `${n}@s.whatsapp.net`;
};

// ================== MENSAJE TEXTO ==================
app.post('/enviar-mensaje', async (req, res) => {
    const { numero, mensaje } = req.body;

    if (!numero || !mensaje) {
        return res.status(400).json({ error: 'Faltan datos' });
    }

    if (!sock || status !== 'connected') {
        return res.status(503).json({ error: 'Bot desconectado' });
    }

    try {
        const jid = formatNumber(numero);
        const [onWhatsApp] = await sock.onWhatsApp(jid);

        if (!onWhatsApp?.exists) {
            return res.status(404).json({ error: 'El número no tiene WhatsApp' });
        }

        await sock.sendMessage(jid, { text: mensaje });
        log(`Mensaje enviado a ${numero}`);

        res.json({ status: 'ok' });

    } catch (error) {
        log(`Error al enviar mensaje: ${error.message}`);
        res.status(500).json({ error: 'Error interno' });
    }
});

// ================== MENSAJE IMAGEN ==================
app.post('/enviar-mensaje-media', upload.single('media'), async (req, res) => {
    const { numero, mensaje } = req.body;
    const file = req.file;

    if (!numero || !file) {
        return res.status(400).json({ error: 'Faltan datos' });
    }

    if (!sock || status !== 'connected') {
        return res.status(503).json({ error: 'Bot desconectado' });
    }

    try {
        const jid = formatNumber(numero);

        await sock.sendMessage(jid, {
            image: file.buffer,
            caption: mensaje || ''
        });

        log(`Imagen enviada a ${numero}`);
        res.json({ status: 'ok' });

    } catch (error) {
        log(`Error al enviar imagen: ${error.message}`);
        res.status(500).json({ error: 'Error interno al enviar media' });
    }
});

// ================== SERVER ==================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    log(`Servidor iniciado en puerto ${PORT}`);
});
