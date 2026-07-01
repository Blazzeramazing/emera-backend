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

// --- FUNÇÃO MÁGICA: TÚNEL NATIVO SEM CRASHES ---
// Em vez de usar fetch (que guarda ficheiros na memória e crasha o servidor), 
// esta função faz uma tubagem direta de bytes da origem para o seu frontend.
function pipeViaNative(url, res) {
    return new Promise((resolve) => {
        const client = url.startsWith('https') ? https : http;
        
        const request = client.get(url, { 
            headers: { 
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                'Accept': '*/*',
                'Connection': 'keep-alive'
            } 
        }, (streamRes) => {
            // Se houver redirecionamento (muito comum em proxies)
            if (streamRes.statusCode >= 300 && streamRes.statusCode < 400 && streamRes.headers.location) {
                let redirectUrl = streamRes.headers.location;
                // Corrigir redirects relativos
                if (!redirectUrl.startsWith('http')) {
                    const urlObj = new URL(url);
                    redirectUrl = `${urlObj.protocol}//${urlObj.host}${redirectUrl}`;
                }
                return resolve(pipeViaNative(redirectUrl, res));
            }
            
            // A CORREÇÃO DE OURO: Aceitar 200 (OK) e 206 (Conteúdo Parcial/Música)
            if (streamRes.statusCode !== 200 && streamRes.statusCode !== 206) {
                streamRes.resume(); // Liberta a memória presa
                return resolve(false);
            }
            
            // Proteger contra páginas HTML disfarçadas de áudio
            const contentType = streamRes.headers['content-type'] || '';
            if (contentType.includes('text/html') || contentType.includes('application/json')) {
                streamRes.resume();
                return resolve(false);
            }

            // TUDO VÁLIDO! Iniciar Transmissão CORS
            if (!res.headersSent) {
                res.setHeader('Access-Control-Allow-Origin', '*');
                res.setHeader('Content-Type', contentType.includes('audio') || contentType.includes('video') ? contentType : 'audio/mpeg');
                if (streamRes.headers['content-length']) res.setHeader('Content-Length', streamRes.headers['content-length']);
                res.setHeader('Accept-Ranges', 'bytes');
                res.status(streamRes.statusCode); // Mantém o status original (200 ou 206)
            }

            // Iniciar a tubagem!
            streamRes.pipe(res);
            
            // Resolver apenas quando o stream terminar, ou ocorrer erro de quebra, 
            // mas garantir que devolve true porque o envio começou com sucesso.
            streamRes.on('end', () => resolve(true));
            streamRes.on('error', () => resolve(true)); 
        });
        
        request.on('error', () => resolve(false));
        // Aumentámos a tolerância para 6 segundos para dar tempo a proxies mais distantes
        request.setTimeout(6000, () => { request.destroy(); resolve(false); });
    });
}

// Utilitário de Timeout para as APIs não congelarem o backend
const fetchWithTimeout = (url, options = {}, timeout = 4000) => {
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

    // Se for link direto (emergências do frontend), processa direto
    if (videoId.startsWith('http')) {
        const success = await pipeViaNative(videoId, res);
        if (!success && !res.headersSent) res.redirect(videoId);
        return;
    }

    // LAYER 1: YTDL-CORE (Nativo - Máxima Qualidade)
    try {
        const info = await Promise.race([
            ytdl.getInfo(`https://www.youtube.com/watch?v=${videoId}`),
            new Promise((_, r) => setTimeout(() => r(new Error('Timeout')), 4000))
        ]);
        const format = ytdl.chooseFormat(info.formats, { quality: 'highestaudio', filter: 'audioonly' });
        if (format && format.url) {
            if (await pipeViaNative(format.url, res)) return;
        }
    } catch (e) {}

    // LAYER 2: COBALT API OFICIAL (Bypass avançado de 2024)
    try {
        const cobaltReq = await fetchWithTimeout('https://api.cobalt.tools/api/json', {
            method: 'POST',
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json',
                'Origin': 'https://cobalt.tools',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
            },
            body: JSON.stringify({ url: `https://www.youtube.com/watch?v=${videoId}`, isAudioOnly: true, aFormat: "mp3" })
        }, 4000);

        if (cobaltReq.ok) {
            const data = await cobaltReq.json();
            if (data && data.url) {
                if (await pipeViaNative(data.url, res)) return;
            }
        }
    } catch(e) {}

    // LAYER 3: INVIDIOUS API (Cluster de Servidores)
    const invidiousInstances = [
        "https://invidious.jing.rocks",
        "https://inv.tux.pizza",
        "https://invidious.nerdvpn.de",
        "https://invidious.no-logs.com",
        "https://invidious.lunar.icu"
    ];
    for (const api of invidiousInstances) {
        try {
            const req = await fetchWithTimeout(`${api}/api/v1/videos/${videoId}`, {}, 2500);
            if (!req.ok) continue;
            const data = await req.json();
            const format = data.formatStreams?.find(s => s.mimeType?.includes('audio/mp4')) || data.formatStreams?.[0];
            if (format && format.url) {
                if (await pipeViaNative(format.url, res)) return;
            }
        } catch(e) {}
    }

    // LAYER 4: PIPED API (Última Esperança)
    const pipedInstances = [
        "https://pipedapi.kavin.rocks",
        "https://pipedapi.tokhmi.xyz",
        "https://pipedapi.smnz.de",
        "https://piped-api.lunar.icu"
    ];
    for (const api of pipedInstances) {
        try {
            const req = await fetchWithTimeout(`${api}/streams/${videoId}`, {}, 2500);
            if (!req.ok) continue;
            const data = await req.json();
            const format = data.audioStreams?.find(s => s.mimeType?.includes('audio/mp4')) || data.audioStreams?.[0];
            if (format && format.url) {
                if (await pipeViaNative(format.url, res)) return;
            }
        } catch(e) {}
    }

    // SE CHEGAR AQUI, TUDO FALHOU (Envia Erro 500 Oficial)
    if (!res.headersSent) res.status(500).send('Bloqueio Massivo detectado. Tente novamente mais tarde.');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Backend TITÃ (Versão Imparável) rodando na porta ${PORT}`);
});
