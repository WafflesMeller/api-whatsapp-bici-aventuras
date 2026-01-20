const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const express = require('express');
const pino = require('pino');
const cors = require('cors');
const multer = require('multer'); 
const qrcode = require('qrcode-terminal');
const fs = require('fs'); // NECESARIO PARA EL LOGOUT

const app = express();
app.use(cors());
app.use(express.json());

// CONFIGURACIÓN PARA SUBIR ARCHIVOS (En memoria)
const upload = multer({ storage: multer.memoryStorage() });

// VARIABLES DE ESTADO
let sock = null;
let status = 'starting'; 
let currentQR = null;

// --- FUNCIÓN DE AYUDA: FORMATEAR NÚMERO VENEZUELA ---
function formatearNumero(numero) {
    if (!numero) return '';
    // 1. Quitar todo lo que no sea número
    let limpio = numero.toString().replace(/\D/g, '');

    // 2. Lógica para Venezuela
    // Si empieza con '0' (ej: 0412...) lo cambiamos por '58412...'
    if (limpio.startsWith('0')) {
        return '58' + limpio.slice(1);
    } 
    // Si tiene 10 dígitos (ej: 4121234567) asumimos que falta el 58
    else if (limpio.length === 10) {
        return '58' + limpio;
    }
    
    // Si ya viene con 58 o es otro formato, lo devolvemos limpio
    return limpio;
}

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
  
  sock = makeWASocket({
    auth: state,
    printQRInTerminal: false, // Lo hacemos manual abajo para guardar la variable
    logger: pino({ level: 'silent' }),
    browser: ['BiciAventuras', 'Chrome', '1.0.0']
  });

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      status = 'scan_needed';
      currentQR = qr;
      console.log('\nEscanea el QR ahora.\n');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'open') {
      status = 'connected';
      currentQR = null;
      console.log('\n✅ CONEXIÓN EXITOSA\n');
    }

    if (connection === 'close') {
      status = 'disconnected';
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      // Si no fue un logout manual, intentamos reconectar
      if (shouldReconnect) connectToWhatsApp();
    }
  });

  sock.ev.on('creds.update', saveCreds);
}

// Iniciar Bot
connectToWhatsApp();

// --- ENDPOINTS ---

// 1. ESTADO DEL BOT (Para el Polling de React)
app.get('/status', (req, res) => {
    res.json({ status: status, qr: currentQR });
});

// 2. CERRAR SESIÓN (NUCLEAR / FUERZA BRUTA)
app.post('/logout', async (req, res) => {
    try {
        // A. Intentar cerrar socket suavemente
        if (sock) {
            try {
                await sock.logout();
                sock.end(undefined);
            } catch (error) {
                console.log("Error cerrando socket (ignorable):", error);
            }
        }

        // B. BORRADO NUCLEAR: Eliminar carpeta de credenciales
        const path = './auth_info_baileys';
        if (fs.existsSync(path)) {
            fs.rmSync(path, { recursive: true, force: true });
            console.log('🗑️ Carpeta de sesión eliminada correctamente.');
        }

        // C. Resetear variables
        sock = null;
        status = 'disconnected';
        currentQR = null;

        // D. Responder RÁPIDO al frontend
        res.json({ ok: true });

        // E. Reiniciar proceso para generar nuevo QR automáticamente
        setTimeout(() => {
            console.log("🔄 Reiniciando bot para generar nuevo QR...");
            connectToWhatsApp();
        }, 2000);

    } catch (error) {
        console.error("Error fatal en logout:", error);
        res.status(500).json({ error: 'Error al cerrar sesión' });
    }
});

// 3. ENVIAR TEXTO
app.post('/enviar-mensaje', async (req, res) => {
    const { numero, mensaje } = req.body;
    
    if (!sock) return res.status(503).json({ error: 'Bot desconectado' });

    try {
        const numeroFinal = formatearNumero(numero);
        const id = numeroFinal + '@s.whatsapp.net';

        console.log(`[TEXTO] Enviando a: ${id}`);
        await sock.sendMessage(id, { text: mensaje });
        res.json({ok: true});
    } catch (error) {
        console.error("Error envío texto:", error);
        res.status(500).json({error: 'Error enviando'});
    }
});

// 4. ENVIAR MULTIMEDIA (IMAGEN)
app.post('/enviar-mensaje-media', upload.single('media'), async (req, res) => {
    const { numero, mensaje } = req.body;
    const file = req.file;

    if (!sock) return res.status(503).json({ error: 'Bot desconectado' });
    if (!numero || !file) return res.status(400).json({ error: 'Faltan datos' });

    try {
        const numeroFinal = formatearNumero(numero);
        const id = numeroFinal + '@s.whatsapp.net';
        
        console.log(`[MEDIA] Enviando a: ${id}`);
        
        await sock.sendMessage(id, { 
            image: file.buffer, 
            caption: mensaje 
        });
        
        res.json({ ok: true });
    } catch (e) {
        console.error("Error media:", e);
        res.status(500).json({ error: 'Error enviando imagen' });
    }
});

app.listen(3000, () => console.log('Bot listo en puerto 3000'));