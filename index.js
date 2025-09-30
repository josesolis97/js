const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const net = require('net');
const dgram = require('dgram');
const fs = require('fs');

// === CONFIGURACIÓN ===
const IP = '0.0.0.0';
const PORT = 6000;
const COUNTRY_CODE = '549'; // Argentina

// 👤 TU número (super-admin)
const SUPER_ADMIN_PHONE = '1156511894';
const SUPER_ADMIN_JID = `${COUNTRY_CODE}${SUPER_ADMIN_PHONE}@s.whatsapp.net`;

const NOTIF_FILE = './numeros_notif.json';
const NOMBRES_FILE = './nombres_imei.json';
const LOG_FILE = './logs.txt';
const RECONNECT_INTERVAL = 5000;

// === Mapeo de entradas a nombres descriptivos ===
const INPUT_NAMES = {
    in1: "Tamper Antidesarme",
    in2: "Caja fuerte",
    in3: "Sala de servidores"
};

// === Cargar números de notificación ===
let WA_NUMBERS = [];
function cargarNumeros() {
    if (fs.existsSync(NOTIF_FILE)) {
        try {
            const numeros = JSON.parse(fs.readFileSync(NOTIF_FILE, 'utf8'));
            if (Array.isArray(numeros)) {
                WA_NUMBERS = numeros.map(num => 
                    (num.startsWith(COUNTRY_CODE) ? num : `${COUNTRY_CODE}${num}`) + '@s.whatsapp.net'
                );
                log(`✅ ${WA_NUMBERS.length} números cargados`);
                return;
            }
        } catch (e) {
            log(`⚠️ Error en ${NOTIF_FILE}, usando predeterminado.`);
        }
    }
    WA_NUMBERS = [SUPER_ADMIN_JID];
    guardarNumeros();
}

function guardarNumeros() {
    const simples = WA_NUMBERS.map(jid => jid.replace('@s.whatsapp.net', '').replace(COUNTRY_CODE, ''));
    fs.writeFileSync(NOTIF_FILE, JSON.stringify(simples, null, 2));
    log(`💾 Números guardados: ${simples.join(', ')}`);
}

// === Cargar nombres de sucursales por IMEI ===
let NOMBRES_IMEI = {};
function cargarNombresIMEI() {
    if (fs.existsSync(NOMBRES_FILE)) {
        try {
            NOMBRES_IMEI = JSON.parse(fs.readFileSync(NOMBRES_FILE, 'utf8'));
            log(`✅ ${Object.keys(NOMBRES_IMEI).length} sucursales cargadas`);
        } catch (e) {
            log(`⚠️ Error en ${NOMBRES_FILE}, empezando vacío.`);
            NOMBRES_IMEI = {};
        }
    }
}

function guardarNombresIMEI() {
    fs.writeFileSync(NOMBRES_FILE, JSON.stringify(NOMBRES_IMEI, null, 2));
    log(`💾 Nombres de sucursales guardados`);
}

function getNombreSucursal(imei) {
    return NOMBRES_IMEI[imei] || `Dispositivo ${imei}`;
}

// === Logger ===
function log(msg) {
    const linea = `[${new Date().toISOString()}] ${msg}\n`;
    console.log(linea.trim());
    if (!fs.existsSync(LOG_FILE)) fs.writeFileSync(LOG_FILE, '');
    fs.appendFileSync(LOG_FILE, linea);
}

// === Estado de entradas ===
let lastInputState = { in1: null, in2: null, in3: null };

// === WhatsApp ===
let sock;

async function iniciarWhatsApp() {
    try {
        const { state, saveCreds } = await useMultiFileAuthState('./auth_info');
        sock = makeWASocket({
            auth: state,
            printQRInTerminal: true,
            browser: ['Ubuntu', 'Chrome', '20.0.04'],
            defaultQueryTimeoutMs: 60000,
            keepAliveIntervalMs: 10000,
            connectTimeoutMs: 60000
        });

        sock.ev.on('creds.update', saveCreds);
        
        sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect } = update;
            if (connection === 'close') {
                const motivo = lastDisconnect?.error?.output?.statusCode;
                log(`❌ Conexión WhatsApp cerrada. Motivo: ${motivo || 'desconocido'}`);
                if (motivo !== DisconnectReason.loggedOut) {
                    log('♻️ Reintentando en 5s...');
                    setTimeout(iniciarWhatsApp, RECONNECT_INTERVAL);
                } else {
                    log('⚠️ Sesión cerrada. Borra ./auth_info y escanea QR.');
                }
            } else if (connection === 'open') {
                log('✅ Conectado a WhatsApp Web');
                setTimeout(() => {
                    enviarWhatsAppDirecto(SUPER_ADMIN_JID, '🟢 Sistema Caja de Audio activo.');
                }, 3000);
            }
        });

        // === Comandos de administración ===
        sock.ev.on('messages.upsert', async ({ messages, type }) => {
            if (type !== 'notify') return;
            const msg = messages[0];
            const from = msg.key.remoteJid;
            const body = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';

            if (from !== SUPER_ADMIN_JID) return;

            // Gestión de números
            if (body.startsWith('+admin ')) {
                const raw = body.replace('+admin ', '').trim();
                if (/^\d{7,12}$/.test(raw)) {
                    const jid = `${COUNTRY_CODE}${raw}@s.whatsapp.net`;
                    if (!WA_NUMBERS.includes(jid)) {
                        WA_NUMBERS.push(jid);
                        guardarNumeros();
                        await enviarWhatsAppDirecto(from, `✅ ${raw} agregado a notificaciones.`);
                    } else {
                        await enviarWhatsAppDirecto(from, `ℹ️ ${raw} ya está en la lista.`);
                    }
                } else {
                    await enviarWhatsAppDirecto(from, `❌ Formato: +admin 1156511800`);
                }
            } else if (body.startsWith('-admin ')) {
                const raw = body.replace('-admin ', '').trim();
                const jid = `${COUNTRY_CODE}${raw}@s.whatsapp.net`;
                const i = WA_NUMBERS.indexOf(jid);
                if (i >= 0) {
                    WA_NUMBERS.splice(i, 1);
                    guardarNumeros();
                    await enviarWhatsAppDirecto(from, `🗑️ ${raw} eliminado.`);
                } else {
                    await enviarWhatsAppDirecto(from, `⚠️ ${raw} no está en la lista.`);
                }
            } else if (body.trim().toLowerCase() === 'lista') {
                const nums = WA_NUMBERS.map(j => j.replace('@s.whatsapp.net', '').replace(COUNTRY_CODE, ''));
                await enviarWhatsAppDirecto(from, `📱 Números notificados:\n${nums.join(', ') || 'ninguno'}`);
            }

            // Gestión de nombres de sucursales
            else if (body.startsWith('+nombre ')) {
                const partes = body.substring(8).trim().split(' ');
                if (partes.length < 2) {
                    await enviarWhatsAppDirecto(from, `❌ Usa: +nombre <IMEI> <Nombre>`);
                    return;
                }
                const imei = partes[0];
                const nombre = partes.slice(1).join(' ');
                NOMBRES_IMEI[imei] = nombre;
                guardarNombresIMEI();
                await enviarWhatsAppDirecto(from, `✅ Registrado: ${nombre} (${imei})`);
            }

            else if (body.startsWith('-nombre ')) {
                const imei = body.substring(8).trim();
                if (NOMBRES_IMEI[imei]) {
                    delete NOMBRES_IMEI[imei];
                    guardarNombresIMEI();
                    await enviarWhatsAppDirecto(from, `🗑️ Nombre eliminado: ${imei}`);
                } else {
                    await enviarWhatsAppDirecto(from, `⚠️ IMEI no registrado: ${imei}`);
                }
            }

            else if (body.trim().toLowerCase() === 'nombres') {
                if (Object.keys(NOMBRES_IMEI).length === 0) {
                    await enviarWhatsAppDirecto(from, `📭 Sin sucursales registradas.`);
                } else {
                    let lista = '🏦 Sucursales monitoreadas:\n';
                    for (const [imei, nombre] of Object.entries(NOMBRES_IMEI)) {
                        lista += `\n• ${nombre}\n  (${imei})`;
                    }
                    await enviarWhatsAppDirecto(from, lista);
                }
            }
        });

    } catch (error) {
        log(`❌ Error iniciando WhatsApp: ${error.message}`);
        setTimeout(iniciarWhatsApp, RECONNECT_INTERVAL);
    }
}

// === Enviar WhatsApp directo ===
async function enviarWhatsAppDirecto(jid, mensaje) {
    if (!sock) return;
    try {
        await sock.sendMessage(jid, { text: mensaje });
        log(`➡️ WhatsApp a ${jid}: ${mensaje}`);
    } catch (e) {
        log(`❌ Error a ${jid}: ${e.message}`);
    }
}

// === Enviar a todos los números ===
async function enviarWhatsApp(mensaje) {
    if (!sock) return;
    for (const jid of WA_NUMBERS) {
        try {
            await sock.sendMessage(jid, { text: mensaje });
            log(`➡️ Alerta enviada a ${jid}`);
            await new Promise(r => setTimeout(r, 800));
        } catch (e) {
            log(`❌ Error a ${jid}: ${e.message}`);
        }
    }
}

// === Parser de mensajes GV300 ===
function parseGV300Message(message) {
    const msgStr = message.toString().trim();
    if (msgStr.includes('GTDIS')) {
        const parts = msgStr.split(',');
        const code = parseInt(parts[5]); // 10,11,20,21,30,31
        const imei = parts[2] || 'N/A';

        let input = null;
        let state = null;

        if (code === 10 || code === 11) {
            input = 'in1';
            state = (code === 11);
        } else if (code === 20 || code === 21) {
            input = 'in2';
            state = (code === 21);
        } else if (code === 30 || code === 31) {
            input = 'in3';
            state = (code === 31);
        } else {
            return null;
        }

        return { type: 'INPUT_CHANGE', input, state, imei };
    }
    return null;
}

// === Procesar eventos ===
function procesarEntradas(parsed) {
    if (!parsed) return;
    const { input, state, imei } = parsed;
    if (lastInputState[input] !== state) {
        lastInputState[input] = state;
        const sucursal = getNombreSucursal(imei);
        const entrada = INPUT_NAMES[input] || input;
        const estado = state ? 'ABIERTA' : 'CERRADA';
        const nivel = state ? '⚠️ ALERTA' : '✅ NORMAL';
        const mensaje = `${nivel}: ${entrada} ${estado}\n📍 ${sucursal}`;
        enviarWhatsApp(mensaje);
    }
}

// === SERVIDOR TCP ===
const tcpServer = net.createServer((socket) => {
    log(`📡 Conexión TCP desde ${socket.remoteAddress}:${socket.remotePort}`);
    socket.on('data', (data) => {
        const parsed = parseGV300Message(data);
        if (parsed) procesarEntradas(parsed);
        socket.write('+SACK:GTACK,0,0$');
    });
    socket.on('close', () => log('🔴 Conexión TCP cerrada'));
    socket.on('error', (err) => log(`⚠️ Error TCP: ${err.message}`));
});

// === SERVIDOR UDP ===
const udpServer = dgram.createSocket('udp4');
udpServer.on('message', (msg, rinfo) => {
    log(`📡 Mensaje UDP desde ${rinfo.address}:${rinfo.port}`);
    const parsed = parseGV300Message(msg);
    if (parsed) procesarEntradas(parsed);
});
udpServer.on('error', (err) => {
    log(`❌ Error UDP: ${err.message}`);
    udpServer.close();
});

// === INICIAR SERVIDORES ===
cargarNumeros();
cargarNombresIMEI();

tcpServer.listen(PORT, IP, () => {
    log(`🚀 Servidor TCP escuchando en ${IP}:${PORT}`);
});

udpServer.bind(PORT, IP, () => {
    log(`🚀 Servidor UDP escuchando en ${IP}:${PORT}`);
});

// === Cierre limpio ===
process.on('SIGINT', () => {
    log('\n🔸 Apagando sistema de monitoreo bancario...');
    tcpServer.close();
    udpServer.close();
    if (sock) sock.end();
    process.exit(0);
});

log('🏦 Sistema iniciado. Escuchando TCP y UDP en el puerto 6000.');
iniciarWhatsApp();
