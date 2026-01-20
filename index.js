const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const express = require('express');
const http = require('http'); // Necesario para integrar Socket.io
const { Server } = require('socket.io'); // Importamos la clase Server
const qrcode = require('qrcode-terminal');
const pino = require('pino');
const cors = require('cors');
const multer = require('multer');

const app = express();
const server = http.createServer(app); // Creamos el servidor HTTP envolviendo a Express

/* =======================
   CONFIGURACIÓN DE SOCKET.IO Y CORS
======================= */
const allowedOrigins = [
  'https://bici-aventuras-app.vercel.app', // Tu frontend en producción
  'https://api.whatsapp-api-check.xyz',    // Tu backend/dominio actual
  'http://localhost:5173'                  // Para tus pruebas en local
];

// Configuración del servidor de Sockets
const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ["GET", "POST"],
    credentials: true
  }
});

// Configuración de CORS para Express (rutas normales)
app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.indexOf(origin) !== -1) {
      return callback(null, true);
    } else {
      console.log('Bloqueado por CORS:', origin);
      return callback(new Error('Bloqueado por CORS'));
    }
  },
  credentials: true,
  optionsSuccessStatus: 200
}));

app.use(express.json());
const upload = multer({ storage: multer.memoryStorage() });

/* =======================
   ESTADO GLOBAL
======================= */
let sock = null;
let isConnecting = false;
let lastQr = null; // Guardamos el último QR generado

/* =======================
   EVENTOS DE SOCKET.IO
======================= */
io.on('connection', (socket) => {
  console.log('🔌 Cliente web conectado al Socket:', socket.id);

  // Si hay un usuario conectado, avisar inmediatamente
  if (sock?.user) {
    socket.emit('status', 'connected');
  } 
  // Si no hay usuario pero hay un QR pendiente, enviarlo
  else if (lastQr) {
    socket.emit('qr', lastQr);
    socket.emit('status', 'scan_needed');
  } else {
    socket.emit('status', 'connecting');
  }
});

/* =======================
   LÓGICA DE WHATSAPP (BAILEYS)
======================= */
async function connectToWhatsApp() {
  if (isConnecting) return;
  isConnecting = true;

  const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: true, // Se mantiene en terminal por si acaso
    logger: pino({ level: 'silent' }),
    browser: ['BiciAventuras', 'Chrome', '1.0.0']
  });

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('✨ Nuevo QR generado');
      lastQr = qr;
      io.emit('qr', qr); // Enviar QR a todos los clientes web conectados
      io.emit('status', 'scan_needed');
    }

    if (connection === 'open') {
      console.log('✅ CONEXIÓN EXITOSA A WHATSAPP');
      lastQr = null; // Limpiamos el QR porque ya se usó
      io.emit('status', 'connected'); // Avisar a la web que ya estamos listos
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
        setTimeout(connectToWhatsApp, 5000); // Reconexión automática
      } else {
        console.log('❌ Sesión cerrada (Logout). Se generará nuevo QR.');
        connectToWhatsApp(); 
      }
    }
  });

  sock.ev.on('creds.update', saveCreds);
}

// Iniciamos la conexión
connectToWhatsApp();

/* =======================
   HELPERS
======================= */
const formatNumber = (numero) => {
  let n = numero.replace(/\D/g, '');
  if (n.startsWith('0')) n = '58' + n.slice(1);
  return `${n}@s.whatsapp.net`;
};

/* =======================
   ENDPOINTS HTTP
======================= */
app.get('/', (_, res) => {
  res.send('🤖 BOT ONLINE CON SOCKETS');
});

// Enviar Mensaje Texto
app.post('/enviar-mensaje', async (req, res) => {
  const { numero, mensaje } = req.body;
  if (!numero || !mensaje) return res.status(400).json({ error: 'Faltan datos' });
  if (!sock) return res.status(503).json({ error: 'Bot desconectado' });

  try {
    const id = formatNumber(numero);
    await sock.sendMessage(id, { text: mensaje });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error enviando mensaje' });
  }
});

// Enviar Mensaje Multimedia
app.post('/enviar-mensaje-media', upload.single('media'), async (req, res) => {
  const { numero, mensaje } = req.body;
  const file = req.file;

  if (!numero || !file) return res.status(400).json({ error: 'Faltan datos' });
  if (!sock) return res.status(503).json({ error: 'Bot desconectado' });

  try {
    const id = formatNumber(numero);
    await sock.sendMessage(id, { image: file.buffer, caption: mensaje || '' });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error enviando imagen' });
  }
});

/* =======================
   ARRANCAR SERVIDOR
   ¡IMPORTANTE! Usamos server.listen, NO app.listen
======================= */
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Servidor listo en puerto ${PORT}`);
});