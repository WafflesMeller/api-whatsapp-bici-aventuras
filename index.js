const { 
    makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason, 
    fetchLatestBaileysVersion, 
    makeCacheableSignalKeyStore 
} = require('@whiskeysockets/baileys');
const express = require('express');
const pino = require('pino');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const NodeCache = require('node-cache'); 

const app = express();
app.use(express.json());
app.use(cors());

// Configuración de Multer
const upload = multer({ storage: multer.memoryStorage() });

// --- CACHÉ PARA MEJORAR RENDIMIENTO ---
const msgRetryCounterCache = new NodeCache();

// --- VARIABLES GLOBALES ---
let sock;
let status = 'disconnected'; 
let qrCode = null;           

// --- LOGGER VISUAL ---
const log = (tipo, mensaje) => {
    const hora = new Date().toLocaleTimeString('es-VE', { hour12: false });
    const iconos = { INFO: 'ℹ️', SUCCESS: '✅', WARNING: '⚠️', ERROR: '❌', CRITICAL: '⛔', NETWORK: '📡' };
    console.log(`${iconos[tipo] || '🔹'} [${hora}] ${mensaje}`);
};

// --- FUNCIÓN DE LIMPIEZA (SOLO PARA EMERGENCIAS REALES) ---
const clearAuthFolder = () => {
    const authPath = path.resolve(__dirname, 'auth_info_baileys');
    if (fs.existsSync(authPath)) {
        log('CRITICAL', '🚨 Borrando sesión por error irrecuperable (Logged Out)...');
        try {
            fs.rmSync(authPath, { recursive: true, force: true });
        } catch (e) {
            log('ERROR', `Error borrando: ${e.message}`);
        }
    }
};

// --- LÓGICA PRINCIPAL ---
async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' })
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            qrCode = qr;          // ← para tu app
            status = 'disconnected';
            log('WARNING', 'QR generado, esperando escaneo');
        }

        if (connection === 'close') {
            const shouldReconnect =
                lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;

            log('ERROR', `Conexión cerrada (${lastDisconnect?.error?.message})`);

            if (shouldReconnect) {
                // 🔥 MISMO COMPORTAMIENTO QUE EL CÓDIGO VIEJO
                connectToWhatsApp();
            } else {
                log('CRITICAL', 'Logout real detectado');
                clearAuthFolder();
            }
        }

        if (connection === 'open') {
            status = 'connected';
            qrCode = null;
            log('SUCCESS', '¡CONEXIÓN EXITOSA!');
        }
    });

    sock.ev.on('creds.update', saveCreds);
}


// Arrancar
connectToWhatsApp();

// --- UTILIDADES ---
const formatNumber = (numero) => {
    let numeroLimpio = numero.replace(/\D/g, '');
    if (numeroLimpio.startsWith('0')) numeroLimpio = '58' + numeroLimpio.substring(1);
    return `${numeroLimpio}@s.whatsapp.net`;
};

// ==========================================
//      ENDPOINTS
// ==========================================

app.get('/status', (req, res) => res.json({ status, qr: qrCode }));

app.post('/logout', async (req, res) => {
    try {
        if (sock) await sock.logout();
    } catch (e) { console.error(e); }
    clearAuthFolder();
    status = 'disconnected';
    qrCode = null;
    setTimeout(connectToWhatsApp, 3000);
    res.json({ message: 'Logout exitoso' });
});

app.post('/enviar-mensaje', async (req, res) => {
    const { numero, mensaje } = req.body;
    if (!numero || !mensaje) return res.status(400).json({ error: 'Faltan datos' });
    if (status !== 'connected' || !sock) return res.status(503).json({ error: 'Bot desconectado' });

    try {
        const id = formatNumber(numero);
        await sock.sendMessage(id, { text: mensaje });
        log('SUCCESS', `Mensaje enviado a ${numero}`);
        res.json({ status: 'ok' });
    } catch (e) {
        log('ERROR', `Error envío: ${e.message}`);
        res.status(500).json({ error: 'Error interno' });
    }
});

app.post('/enviar-mensaje-media', upload.single('media'), async (req, res) => {
    const { numero, mensaje } = req.body;
    if (!numero || !req.file) return res.status(400).json({ error: 'Faltan datos' });
    if (status !== 'connected' || !sock) return res.status(503).json({ error: 'Bot desconectado' });

    try {
        const id = formatNumber(numero);
        await sock.sendMessage(id, { image: req.file.buffer, caption: mensaje || '' });
        log('SUCCESS', `Imagen enviada a ${numero}`);
        res.json({ status: 'ok' });
    } catch (e) {
        log('ERROR', `Error envío media: ${e.message}`);
        res.status(500).json({ error: 'Error interno' });
    }
});

app.get('/', (req, res) => res.send('BiciAventuras Bot V2 (Stable) 🚴‍♂️'));

const port = process.env.PORT || 3000;
app.listen(port, () => log('SUCCESS', `Server en puerto ${port}`));