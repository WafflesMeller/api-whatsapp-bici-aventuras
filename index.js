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
let status = 'disconnected'; // 'disconnected', 'connecting', 'connected'
let qrCode = null; // Aquí guardaremos el QR para enviarlo al frontend

// LOGGER DETALLADO
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
            qrCode = qr; // Guardamos el QR aquí
            status = 'disconnected';
            log('QR generado, esperando escaneo');
        }

        if (connection === 'open') {
            status = 'connected';
            qrCode = null; // Ya no necesitamos el QR
            log('CONEXIÓN EXITOSA');
        }

        if (connection === 'close') {
            const code = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = code !== DisconnectReason.loggedOut;

            log(`Conexión cerrada (${lastDisconnect?.error?.message})`);

            // 🔥 CLAVE: liberar socket ANTES de reconectar
            sock = null;

            // Si es un conflicto o error de stream, reconectar
            if (shouldReconnect) {
                log('⚠️ Reconectando...');
                setTimeout(() => {
                    connectToWhatsApp();
                }, 8000);  // Espera más tiempo para reconectar
            } else {
                log('CRITICAL', 'Logout real detectado, requiere QR');
            }
        }
    });

    sock.ev.on('creds.update', saveCreds);
}

connectToWhatsApp();

// ================= ENDPOINTS =================

app.get('/status', (req, res) => {
    res.json({
        status: status,
        qr: qrCode // Enviar el QR al frontend
    });
});

const formatNumber = (numero) => {
    let n = numero.replace(/\D/g, '');
    if (n.startsWith('0')) n = '58' + n.slice(1);
    return `${n}@s.whatsapp.net`;
};

// Enviar mensaje de texto
app.post('/enviar-mensaje', async (req, res) => {
    const { numero, mensaje } = req.body;
    if (!numero || !mensaje) return res.status(400).json({ error: 'Faltan datos' });

    try {
        if (status !== 'connected' || !sock) return res.status(503).json({ error: 'Bot desconectado' });

        const idWhatsapp = formatNumber(numero);
        const [onWhatsApp] = await sock.onWhatsApp(idWhatsapp);
        
        if (!onWhatsApp || !onWhatsApp.exists) {
             return res.status(404).json({ error: 'El número no tiene WhatsApp' });
        }

        log(`Enviando mensaje a ${numero}: ${mensaje}`);
        await sock.sendMessage(idWhatsapp, { text: mensaje });
        res.json({ status: 'ok' });
    } catch (error) {
        log(`Error al enviar mensaje: ${error.message}`);
        res.status(500).json({ error: 'Error interno' });
    }
});

// Enviar mensaje con imagen
app.post('/enviar-mensaje-media', upload.single('media'), async (req, res) => {
    const { numero, mensaje } = req.body;
    const file = req.file;

    if (!numero || !file) return res.status(400).json({ error: 'Faltan datos' });

    try {
        if (status !== 'connected' || !sock) return res.status(503).json({ error: 'Bot desconectado' });
        const idWhatsapp = formatNumber(numero);

        log(`Enviando imagen a ${numero}: ${mensaje}`);
        await sock.sendMessage(idWhatsapp, { 
            image: file.buffer, 
            caption: mensaje || '' 
        });

        res.json({ status: 'ok', mensaje: 'Imagen enviada' });
    } catch (error) {
        log(`Error al enviar imagen: ${error.message}`);
        res.status(500).json({ error: 'Error interno al enviar media' });
    }
});

app.get('/', (_, res) => res.send('BOT ACTIVO'));

app.listen(process.env.PORT || 3000, () => {
    log('Servidor iniciado');
});
