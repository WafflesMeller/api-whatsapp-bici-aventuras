const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const express = require('express');
const qrcode = require('qrcode-terminal');
const pino = require('pino');

const app = express();
app.use(express.json()); // Para que entienda los datos que le manda Vercel

let sock; // Aquí guardaremos la conexión

async function connectToWhatsApp() {
    // 1. Crear/Cargar la sesión
    // Esto crea una carpeta 'auth_info_baileys' donde guarda las credenciales
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    // 2. Iniciar el socket (el cliente de WA)
    sock = makeWASocket({
        auth: state,
        printQRInTerminal: true, // ¡Importante! Imprime el QR en la consola de Render
        logger: pino({ level: 'silent' }) // Para que no llene la consola de basura
    });

    // 3. Manejar eventos de conexión (Si se cae, reconecta)
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('⚠️ ESCANEA EL CÓDIGO QR DE ARRIBA CON TU WHATSAPP');
        }

        if (connection === 'close') {
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Conexión cerrada por:', lastDisconnect.error, ', reconectando...', shouldReconnect);
            if (shouldReconnect) {
                connectToWhatsApp();
            }
        } else if (connection === 'open') {
            console.log('✅ ¡CONEXIÓN EXITOSA! EL BOT ESTÁ LISTO.');
        }
    });

    // 4. Guardar credenciales cada vez que cambian
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

// Arrancar el servidor Express
const port = process.env.PORT || 3000;
app.listen(port, () => {
    console.log(`Servidor API escuchando en puerto ${port}`);
});