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

    if (sock?.ws?.readyState === 1) {
        log('WARNING', '⚠️ Socket activo detectado, evitando doble conexión');
        return;
    }
    
    status = 'connecting';
    
    // 1. Obtener última versión de Baileys para evitar bugs antiguos
    const { version, isLatest } = await fetchLatestBaileysVersion();
    log('INFO', `Usando WA v${version.join('.')}, ¿Es la última?: ${isLatest}`);

    // 2. Cargar estado
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    // 3. Configuración ROBUSTA del Socket
    sock = makeWASocket({
        version,
        auth: {
            creds: state.creds,
            // Usamos caché para las llaves, esto evita lecturas de disco constantes en Render
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" })),
        },
        printQRInTerminal: true, 
        logger: pino({ level: 'silent' }), 
        browser: ["BiciAventuras Bot", "Chrome", "120.0.0"], // Navegador moderno simulado
        
        // --- BLINDAJE DE CONEXIÓN ---
        connectTimeoutMs: 60000, 
        keepAliveIntervalMs: 30000, // Ping cada 30s para que no se caiga
        retryRequestDelayMs: 2000,  // Espera un poco antes de reintentar peticiones fallidas
        msgRetryCounterCache,       // Maneja mensajes fallidos sin desconectar
        generateHighQualityLinkPreview: true,
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            qrCode = qr;
            status = 'disconnected';
            log('WARNING', '🔍 QR Generado. Escanea para vincular.');
        }

        if (connection === 'close') {
            const error = lastDisconnect?.error;
            const statusCode = error?.output?.statusCode;
            
            status = 'disconnected';
            qrCode = null;

            log('ERROR', `Conexión cerrada. Código: ${statusCode} | Razón: ${error?.message || 'Desconocida'}`);

            // --- LÓGICA INTELIGENTE DE RECONEXIÓN ---
            
            // CASO 1: Logged Out (401) -> EL ÚNICO CASO DONDE BORRAMOS
            if (statusCode === DisconnectReason.loggedOut) {
                const msg = error?.message?.toLowerCase() || '';

                // 🔒 SOLO borrar sesión si ES logout REAL
                if (msg.includes('logged out')) {
                    log('CRITICAL', '⛔ Logout REAL detectado. Limpiando sesión...');
                    clearAuthFolder();
                    setTimeout(connectToWhatsApp, 3000);
                } else {
                    // ⚠️ Conflict / stream error / cambio de cuenta / red
                    log('WARNING', '⚠️ 401 Conflict detectado. NO es logout real. Reintentando sin borrar sesión...');
                    setTimeout(connectToWhatsApp, 3000);
                }
            }

            // CASO 2: Restart Required (515) -> SÚPER COMÚN, NO ES ERROR GRAVE
            else if (statusCode === DisconnectReason.restartRequired) {
                log('INFO', '🔄 Reinicio requerido por WhatsApp (Normal). Reconectando inmediatamente...');
                connectToWhatsApp();
            }
            // CASO 3: Timed Out (408) o Connection Lost (440/500)
            else {
                log('NETWORK', '⚠️ Pérdida de conexión temporal. Reintentando en 2s...');
                setTimeout(connectToWhatsApp, 2000);
            }
        } 
        
        else if (connection === 'open') {
            log('SUCCESS', '🚀 ¡CONEXIÓN ESTABILIZADA! (Keep-Alive Activo)');
            status = 'connected';
            qrCode = null;
        }
    });

    // Guardar credenciales solo cuando cambian
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