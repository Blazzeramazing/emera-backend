const express = require('express');
const cors = require('cors');
const yts = require('yt-search');

// Proteção global para o servidor nunca crashar no Railway
process.on('uncaughtException', (err) => console.error('[CRITICAL] Uncaught Exception:', err.message));
process.on('unhandledRejection', (reason) => console.error('[CRITICAL] Unhandled Rejection:', reason));

const app = express();
app.use(cors({ origin: '*' }));

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
        console.error('Erro na pesquisa:', error.message);
        res.status(500).json({ error: 'Erro ao pesquisar' });
    }
});

async function proxyStream(url, req, res, timeoutMs = 3000) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            'Accept': '*/*',
        };
        if (req.headers.range) headers['Range'] = req.headers.range;

        const response = await fetch(url, { headers, redirect: 'follow', signal: controller.signal });
        clearTimeout(timeoutId); // Limpa o timeout, ligamos ao servidor com sucesso

        if (!response.ok) return false;

        const contentType = response.headers.get('content-type') || '';
        const contentLength = response.headers.get('content-length');

        // REJEITA PÁGINAS DE ERRO: Só passa ficheiros grandes e do tipo audio/video/stream
        if (!contentType.includes('audio') && !contentType.includes('video') && !contentType.includes('octet-stream')) {
            return false;
        }
        if (contentLength && parseInt(contentLength) < 50000) {
            return false; // Menos de 50kb não é música
        }

        res.status(response.status);
        res.set({
            'Access-Control-Allow-Origin': '*',
            'Content-Type': contentType,
            'Accept-Ranges': 'bytes',
        });
        if (contentLength) res.set('Content-Length', contentLength);
        if (response.headers.get('content-range')) res.set('Content-Range', response.headers.get('content-range'));

        // Tubagem Universal Compatível com versões Node.js mais antigas
        if (typeof ReadableStream !== 'undefined' && response.body && !response.body.pipe) {
            const { Readable } = require('stream');
            const stream = Readable.fromWeb(response.body);
            stream.pipe(res);
            req.on('close', () => stream.destroy());
        } else if (response.body && typeof response.body.pipe === 'function') {
            response.body.pipe(res);
        } else {
            const buffer = await response.arrayBuffer();
            res.end(Buffer.from(buffer));
        }
        
        return true; // Transmissão concluída com sucesso!
    } catch (error) {
        clearTimeout(timeoutId);
        return false;
    }
}

app.get('/stream', async (req, res) => {
    const videoId = req.query.url; 
    if (!videoId) return res.status(400).send('ID ausente');

    // Headers baseados CORS (sempre injetados para evitar erros no frontend)
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');
    if (req.method === 'OPTIONS') return res.status(200).end();

    if (videoId.startsWith('http')) {
        if (await proxyStream(videoId, req, res, 5000)) return;
        return res.redirect(videoId);
    }

    console.log(`\n=== NOVA TENTATIVA DE ÁUDIO: ${videoId} ===`);

    // CAMADA 1: INVIDIOUS PROXY (A mais robusta, força local=true)
    const invidiousInstances = [
        "https://invidious.jing.rocks",
        "https://inv.tux.pizza",
        "https://invidious.lunar.icu",
        "https://invidious.projectsegfau.lt",
        "https://inv.rvt.wtf",
        "https://invidious.privacydev.net"
    ];

    for (const instance of invidiousInstances) {
        const targetUrl = `${instance}/latest_version?id=${videoId}&itag=140&local=true`;
        if (await proxyStream(targetUrl, req, res, 2500)) return;
    }

    // CAMADA 2: PIPED API (Com timeout super rápido de 2s para não encravar)
    const pipedInstances = [
        'https://pipedapi.kavin.rocks',
        'https://pipedapi.tokhmi.xyz',
        'https://pipedapi.smnz.de'
    ];

    for (const api of pipedInstances) {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 2000);
            
            const response = await fetch(`${api}/streams/${videoId}`, { signal: controller.signal });
            clearTimeout(timeoutId);

            if (!response.ok) continue;
            const data = await response.json();
            const bestAudio = data.audioStreams.find(s => s.mimeType && s.mimeType.includes('audio/mp4')) || data.audioStreams[0];

            if (bestAudio && bestAudio.url) {
                if (await proxyStream(bestAudio.url, req, res, 3000)) return;
            }
        } catch (err) { }
    }

    // CAMADA 3: YTDL-CORE NATIVO (Se estiver instalado via package.json, atua como último recurso)
    try {
        const ytdl = require('@distube/ytdl-core');
        const info = await ytdl.getInfo(`https://www.youtube.com/watch?v=${videoId}`);
        const format = ytdl.chooseFormat(info.formats, { quality: 'highestaudio', filter: 'audioonly' });
        
        if (format && format.url) {
            if (await proxyStream(format.url, req, res, 4000)) return; 
        }
    } catch (err) { }

    // SE CHEGAR AQUI, TUDO FALHOU.
    console.log(`[ERRO FATAL] Todas as 3 camadas falharam para o ID: ${videoId}`);
    if (!res.headersSent) {
        res.status(500).send('Erro Crítico: Nenhum proxy suportou este vídeo. O IP pode estar bloqueado.');
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Backend Supremo (Limpo e Estável) rodando na porta ${PORT}`);
});
