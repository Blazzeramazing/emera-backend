const express = require('express');
const cors = require('cors');
const yts = require('yt-search');
const { Readable } = require('stream');
const ytdl = require('@distube/ytdl-core');

const app = express();

app.use(cors({ origin: '*' }));

// --- ROTA 1: PESQUISA NATIVA ---
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
        console.error('Erro na pesquisa:', error);
        res.status(500).json({ error: 'Erro ao pesquisar' });
    }
});

// --- FUNÇÃO DE TRANSMISSÃO ROBUSTA ---
async function proxyStream(url, req, res) {
    try {
        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 Safari/537.36',
        };
        
        if (req.headers.range) {
            headers['Range'] = req.headers.range;
        }

        // redirect: 'follow' assegura que links proxy sejam seguidos
        const response = await fetch(url, { headers, redirect: 'follow' });

        if (!response.ok) {
            console.log(`[FALHOU] O servidor de áudio recusou a ligação (Status: ${response.status})`);
            return false; 
        }

        res.status(response.status);
        res.set({
            'Access-Control-Allow-Origin': '*',
            'Content-Type': response.headers.get('content-type') || 'audio/mp4',
            'Accept-Ranges': 'bytes',
        });

        if (response.headers.get('content-length')) res.set('Content-Length', response.headers.get('content-length'));
        if (response.headers.get('content-range')) res.set('Content-Range', response.headers.get('content-range'));

        Readable.fromWeb(response.body).pipe(res);
        return true; 
    } catch (error) {
        console.error('[ERRO PROXY]:', error.message);
        return false; 
    }
}

// --- ROTA 2: STREAM MULTI-CAMADA ---
app.get('/stream', async (req, res) => {
    const videoId = req.query.url; 
    if (!videoId) return res.status(400).send('ID ausente');

    if (videoId.startsWith('http')) {
        const success = await proxyStream(videoId, req, res);
        if (success) return;
        return res.redirect(videoId);
    }

    // TENTATIVA 1: Extração Direta e Nativa
    try {
        const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
        const info = await ytdl.getInfo(videoUrl);
        const format = ytdl.chooseFormat(info.formats, { quality: 'highestaudio', filter: 'audioonly' });

        if (format && format.url) {
            console.log(`[TENTATIVA 1] A extrair via ytdl-core: ${videoId}`);
            const success = await proxyStream(format.url, req, res);
            if (success) return; // Se a magia falhar por IP-Binding, ele avança
        }
    } catch (err) {
        console.log(`[AVISO 1] Extração nativa bloqueada ou falhou.`);
    }

    // TENTATIVA 2: APIs Piped (Ignoram bloqueios de IP pois usam proxies próprios)
    const pipedInstances = [
        'https://pipedapi.kavin.rocks',
        'https://pipedapi.tokhmi.xyz',
        'https://pipedapi.smnz.de'
    ];

    for (const api of pipedInstances) {
        try {
            console.log(`[TENTATIVA 2] A testar Piped em: ${api}`);
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 4000); // 4 seg limite

            const response = await fetch(`${api}/streams/${videoId}`, { signal: controller.signal });
            clearTimeout(timeoutId);

            if (!response.ok) continue;

            const data = await response.json();
            if (data.audioStreams && data.audioStreams.length > 0) {
                const bestAudio = data.audioStreams.find(s => s.mimeType && s.mimeType.includes('audio/mp4')) || data.audioStreams[0];

                if (bestAudio && bestAudio.url) {
                    const success = await proxyStream(bestAudio.url, req, res);
                    if (success) return;
                }
            }
        } catch (err) {
            console.log(`[AVISO 2] Falha de tempo no Piped.`);
        }
    }

    // TENTATIVA 3: APIs Invidious (Modo Local Bypass)
    const invidiousInstances = [
        'https://invidious.jing.rocks',
        'https://inv.tux.pizza',
        'https://vid.puffyan.us'
    ];

    for (const api of invidiousInstances) {
        try {
            console.log(`[TENTATIVA 3] A testar Invidious (Local Stream) em: ${api}`);
            // A flag "local=true" obriga o servidor a agir como escudo contra bloqueios
            const proxyUrl = `${api}/latest_version?id=${videoId}&itag=140&local=true`;
            const success = await proxyStream(proxyUrl, req, res);
            if (success) return;
        } catch (err) {}
    }

    res.status(500).send('Erro Crítico: Todas as vias de extração de áudio foram bloqueadas.');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Backend Supremo rodando na porta ${PORT}`);
});
