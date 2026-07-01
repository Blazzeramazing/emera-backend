const express = require('express');
const cors = require('cors');
const yts = require('yt-search');
const ytdl = require('@distube/ytdl-core');
const https = require('https');
const http = require('http');

const app = express();

// Proteção Global contra crashes de servidor
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

// --- FUNÇÃO MÁGICA: TÚNEL NATIVO (AGORA COM SUPORTE A RANGE) ---
function pipeViaNative(url, req, res) {
    return new Promise((resolve) => {
        const client = url.startsWith('https') ? https : http;
        
        const headers = { 
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            'Accept': '*/*',
            'Connection': 'keep-alive'
        };

        // O SEGREDO DE OURO: Repassar o pedido de pedaços (Range) do navegador para a origem!
        if (req && req.headers && req.headers.range) {
            headers['Range'] = req.headers.range;
        }

        const request = client.get(url, { headers: headers }, (streamRes) => {
            // Se houver redirecionamento (muito comum em proxies)
            if (streamRes.statusCode >= 300 && streamRes.statusCode < 400 && streamRes.headers.location) {
                let redirectUrl = streamRes.headers.location;
                if (!redirectUrl.startsWith('http')) {
                    const urlObj = new URL(url);
                    redirectUrl = `${urlObj.protocol}//${urlObj.host}${redirectUrl}`;
                }
                return resolve(pipeViaNative(redirectUrl, req, res)); // Chamada recursiva
            }
            
            // Aceitar 200 (OK) e 206 (Conteúdo Parcial/Música)
            if (streamRes.statusCode !== 200 && streamRes.statusCode !== 206) {
                streamRes.resume(); 
                return resolve(false);
            }
            
            // Proteger contra páginas HTML disfarçadas
            const contentType = streamRes.headers['content-type'] || '';
            if (contentType.includes('text/html') || contentType.includes('application/json')) {
                streamRes.resume();
                return resolve(false);
            }

            // Iniciar Transmissão CORS
            if (!res.headersSent) {
                res.setHeader('Access-Control-Allow-Origin', '*');
                res.setHeader('Content-Type', contentType.includes('audio') || contentType.includes('video') ? contentType : 'audio/mpeg');
                if (streamRes.headers['content-length']) res.setHeader('Content-Length', streamRes.headers['content-length']);
                
                // Repassar a confirmação do pedaço (Content-Range) para o navegador não cancelar a ligação
                if (streamRes.headers['content-range']) res.setHeader('Content-Range', streamRes.headers['content-range']);
                
                res.setHeader('Accept-Ranges', 'bytes');
                res.status(streamRes.statusCode); 
            }

            streamRes.pipe(res);
            
            streamRes.on('end', () => resolve(true));
            streamRes.on('error', () => resolve(true)); 
        });
        
        request.on('error', () => resolve(false));
        request.setTimeout(8000, () => { request.destroy(); resolve(false); });
    });
}

const fetchWithTimeout = (url, options = {}, timeout = 5000) => {
    return Promise.race([
        fetch(url, options),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), timeout))
    ]);
};

// --- ROTA 2: RESOLVEDOR DE STREAM EXTREMO ---
app.get('/stream', async (req, res) => {
    const videoId = req.query.url; 
    if (!videoId) return res.status(400).send('ID ausente');
    
    // Suporte a Preflight CORS
    if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');
        return res.status(200).end();
    }

    if (videoId.startsWith('http')) {
        const success = await pipeViaNative(videoId, req, res);
        if (!success && !res.headersSent) res.redirect(videoId);
        return;
    }

    // LAYER 1: YTDL-CORE (Nativo)
    try {
        const info = await Promise.race([
            ytdl.getInfo(`https://www.youtube.com/watch?v=${videoId}`),
            new Promise((_, r) => setTimeout(() => r(new Error('Timeout')), 4000))
        ]);
        const format = ytdl.chooseFormat(info.formats, { quality: 'highestaudio', filter: 'audioonly' });
        if (format && format.url) {
            if (await pipeViaNative(format.url, req, res)) return;
        }
    } catch (e) {}

    // LAYER 2: INVIDIOUS API
    const invidiousInstances = [
        "https://inv.tux.pizza",
        "https://invidious.jing.rocks",
        "https://invidious.nerdvpn.de",
        "https://invidious.lunar.icu"
    ];
    for (const api of invidiousInstances) {
        try {
            const reqFetch = await fetchWithTimeout(`${api}/api/v1/videos/${videoId}`, {}, 2500);
            if (!reqFetch.ok) continue;
            const data = await reqFetch.json();
            const format = data.formatStreams?.find(s => s.mimeType?.includes('audio/mp4')) || data.formatStreams?.[0];
            if (format && format.url) {
                if (await pipeViaNative(format.url, req, res)) return;
            }
        } catch(e) {}
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
                if (await pipeViaNative(format.url, req, res)) return;
            }
        } catch(e) {}
    }

    // SE TUDO FALHOU
    if (!res.headersSent) res.status(500).send('Bloqueio Massivo detectado.');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Backend TITÃ (Com suporte a Range) rodando na porta ${PORT}`);
});
