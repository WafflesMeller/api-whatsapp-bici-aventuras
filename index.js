const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const express = require('express');
const pino = require('pino');
const cors = require('cors');
const multer = require('multer');

const app = express();

// Configuración CORS simple
app.use(cors());
app.use(express.json());

// VARIABLES GLOBALES PARA GUARDAR EL ESTADO
let sock = null;
let status = 'starting'; // starting, scan_needed, connected, disconnected
let currentQR = null;

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
  
  sock = makeWASocket({
    auth: state,
    printQRInTerminal: true,
    logger: pino({ level: 'silent' }),
    browser: ['BiciAventuras', 'Chrome', '1.0.0']
  });

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      status = 'scan_needed';
      currentQR = qr;
      console.log('NUEVO QR GENERADO');
    }

    if (connection === 'open') {
      console.log('CONEXIÓN EXITOSA');
      status = 'connected';
      currentQR = null;
    }

    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      status = 'disconnected';
      currentQR = null;
      console.log('DESCONECTADO');
      
      if (shouldReconnect) {
        connectToWhatsApp();
      }
    }
  });

  sock.ev.on('creds.update', saveCreds);
}

// Iniciar WhatsApp
connectToWhatsApp();

// --- ENDPOINTS (API) ---

// 1. Endpoint para que el Frontend pregunte el estado (Polling)
app.get('/status', (req, res) => {
    res.json({
        status: status,
        qr: currentQR
    });
});

// 2. Endpoint para enviar mensaje
app.post('/enviar-mensaje', async (req, res) => {
    if (status !== 'connected' || !sock) {
        return res.status(503).json({ error: 'Bot no conectado' });
    }
    const { numero, mensaje } = req.body;
    try {
        const id = numero.replace(/\D/g, '') + '@s.whatsapp.net';
        await sock.sendMessage(id, { text: mensaje });
        res.json({ ok: true });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Error al enviar' });
    }
});

// 3. Endpoint para cerrar sesión
app.post('/logout', async (req, res) => {
    try {
        if (sock) await sock.logout();
        status = 'disconnected';
        currentQR = null;
        res.json({ ok: true });
        // Reiniciamos el proceso para generar nuevo QR
        setTimeout(connectToWhatsApp, 2000); 
    } catch (e) {
        res.status(500).json({ error: 'Error logout' });
    }
});

const PORT = 3000;
app.listen(PORT, () => console.log(`API HTTP corriendo en puerto ${PORT}`));