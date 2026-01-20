const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const qrcode = require('qrcode-terminal');
const pino = require('pino');
const cors = require('cors');
const multer = require('multer');

const app = express();
const server = http.createServer(app);

/* =======================
   CONFIGURACIÓN CORS (BLINDADA)
======================= */
const allowedOrigins = [
  'https://bici-aventuras-app.vercel.app',
  'https://api.whatsapp-api-check.xyz',
  'http://localhost:5173'
];

const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ["GET", "POST"],
    credentials: true
  },
  path: '/socket.io/' // IMPORTANTE PARA NGINX
});

app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.indexOf(origin) !== -1) {
      return callback(null, true);
    } else {
      return callback(null, true); // MODO PERMISIVO TEMPORAL PARA DESCARTAR ERRORES
    }
  },
  credentials: true
}));

app.use(express.json());
const upload = multer({ storage: multer.memoryStorage() });

/* =======================
   ESTADO GLOBAL
======================= */
let sock = null;
let isConnecting = false;
let lastQr = null;

/* =======================
   SOCKET.IO
======================= */
io.on('connection', (socket) => {
  console.log('Cliente conectado ID:', socket.id);

  if (sock?.user) {
    socket.emit('status', 'connected');
  } else if (lastQr) {
    socket.emit('qr', lastQr);
    socket.emit('status', 'scan_needed');
  } else {
    socket.emit('status', 'connecting'); // Enviamos connecting si no sabemos nada aún
  }
});

/* =======================
   WHATSAPP
======================= */
async function connectToWhatsApp() {
  if (isConnecting) return;
  isConnecting = true;

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
      lastQr = qr;
      io.emit('qr', qr);
      io.emit('status', 'scan_needed');
      console.log('QR Generado');
    }

    if (connection === 'open') {
      console.log('✅ CONEXIÓN EXITOSA');
      lastQr = null;
      io.emit('status', 'connected');
      isConnecting = false;
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      console.log('⚠️ Conexión cerrada. Código:', code);
      io.emit('status', 'disconnected');
      
      sock = null;
      isConnecting = false;
      lastQr = null;

      if (code !== DisconnectReason.loggedOut) {
        setTimeout(connectToWhatsApp, 5000);
      } else {
        connectToWhatsApp();
      }
    }
  });

  sock.ev.on('creds.update', saveCreds);
}

connectToWhatsApp();

/* =======================
   ENDPOINTS (CORS FIX)
======================= */
// Endpoint de estado para polling
app.get('/status', (req, res) => {
    res.json({
        status: sock?.user ? 'connected' : 'disconnected',
        qr: lastQr
    });
});

app.post('/logout', async (req, res) => {
    if(sock) {
        await sock.logout();
        res.json({ok: true});
    } else {
        res.status(400).json({error: 'No conectado'});
    }
});

app.post('/enviar-mensaje', async (req, res) => {
  const { numero, mensaje } = req.body;
  if (!sock) return res.status(503).json({ error: 'Bot desconectado' });
  
  try {
    const id = numero.replace(/\D/g, '') + '@s.whatsapp.net';
    await sock.sendMessage(id, { text: mensaje });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error interno' });
  }
});

/* =======================
   SERVER
======================= */
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 SERVIDOR CORRIENDO EN PUERTO ${PORT}`);
});