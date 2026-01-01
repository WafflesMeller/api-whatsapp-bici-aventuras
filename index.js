const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const express = require('express');
const qrcode = require('qrcode-terminal'); // Opcional si ya no lo quieres ver en consola
const pino = require('pino');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs'); // <--- NUEVO: Para borrar credenciales al salir
const path = require('path');

const app = express();
app.use(express.json());
app.use(cors());

// Configuración de Multer
const upload = multer({ storage: multer.memoryStorage() });

// --- VARIABLES GLOBALES DE ESTADO ---
let sock;
let status = 'disconnected'; // 'disconnected' | 'connecting' | 'connected'
let qrCode = null;           // Aquí guardaremos el string del QR

// Función para limpiar la carpeta de sesión (Logout real)
const clearAuthFolder = () => {
    const authPath = path.resolve(__dirname, 'auth_info_baileys');
    if (fs.existsSync(authPath)) {
        fs.rmSync(authPath, { recursive: true, force: true });
    }
};

async function connectToWhatsApp() {
    // Intentando conectar
    status = 'connecting';
    
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    sock = makeWASocket({
        auth: state,
        printQRInTerminal: true, // Lo dejamos en true por si quieres debugear en Render
        logger: pino({ level: 'silent' }),
        browser: ["BiciAventuras", "Chrome", "1.0.0"] // Para que se vea bonito en WhatsApp
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            // ¡NUEVO! Guardamos el QR en la variable para el frontend
            qrCode = qr;
            status = 'disconnected'; // Si hay QR, es que estamos desconectados
            console.log('NUEVO QR GENERADO');
        }

        if (connection === 'close') {
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
            
            status = 'disconnected';
            qrCode = null;

            if (shouldReconnect) {
                connectToWhatsApp();
            } else {
                console.log('Desconectado. Esperando reinicio manual o nueva solicitud.');
                // Si fue un logout intencional, no reconectamos automáticamente
            }
        } else if (connection === 'open') {
            console.log('¡CONEXIÓN EXITOSA!');
            status = 'connected';
            qrCode = null; // Ya no necesitamos el QR
        }
    });

    sock.ev.on('creds.update', saveCreds);
}

// Iniciamos la conexión al arrancar
connectToWhatsApp();

// --- FUNCIÓN AUXILIAR FORMATO ---
const formatNumber = (numero) => {
    let numeroLimpio = numero.replace(/\D/g, '');
    if (numeroLimpio.startsWith('0')) {
        numeroLimpio = '58' + numeroLimpio.substring(1);
    }
    return `${numeroLimpio}@s.whatsapp.net`;
};

// ==========================================
//      NUEVOS ENDPOINTS PARA EL FRONTEND
// ==========================================

// 1. Obtener Estado y QR
app.get('/status', (req, res) => {
    res.json({
        status: status,
        qr: qrCode
    });
});

// 2. Cerrar Sesión (Logout)
app.post('/logout', async (req, res) => {
    try {
        if (sock) {
            await sock.logout(); // Cierra sesión en WS
            sock.end(undefined); // Cierra el socket
        }
        
        // Borramos la carpeta de credenciales para forzar un QR nuevo
        clearAuthFolder();
        
        status = 'disconnected';
        qrCode = null;
        
        // Reiniciamos el proceso para generar un nuevo QR inmediatamente
        connectToWhatsApp();

        res.json({ message: 'Sesión cerrada correctamente' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error al cerrar sesión' });
    }
});

// ==========================================
//          ENDPOINTS DE MENSAJERÍA
// ==========================================

app.post('/enviar-mensaje', async (req, res) => {
    const { numero, mensaje } = req.body;
    if (!numero || !mensaje) return res.status(400).json({ error: 'Faltan datos' });

    try {
        if (status !== 'connected' || !sock) return res.status(500).json({ error: 'Bot desconectado' });

        const idWhatsapp = formatNumber(numero);
        const [onWhatsApp] = await sock.onWhatsApp(idWhatsapp);
        
        if (!onWhatsApp || !onWhatsApp.exists) {
             return res.status(404).json({ error: 'El número no tiene WhatsApp' });
        }

        await sock.sendMessage(idWhatsapp, { text: mensaje });
        res.json({ status: 'ok' });

    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: 'Error interno' });
    }
});

app.post('/enviar-mensaje-media', upload.single('media'), async (req, res) => {
    const { numero, mensaje } = req.body;
    const file = req.file;

    if (!numero || !file) return res.status(400).json({ error: 'Faltan datos' });

    try {
        if (status !== 'connected' || !sock) return res.status(500).json({ error: 'Bot desconectado' });
        const idWhatsapp = formatNumber(numero);

        await sock.sendMessage(idWhatsapp, { 
            image: file.buffer, 
            caption: mensaje || '' 
        });

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