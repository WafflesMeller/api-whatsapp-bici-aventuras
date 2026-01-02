const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const express = require('express');
const pino = require('pino');
const cors = require('cors');
const multer = require('multer');

const app = express();
app.use(express.json());
app.use(cors());

const upload = multer({ storage: multer.memoryStorage() });

let sock;
let status = 'disconnected';
let qrCode = null;

// LOGGER SIMPLE (como el viejo, pero visible)
const log = (msg) => {
    console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);
};

async function connectToWhatsApp() {
    // ⛔ SI YA HAY SOCKET, NO CREAR OTRO
    if (sock) {
        log('Socket ya existe, evitando duplicado');
        return;
    }

    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
    });

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
            log('CONEXIÓN EXITOSA');
        }

        if (connection === 'close') {
            const code = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = code !== DisconnectReason.loggedOut;

            log(`Conexión cerrada (${lastDisconnect?.error?.message})`);

            // 🔥 CLAVE: liberar socket ANTES de reconectar
            sock = null;

            if (shouldReconnect) {
                connectToWhatsApp();
            } else {
                log('Logout real detectado, requiere QR');
            }
        }
    });

    sock.ev.on('creds.update', saveCreds);
}

connectToWhatsApp();

// ================= ENDPOINTS =================

app.get('/status', (req, res) => {
    res.json({ status, qr: qrCode });
});

const formatNumber = (numero) => {
    let n = numero.replace(/\D/g, '');
    if (n.startsWith('0')) n = '58' + n.slice(1);
    return `${n}@s.whatsapp.net`;
};

app.post('/enviar-mensaje', async (req, res) => {
    const { numero, mensaje } = req.body;
    if (!numero || !mensaje) return res.status(400).json({ error: 'Faltan datos' });
    if (!sock || status !== 'connected') return res.status(503).json({ error: 'Bot desconectado' });

    await sock.sendMessage(formatNumber(numero), { text: mensaje });
    res.json({ ok: true });
});

app.post('/enviar-mensaje-media', upload.single('media'), async (req, res) => {
    const { numero, mensaje } = req.body;
    if (!numero || !req.file) return res.status(400).json({ error: 'Faltan datos' });
    if (!sock || status !== 'connected') return res.status(503).json({ error: 'Bot desconectado' });

    await sock.sendMessage(formatNumber(numero), {
        image: req.file.buffer,
        caption: mensaje || ''
    });

    res.json({ ok: true });
});

app.get('/', (_, res) => res.send('BOT ACTIVO'));

app.listen(process.env.PORT || 3000, () => {
    log('Servidor iniciado');
});
