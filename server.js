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
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            'Accept': '*/*',
            'Accept-Language': 'pt-PT,pt;q=0.9,en-US;q=0.8,en;q=0.7',
        };
        
        if (req.headers.range) {
            headers['Range'] = req.headers.range;
        }

        const response = await fetch(url, { headers, redirect: 'follow' });

        if (!response.ok) {
            console.log(`[FALHOU] Link recusou ligação. Status: ${response.status}`);
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

        // Extrai o áudio e envia diretamente para o Frontend sem sobrecarregar a memória
        const stream = Readable.fromWeb(response.body);
        stream.pipe(res);
        
        // Se o utilizador passar à frente na música, cancelamos a transferência antiga
        req.on('close', () => {
            stream.destroy();
        });

        return true; 
    } catch (error) {
        console.error('[ERRO PROXY]:', error.message);
        return false; 
    }
}

// --- ROTA 2: STREAM MULTI-CAMADA DE ALTA RESILIÊNCIA ---
app.get('/stream', async (req, res) => {
    const videoId = req.query.url; 
    if (!videoId) return res.status(400).send('ID ausente');

    // INJEÇÃO DE CORS OBRIGATÓRIA (Garante que os erros 500 chegam limpos ao frontend)
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range');

    if (req.method === 'OPTIONS') return res.status(200).end();

    if (videoId.startsWith('http')) {
        const success = await proxyStream(videoId, req, res);
        if (success) return;
        return res.redirect(videoId);
    }

    // TENTATIVA 1: Piped APIs (As mais fiáveis, com tempo limite de 8 segundos)
    const pipedInstances = [
        'https://pipedapi.kavin.rocks',
        'https://pipedapi.tokhmi.xyz',
        'https://pipedapi.smnz.de',
        'https://api.piped.projectsegfau.lt',
        'https://pipedapi.syncpundit.io'
    ];

    for (const api of pipedInstances) {
        try {
            console.log(`[CAMADA 1] A testar Piped: ${api}`);
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 8000); // 8 segundos para dar tempo!

            const response = await fetch(`${api}/streams/${videoId}`, { signal: controller.signal });
            clearTimeout(timeoutId);

            if (!response.ok) continue;

            const data = await response.json();
            if (data.audioStreams && data.audioStreams.length > 0) {
                const bestAudio = data.audioStreams.find(s => s.mimeType && s.mimeType.includes('audio/mp4')) || data.audioStreams[0];

                if (bestAudio && bestAudio.url) {
                    console.log(`[SUCESSO] Transmitir via Piped!`);
                    const success = await proxyStream(bestAudio.url, req, res);
                    if (success) return;
                }
            }
        } catch (err) {
            console.log(`[AVISO] Falha de tempo no Piped.`);
        }
    }

    // TENTATIVA 2: Cobalt API (Ferramenta poderosa de extração global)
    try {
        console.log(`[CAMADA 2] A testar Cobalt API...`);
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 6000);
        
        const cobaltRes = await fetch("https://api.cobalt.tools/api/json", {
            method: "POST",
            headers: {
                "Accept": "application/json",
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                url: `https://www.youtube.com/watch?v=${videoId}`,
                isAudioOnly: true
            }),
            signal: controller.signal
        });
        clearTimeout(timeoutId);

        if (cobaltRes.ok) {
            const cobaltData = await cobaltRes.json();
            if (cobaltData.url) {
                console.log(`[SUCESSO] Transmitir via Cobalt!`);
                const success = await proxyStream(cobaltData.url, req, res);
                if (success) return;
            }
        }
    } catch(e) {
        console.log(`[AVISO] Cobalt API falhou.`);
    }

    // TENTATIVA 3: Invidious Proxy Local
    const invidiousInstances = [
        'https://inv.tux.pizza',
        'https://invidious.jing.rocks',
        'https://invidious.nerdvpn.de'
    ];

    for (const api of invidiousInstances) {
        try {
            console.log(`[CAMADA 3] A testar Invidious Proxy: ${api}`);
            const proxyUrl = `${api}/latest_version?id=${videoId}&itag=140&local=true`;
            const success = await proxyStream(proxyUrl, req, res);
            if (success) return;
        } catch (err) {}
    }

    // TENTATIVA 4: ytdl-core nativo (Deixado para último pois o YouTube bloqueia muito IPs Cloud)
    try {
        console.log(`[CAMADA 4] Extração nativa YTDL-Core...`);
        const info = await ytdl.getInfo(`https://www.youtube.com/watch?v=${videoId}`);
        const format = ytdl.chooseFormat(info.formats, { quality: 'highestaudio', filter: 'audioonly' });

        if (format && format.url) {
            console.log(`[SUCESSO] Transmitir via YTDL!`);
            const success = await proxyStream(format.url, req, res);
            if (success) return; 
        }
    } catch (err) {
        console.log(`[AVISO] YTDL Bloqueado por IP.`);
    }

    // SE TUDO FALHAR, envia erro 500 formatado com CORS ativo!
    console.log(`[FALHA TOTAL] Nenhuma via conseguiu extrair a faixa.`);
    res.status(500).send('Erro Crítico: Todas as vias de extração de áudio foram bloqueadas.');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Backend Supremo rodando na porta ${PORT}`);
});
