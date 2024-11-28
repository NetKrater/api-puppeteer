require('dotenv').config()
const puppeteer = require('puppeteer');
const fs = require('fs');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

// Inicialización de la aplicación
const app = express(); // Inicializar express
app.use(cors()); // Habilitar CORS para todas las rutas de Express

// Variables originales
let ultimoTiempo = null; // Variable para almacenar el último tiempo procesado

// Configuración del servidor Express y WebSocket
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;
const io = require('socket.io')(server, {
    cors: {
        origin: "*", // Permitir todos los orígenes. En producción, cambia "*" por el dominio permitido.
        methods: ["GET", "POST"]
    },
    pingInterval: 25000, // Enviar un ping cada 25 segundos
    pingTimeout: 60000, // Esperar 60 segundos antes de considerar desconectado
    allowEIO3: true, // Habilitar compatibilidad con versiones antiguas del cliente
});

let coeficienteActual = null; // Último coeficiente extraído

// Endpoint para API REST
app.get('/api/coeficiente', (req, res) => {
    if (coeficienteActual) {
        res.json(coeficienteActual);
    } else {
        res.status(404).json({ error: 'No hay datos disponibles' });
    }
});

// Configurar WebSocket
io.on('connection', (socket) => {
    console.log('Cliente conectado al WebSocket.');
    
    // Enviar ping para mantener conexión activa
    socket.emit('ping', 'Manteniendo la conexión activa');

    socket.on('disconnect', () => {
        console.log('Cliente desconectado del WebSocket.');
    });
});

// Función para enviar datos a WebSocket
const enviarDatos = (dato) => {
    io.emit('nuevoDato', dato);
};

// Función para guardar cookies
const guardarCookies = async (page) => {
    const cookies = await page.cookies();
    fs.writeFileSync('./cookies.json', JSON.stringify(cookies, null, 2));
    console.log('Cookies guardadas.');
};

// Función para cargar cookies
const cargarCookies = async (page) => {
    if (fs.existsSync('./cookies.json')) {
        const cookies = JSON.parse(fs.readFileSync('./cookies.json'));
        await page.setCookie(...cookies);
        console.log('Cookies cargadas.');
    }
};

// Función para extraer datos del segundo elemento
const obtenerSegundoElemento = async (frame, selector) => {
    try {
        const elementos = await frame.$$(selector);
        if (elementos.length < 2) return null;

        const segundoElemento = elementos[1];
        const texto = await frame.evaluate(el => el.textContent.trim(), segundoElemento);
        const dataInfo = await frame.evaluate(el => el.getAttribute('data-info'), segundoElemento);
        const data = JSON.parse(dataInfo.replace(/&quot;/g, '"'));

        // Filtrar valores no válidos (e.g., tiempo "JUEGO ACTUAL")
        if (data.SpinTime === 'JUEGO ACTUAL') {
            return null; // Ignorar valores con tiempo no válido
        }

        return {
            texto,
            coeficiente: data.Coefficient,
            tiempo: data.SpinTime,
        };
    } catch (error) {
        console.error('Error obteniendo datos del segundo elemento:', error);
        return null;
    }
};

// Función para navegar al juego
const navegarAlJuego = async (browser) => {
    const page = await browser.newPage();
    await page.setViewport({ width: 980, height: 1020 });

    try {
        console.log('Accediendo a BetPlay...');
        await page.goto('https://betplay.com.co/', { waitUntil: 'domcontentloaded' });

        // Cargando cookies y verificando acceso
console.log('Cargando cookies...');
await cargarCookies(page);

console.log('Verificando acceso...');
await page.reload({ waitUntil: 'domcontentloaded' });

// Verificar si la página requiere inicio de sesión
try {
    await page.waitForSelector('#userName', { visible: true, timeout: 20000 });
    console.log('Iniciando sesión manualmente...');
    
    // Llenar campos de usuario y contraseña
    await page.type('#userName', '45449570');
    await page.type('#password', '3138122109V#');
    
    // Hacer clic en el botón de inicio de sesión
    await Promise.all([
        page.click('#btnLoginPrimary'),
        page.waitForNavigation({ waitUntil: 'domcontentloaded' })
    ]);

    console.log('Sesión iniciada.');
    await guardarCookies(page);
} catch (error) {
    if (error.name === 'TimeoutError') {
        console.log('Usuario ya autenticado o elemento #userName no encontrado.');
    } else {
        console.error('Error durante la autenticación manual:', error.message);
        await browser.close();
        process.exit(1);
    }
}

        console.log('Accediendo al juego JetX...');
        await page.goto('https://betplay.com.co/slots/launchGame?gameCode=SMS_JetX&flashClient=true&additionalParam=&integrationChannelCode=PARIPLAY', { waitUntil: 'domcontentloaded' });

        console.log('Esperando el marco del juego...');
        let intentos = 0;
        let frame = null;

        while (!frame && intentos < 10) {
            console.log(`Intento ${intentos + 1} para encontrar el frame...`);
            const frames = await page.frames();
            frame = frames.find(f => f.url().includes('JetXNode31/JetXLight/Board.aspx'));
            if (!frame) {
                await page.reload({ waitUntil: 'domcontentloaded' });
                await new Promise(resolve => setTimeout(resolve, 20000));
                intentos++;
            }
        }

        if (!frame) throw new Error('Frame del juego JetX no encontrado después de varios intentos.');
        console.log('Frame encontrado. Listo para extraer datos.');
        return { page, frame };
    } catch (error) {
        console.error(`Error durante la navegación: ${error.message}`);
        await browser.close();
        process.exit(1);
    }
};

// Extraer datos periódicamente
const resultado2 = async (frame) => {
    try {
        const selector = 'div[data-info]';
        const datos = await obtenerSegundoElemento(frame, selector);

        if (datos && datos.tiempo !== ultimoTiempo) {
            console.log('Nuevo valor extraído:', datos);
            ultimoTiempo = datos.tiempo;
            coeficienteActual = datos; // Actualizar coeficiente actual
            enviarDatos(datos); // Enviar datos al WebSocket
        }
    } catch (error) {
        console.error('Error extrayendo datos:', error);
    }
};

// Ejecución principal
(async () => {
    const browser = await puppeteer.launch({
        headless: true, // Cambiar a true para producción
        userDataDir: './user_data' // Mantener sesión activa
    });

    const { frame } = await navegarAlJuego(browser);

    setInterval(async () => {
        await resultado2(frame);
    }, 2000);

    server.listen(PORT, '0.0.0.0', () => {
        console.log(`Servidor escuchando en http://0.0.0.0:${PORT}`);
    });

    process.on('SIGINT', async () => {
        console.log('Cerrando navegador...');
        await browser.close();
        process.exit();
    });
})();
