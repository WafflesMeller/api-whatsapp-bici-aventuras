const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const express = require('express');
const qrcode = require('qrcode-terminal');
const pino = require('pino');
const cors = require('cors');
const multer = require('multer');

const app = express();

/* =======================
   CORS CORRECTO Y LIMPIO
======================= */
const allowedOrigins = [
  'https://bici-aventuras-app.vercel.app',
  'https://api.whatsapp-api-check.xyz'
];

app.use(cors({
  origin: function (origin, callback) {
    // Permitir solicitudes sin origen (como Postman, servidor a servidor o la misma terminal)
    if (!origin) return callback(null, true);

    if (allowedOrigins.indexOf(origin) !== -1) {
      return callback(null, true);
    } else {
      console.log('🚫 Origen bloqueado por CORS:', origin);
      return callback(new Error('No permitido por CORS policy'));
    }
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key'],
  credentials: true,
  optionsSuccessStatus: 200 // Importante para que el Preflight (OPTIONS) funcione bien en algunos navegadores
}));

app.use(express.json());

/* =======================
   MULTER
======================= */
const upload = multer({ storage: multer.memoryStorage() });

/* =======================
   ESTADO GLOBAL
======================= */
let sock = null;
let isConnecting = false;

/* =======================
   WHATSAPP
======================= */
async function connectToWhatsApp() {
  if (isConnecting) return;
  isConnecting = true;

  const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    browser: ['BiciAventuras', 'Chrome', '1.0.0']
  });

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('ESCANEA ESTE QR:');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'open') {
      console.log('✅ CONEXIÓN EXITOSA');
      isConnecting = false;
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      console.log('⚠️ Conexión cerrada. Código:', code);

      sock = null;
      isConnecting = false;

      if (code !== DisconnectReason.loggedOut) {
        setTimeout(connectToWhatsApp, 5000);
      } else {
        console.log('❌ Logout real, requiere nuevo QR');
      }
    }
  });

  sock.ev.on('creds.update', saveCreds);
}

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
   ENDPOINTS
======================= */
app.get('/', (_, res) => {
  res.send('EL BOT ESTÁ VIVO 🤖');
});

/* ----- TEXTO ----- */
app.post('/enviar-mensaje', async (req, res) => {
  const { numero, mensaje } = req.body;

  if (!numero || !mensaje) {
    return res.status(400).json({ error: 'Faltan datos' });
  }

  if (!sock) {
    return res.status(503).json({ error: 'Bot desconectado' });
  }

  try {
    const id = formatNumber(numero);

    await sock.sendMessage(id, { text: mensaje });

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error enviando mensaje' });
  }
});

/* ----- IMAGEN ----- */
app.post('/enviar-mensaje-media', upload.single('media'), async (req, res) => {
  const { numero, mensaje } = req.body;
  const file = req.file;

  if (!numero || !file) {
    return res.status(400).json({ error: 'Faltan datos' });
  }

  if (!sock) {
    return res.status(503).json({ error: 'Bot desconectado' });
  }

  try {
    const id = formatNumber(numero);

    await sock.sendMessage(id, {
      image: file.buffer,
      caption: mensaje || ''
    });

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error enviando imagen' });
  }
});

/* =======================
   SERVER
======================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 API escuchando en puerto ${PORT}`);
});