const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const express = require('express');
const qrcode = require('qrcode-terminal');
const pino = require('pino');
const cors = require('cors');
const multer = require('multer'); // <--- NUEVO: Importamos Multer

const app = express();
app.use(express.json());
app.use(cors());

// --- CONFIGURACIÓN DE MULTER (Para recibir archivos) ---
// Usamos memoryStorage para guardar la imagen en la RAM temporalmente (más rápido en Render)
const upload = multer({ storage: multer.memoryStorage() });

let sock;

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' })
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('ESCANEA EL QR:');
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) connectToWhatsApp();
        } else if (connection === 'open') {
            console.log('¡CONEXIÓN EXITOSA! EL BOT ESTÁ LISTO.');
        }
    });

    sock.ev.on('creds.update', saveCreds);
}

connectToWhatsApp();

// --- FUNCIÓN AUXILIAR PARA FORMATEAR NÚMEROS ---
const formatNumber = (numero) => {
    let numeroLimpio = numero.replace(/\D/g, '');
    if (numeroLimpio.startsWith('0')) {
        numeroLimpio = '58' + numeroLimpio.substring(1); // Ajuste Venezuela
    }
    return `${numeroLimpio}@s.whatsapp.net`;
};

// --- ENDPOINT 1: SOLO TEXTO (El que ya tenías) ---
app.post('/enviar-mensaje', async (req, res) => {
    const { numero, mensaje } = req.body;

    if (!numero || !mensaje) {
        return res.status(400).json({ error: 'Faltan datos' });
    }

    try {
        if (!sock) return res.status(500).json({ error: 'Bot desconectado' });

        const idWhatsapp = formatNumber(numero);
        
        // Verificar si existe (opcional, consume tiempo)
        const [onWhatsApp] = await sock.onWhatsApp(idWhatsapp);
        if (!onWhatsApp || !onWhatsApp.exists) {
             return res.status(404).json({ error: 'El número no tiene WhatsApp' });
        }

        await sock.sendMessage(idWhatsapp, { text: mensaje });
        console.log(`Texto enviado a ${numero}`);
        res.json({ status: 'ok' });

    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: 'Error interno' });
    }
});

// --- ENDPOINT 2: IMAGEN + TEXTO (El nuevo para el Ticket) ---
// 'media' es el nombre del campo que pusimos en el FormData del frontend
app.post('/enviar-mensaje-media', upload.single('media'), async (req, res) => {
    // Multer pone los campos de texto en req.body y el archivo en req.file
    const { numero, mensaje } = req.body;
    const file = req.file;

    if (!numero || !file) {
        return res.status(400).json({ error: 'Faltan datos (numero o archivo media)' });
    }

    try {
        if (!sock) return res.status(500).json({ error: 'Bot desconectado' });

        const idWhatsapp = formatNumber(numero);

        // Enviar imagen (Baileys acepta el Buffer directamente)
        await sock.sendMessage(idWhatsapp, { 
            image: file.buffer, 
            caption: mensaje || '' // El texto va como caption
        });

        console.log(`Imagen enviada a ${numero}`);
        res.json({ status: 'ok', mensaje: 'Imagen enviada' });

    } catch (error) {
        console.error('Error enviando media:', error);
        res.status(500).json({ error: 'Error interno al enviar media' });
    }
});

app.get('/', (req, res) => res.send('EL BOT ESTÁ VIVO 🤖'));

const port = process.env.PORT || 3000;
app.listen(port, () => {
    console.log(`Servidor API escuchando en puerto ${port}`);
});