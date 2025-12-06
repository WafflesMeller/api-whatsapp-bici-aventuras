const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const express = require('express');
const qrcode = require('qrcode-terminal');
const pino = require('pino');
const cors = require('cors'); // <--- NUEVO: Importar cors

const app = express();
app.use(express.json()); // Para que entienda los datos que le manda Vercel
app.use(cors()); // <--- NUEVO: Usar cors para permitir solicitudes desde cualquier origen
let sock; // Aquí guardaremos la conexión

async function connectToWhatsApp() {
    // 1. Crear/Cargar la sesión
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    // 2. Iniciar el socket
    sock = makeWASocket({
        auth: state,
        printQRInTerminal: false, // <--- CAMBIO 1: Lo ponemos en false
        logger: pino({ level: 'silent' })
    });

    // 3. Manejar eventos de conexión
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('⚠️ ESCANEA EL CÓDIGO QR ABAJO CON TU WHATSAPP:');
            // <--- CAMBIO 2: Dibujamos el QR manualmente
            qrcode.generate(qr, { small: true }); 
        }

        if (connection === 'close') {
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Conexión cerrada, reconectando...', shouldReconnect);
            if (shouldReconnect) {
                connectToWhatsApp();
            }
        } else if (connection === 'open') {
            console.log('✅ ¡CONEXIÓN EXITOSA! EL BOT ESTÁ LISTO.');
        }
    });

    // 4. Guardar credenciales
    sock.ev.on('creds.update', saveCreds);
}

// Iniciar la conexión al arrancar
connectToWhatsApp();

// --- API ENDPOINT (Lo que llamará tu Web de Rifas) ---
app.post('/enviar-mensaje', async (req, res) => {
    const { numero, mensaje } = req.body;

    if (!numero || !mensaje) {
        return res.status(400).json({ error: 'Faltan datos (numero o mensaje)' });
    }

    try {
        // Formatear el número: Baileys necesita formato internacional sin '+'
        // Ejemplo: 584121234567@s.whatsapp.net
        let numeroLimpio = numero.replace(/\D/g, ''); // Quita todo lo que no sea número
        
        // Ajuste manual para Venezuela si el usuario manda 0412...
        if (numeroLimpio.startsWith('0')) {
            numeroLimpio = '58' + numeroLimpio.substring(1);
        }

        const idWhatsapp = `${numeroLimpio}@s.whatsapp.net`;

        // Validar si el socket existe
        if (!sock) {
            return res.status(500).json({ error: 'El bot no está conectado todavía' });
        }

        // Verificar si el número tiene Whatsapp (Opcional, pero recomendado)
        const [onWhatsApp] = await sock.onWhatsApp(idWhatsapp);
        if (!onWhatsApp || !onWhatsApp.exists) {
             return res.status(404).json({ error: 'El número no tiene WhatsApp' });
        }

        // Enviar
        await sock.sendMessage(idWhatsapp, { text: mensaje });
        console.log(`Mensaje enviado a ${numeroLimpio}`);
        
        res.json({ status: 'ok', mensaje: 'Mensaje enviado' });

    } catch (error) {
        console.error('Error enviando:', error);
        res.status(500).json({ error: 'Error interno al enviar mensaje' });
    }
});

// Ruta base para mantener vivo el servidor
app.get('/', (req, res) => {
    res.send('EL BOT ESTÁ VIVO 🤖');
});

// Arrancar el servidor Express
const port = process.env.PORT || 3000;
app.listen(port, () => {
    console.log(`Servidor API escuchando en puerto ${port}`);
});