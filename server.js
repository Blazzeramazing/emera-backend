const express = require('express');
const cors = require('cors');
const yts = require('yt-search');
const ytdl = require('@distube/ytdl-core');
const https = require('https');
const http = require('http');

const app = express();

// Previne que o Railway crashe por causa de erros de terceiros
process.on('uncaughtException', (err) => console.error('[CRITICAL]', err.message));
process.on('unhandledRejection', (reason) => console.error('[CRITICAL]', reason));

app.use(cors({ origin: '*' }));

// --- ROTA 1: PESQUISA ---
app.get('/search', async (req, res) => {
    const query = req.query.q;
    if (!query) return res.status(400).json({ error: 'Digite o nome da música.' });

    try {
        const r = await yts(query + ' official audio');
        const videos = r.videos.slice(0, 15);
        const formattedResults = videos.map(v => ({
            id: v.videoId,
            name: v.title,
            image: [{ quality: '500x500', link: v.thumbnail }],
            downloadUrl: [{ quality: '320kbps', link: v.videoId }],
            artists: { primary: [{ name: v.author.name }] }
        }));
        res.json({ data: { results: formattedResults } });
    } catch (error) {
        res.status(500).json({ error: 'Erro ao pesquisar' });
    }
});

const fetchWithTimeout = (url, options = {}, timeout = 3000) => {
    return Promise.race([
        fetch(url, options),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), timeout))
    ]);
};

// --- FUNÇÃO MÁGICA: TÚNEL NATIVO INTELIGENTE ---
// Retorna 'piped' se comprometeu a resposta ao cliente, ou 'failed_clean' se pudermos tentar outra API
function pipeViaNative(url, req, res, referer = '') {
    return new Promise((resolve) => {
        let headersCommitted = false;
        const client = url.startsWith('https') ? https : http;
        
        const headers = { 
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            'Accept': '*/*'
        };
        if (referer) headers['Referer'] = referer;
        
        // Repassa os Range Headers para permitir avançar/recuar a música perfeitamente
        if (req && req.headers && req.headers.range) {
            headers['Range'] = req.headers.range;
        }

        const request = client.get(url, { headers: headers }, (streamRes) => {
            // Lidar com redirecionamentos (muito comum nas APIs)
            if (streamRes.statusCode >= 300 && streamRes.statusCode < 400 && streamRes.headers.location) {
                streamRes.resume(); // Liberta a memória do redirecionamento
                let redirectUrl = streamRes.headers.location;
                if (!redirectUrl.startsWith('http')) {
                    const urlObj = new URL(url);
                    redirectUrl = `${urlObj.protocol}//${urlObj.host}${redirectUrl}`;
                }
                return resolve(pipeViaNative(redirectUrl, req, res, referer)); 
            }
            
            // Rejeita erros da API alvo e páginas bloqueadas
            if (streamRes.statusCode !== 200 && streamRes.statusCode !== 206) {
                streamRes.resume(); 
                return resolve('failed_clean');
            }
            
            // Proteger contra páginas HTML ou JSON disfarçadas de áudio (O Bug dos 15KB)
            const contentType = streamRes.headers['content-type'] || '';
            if (contentType.includes('text/html') || contentType.includes('application/json')) {
                streamRes.resume();
                return resolve('failed_clean');
            }

            // Iniciar Transmissão Segura
            if (!res.headersSent) {
                res.setHeader('Access-Control-Allow-Origin', '*');
                res.setHeader('Content-Type', contentType.includes('audio') || contentType.includes('video') ? contentType : 'audio/mpeg');
                if (streamRes.headers['content-length']) res.setHeader('Content-Length', streamRes.headers['content-length']);
                if (streamRes.headers['content-range']) res.setHeader('Content-Range', streamRes.headers['content-range']);
                res.setHeader('Accept-Ranges', 'bytes');
                res.status(streamRes.statusCode); 
                headersCommitted = true;
            }

            // Conecta a mangueira de áudio
            streamRes.pipe(res);
            
            streamRes.on('end', () => resolve('piped'));
            streamRes.on('error', () => { 
                // Se a ligação quebrar a meio, fechamos a torneira para o navegador tentar pedir o resto depois!
                res.end(); 
                resolve('piped'); 
            }); 
        });
        
        request.on('error', () => resolve(headersCommitted ? 'piped' : 'failed_clean'));
        // Timeout anti-travagem (Se o servidor encravar 4 segundos sem dados, corta e testa o próximo)
        request.setTimeout(4000, () => { 
            request.destroy(); 
            resolve(headersCommitted ? 'piped' : 'failed_clean'); 
        });
    });
}

// --- ROTA 2: RESOLVEDOR DE STREAM (PROXY DE 4 CAMADAS) ---
app.get('/stream', async (req, res) => {
    const videoId = req.query.url; 
    if (!videoId) return res.status(400).send('ID ausente');
    
    // Suporte a Preflight CORS exigido pelos navegadores
    if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');
        return res.status(200).end();
    }

    // Ligações diretas / Fallback Offline
    if (videoId.startsWith('http')) {
        const status = await pipeViaNative(videoId, req, res);
        if (status === 'failed_clean' && !res.headersSent) res.redirect(videoId);
        return;
    }

    // LAYER 1: COBALT API (Ultra-Rápido, Nova Tecnologia)
    try {
        const cobaltRes = await fetchWithTimeout("https://api.cobalt.tools/api/json", {
            method: "POST",
            headers: {
                "Accept": "application/json",
                "Content-Type": "application/json",
                "User-Agent": "EmeraPlayer/1.0"
            },
            body: JSON.stringify({
                url: `https://www.youtube.com/watch?v=${videoId}`,
                isAudioOnly: true
            })
        }, 3000);
        
        if (cobaltRes.ok) {
            const data = await cobaltRes.json();
            if (data && data.url) {
                const status = await pipeViaNative(data.url, req, res);
                if (status === 'piped') return; // Se comprometeu, pára de tentar outros!
            }
        }
    } catch(e) {}

    // LAYER 2: INVIDIOUS API (Com Bypass Local de Proxy Integrado)
    const invidiousInstances = [
        "https://inv.tux.pizza",
        "https://invidious.jing.rocks",
        "https://invidious.nerdvpn.de",
        "https://invidious.lunar.icu",
        "https://invidious.slipfox.xyz",
        "https://inv.nadeko.net"
    ];
    for (const api of invidiousInstances) {
        // local=true obriga a instância a mascarar o nosso IP!
        const proxyUrl = `${api}/latest_version?id=${videoId}&itag=140&local=true`;
        const status = await pipeViaNative(proxyUrl, req, res);
        if (status === 'piped') return;
    }

    // LAYER 3: PIPED API
    const pipedInstances = [
        "https://pipedapi.kavin.rocks",
        "https://pipedapi.smnz.de",
        "https://piped-api.lunar.icu"
    ];
    for (const api of pipedInstances) {
        try {
            const reqFetch = await fetchWithTimeout(`${api}/streams/${videoId}`, {}, 2500);
            if (!reqFetch.ok) continue;
            const data = await reqFetch.json();
            const format = data.audioStreams?.find(s => s.mimeType?.includes('audio/mp4')) || data.audioStreams?.[0];
            if (format && format.url) {
                const urlObj = new URL(api);
                const referer = `https://${urlObj.host.replace('pipedapi', 'piped')}/`;
                const status = await pipeViaNative(format.url, req, res, referer);
                if (status === 'piped') return;
            }
        } catch(e) {}
    }

    // LAYER 4: YTDL-CORE (Local nativo)
    try {
        const info = await Promise.race([
            ytdl.getInfo(`https://www.youtube.com/watch?v=${videoId}`),
            new Promise((_, r) => setTimeout(() => r(new Error('Timeout')), 4000))
        ]);
        const format = ytdl.chooseFormat(info.formats, { quality: 'highestaudio', filter: 'audioonly' });
        if (format && format.url) {
            const status = await pipeViaNative(format.url, req, res);
            if (status === 'piped') return;
        }
    } catch (e) {}

    // SE ABSOLUTAMENTE TUDO FALHOU E AINDA NÃO ENVIÁMOS NADA
    if (!res.headersSent) {
        res.status(500).send('Bloqueio Massivo detectado. Tente novamente mais tarde.');
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Backend Supremo (Com Prevenção de Concatenação) rodando na porta ${PORT}`);
});
