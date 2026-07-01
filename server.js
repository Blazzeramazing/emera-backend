const express = require('express');
const cors = require('cors');
const yts = require('yt-search');
const ytdl = require('@distube/ytdl-core');

// Proteção Global para evitar Crashes Silenciosos no Railway
process.on('uncaughtException', (err) => console.error('[CRITICAL] Uncaught Exception:', err.message));
process.on('unhandledRejection', (reason) => console.error('[CRITICAL] Unhandled Rejection:', reason));

const app = express();

// Permite acesso de qualquer Frontend
app.use(cors({ origin: '*' }));

// --- ROTA DE PESQUISA ---
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

// --- FUNÇÃO PROXY OTIMIZADA PARA ÁUDIO ---
async function proxyStream(url, req, res) {
    try {
        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
        };
        // Repassa os headers de tempo (seek) se o utilizador avançar a barra
        if (req.headers.range) headers['Range'] = req.headers.range;

        const response = await fetch(url, { headers, redirect: 'follow' });
        if (!response.ok) return false;

        // Bloqueia páginas de erro camufladas de 200 OK
        const contentType = response.headers.get('content-type') || '';
        if (contentType.includes('text/html') || contentType.includes('application/json')) {
            return false; 
        }

        // Passa os cabeçalhos de áudio para o frontend
        res.status(response.status);
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Content-Type', contentType.includes('audio') || contentType.includes('video') ? contentType : 'audio/mpeg');
        res.setHeader('Accept-Ranges', 'bytes');
        
        if (response.headers.get('content-length')) res.setHeader('Content-Length', response.headers.get('content-length'));
        if (response.headers.get('content-range')) res.setHeader('Content-Range', response.headers.get('content-range'));

        // Transmissão por tubagem fluída (sem esgotar a RAM do Railway)
        if (response.body) {
            const { Readable } = require('stream');
            const stream = Readable.fromWeb(response.body);
            stream.pipe(res);
            
            req.on('close', () => { stream.destroy(); }); // Para de gastar net se o utilizador trocar de música
            return true;
        }
        return false;
    } catch (error) {
        console.error('[Proxy] Erro na transmissão:', error.message);
        return false;
    }
}

// --- ROTA DE REPRODUÇÃO (O REDIRECTOR INTELIGENTE) ---
app.get('/stream', async (req, res) => {
    const videoId = req.query.url; 
    if (!videoId) return res.status(400).send('ID ausente');

    // Headers baseados CORS (sempre injetados primeiro para o browser não dar block)
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');
    if (req.method === 'OPTIONS') return res.status(200).end();

    if (videoId.startsWith('http')) {
        if (await proxyStream(videoId, req, res)) return;
        return res.redirect(videoId);
    }

    console.log(`\n=== TOCAR ÁUDIO: ${videoId} ===`);

    // CAMADA 1: YTDL-CORE NATIVO (Prioridade Absoluta - Rápido e Sem Limites)
    try {
        console.log('[1] A extrair via ytdl-core...');
        const info = await ytdl.getInfo(`https://www.youtube.com/watch?v=${videoId}`);
        const format = ytdl.chooseFormat(info.formats, { quality: 'highestaudio', filter: 'audioonly' });
        
        if (format && format.url) {
            console.log('[1] Sucesso! Iniciando a tubagem...');
            const success = await proxyStream(format.url, req, res);
            if (success) return; 
        }
    } catch (err) { 
        console.error('[1] Falha ytdl-core:', err.message);
    }

    // CAMADA 2: COBALT API (O Melhor Proxy Público de 2024)
    try {
        console.log('[2] A extrair via Cobalt API...');
        const cobaltReq = await fetch('https://api.cobalt.tools/api/json', {
            method: 'POST',
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json',
                'User-Agent': 'EmeraPlayer/1.0'
            },
            body: JSON.stringify({
                url: `https://www.youtube.com/watch?v=${videoId}`,
                vQuality: 'audio',
                isAudioOnly: true,
                aFormat: 'mp3'
            })
        });

        if (cobaltReq.ok) {
            const data = await cobaltReq.json();
            if (data && data.url) {
                console.log('[2] Redirecionando para servidor Cobalt...');
                return res.redirect(data.url);
            }
        }
    } catch (err) {
        console.error('[2] Falha Cobalt:', err.message);
    }

    // CAMADA 3: PIPED API DE EMERGÊNCIA (Timeout Rápido)
    try {
        console.log(`[3] Testando Piped API...`);
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 4000); // Se não responder em 4s, aborta
        
        const response = await fetch(`https://pipedapi.kavin.rocks/streams/${videoId}`, { signal: controller.signal });
        clearTimeout(timeoutId);

        if (response.ok) {
            const data = await response.json();
            const bestAudio = data.audioStreams?.find(s => s.mimeType && s.mimeType.includes('audio/mp4')) || data.audioStreams?.[0];

            if (bestAudio && bestAudio.url) {
                console.log('[3] A fazer proxy pelo Piped...');
                const success = await proxyStream(bestAudio.url, req, res);
                if (success) return;
            }
        }
    } catch (err) {
        console.error(`[3] Falha Piped:`, err.message);
    }

    // SE CHEGAR AQUI, TUDO FALHOU.
    console.log(`[ERRO FATAL] Bloqueio total para o ID: ${videoId}`);
    if (!res.headersSent) {
        res.status(500).send('Erro Crítico: Bloqueio de IP detectado pelo YouTube.');
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Backend Supremo (Sem Demoras) rodando na porta ${PORT}`);
});
