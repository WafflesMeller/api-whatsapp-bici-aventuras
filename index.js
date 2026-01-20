const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const pino = require('pino');
const cors = require('cors');
const multer = require('multer');

// 1. CREACIÓN DEL SERVIDOR
const app = express();
const server = http.createServer(app); // <--- ESTO ES CRUCIAL

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
const upload = multer({ storage: multer.memoryStorage() });

// 2. SOCKET.IO SIN PATH (Usa el default /socket.io/)
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  transports: ['websocket', 'polling']
});

let sock = null;
let lastQr = null;

io.on('connection', (socket) => {
  console.log('Cliente conectado ID:', socket.id);
  if (sock?.user) {
    socket.emit('status', 'connected');
  } else if (lastQr) {
    socket.emit('qr', lastQr);
    socket.emit('status', 'scan_needed');
  } else {
    socket.emit('status', 'connecting');
  }
});
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
      lastQr = qr;
      io.emit('qr', qr);
      io.emit('status', 'scan_needed');
      console.log('Nuevo QR generado');
    }

    if (connection === 'open') {
      console.log('CONEXIÓN EXITOSA');
      lastQr = null;
      io.emit('status', 'connected');
    }

    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      io.emit('status', 'disconnected');
      if (shouldReconnect) connectToWhatsApp();
    }
  });

  sock.ev.on('creds.update', saveCreds);
}

connectToWhatsApp();

// Endpoints
app.get('/', (req, res) => res.send('Bot Activo'));

app.post('/enviar-mensaje', async (req, res) => {
    if(!sock) return res.status(500).json({error: 'Bot desconectado'});
    const { numero, mensaje } = req.body;
    const id = numero.replace(/\D/g, '') + '@s.whatsapp.net';
    await sock.sendMessage(id, { text: mensaje });
    res.json({ok: true});
});

server.listen(3000, () => console.log('Servidor en puerto 3000'));