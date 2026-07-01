const express = require('express');
const cors = require('cors');
const yts = require('yt-search');

// Proteção global para o servidor nunca crashar no Railway
process.on('uncaughtException', (err) => console.error('[CRITICAL] Uncaught Exception:', err));
process.on('unhandledRejection', (reason) => console.error('[CRITICAL] Unhandled Rejection:', reason));

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

// --- FUNÇÃO DE TRANSMISSÃO BLINDADA ---
async function proxyStream(url, req, res, timeoutMs = 2500) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            'Accept': '*/*',
        };
        if (req.headers.range) headers['Range'] = req.headers.range;

        const response = await fetch(url, { headers, redirect: 'follow', signal: controller.signal });
        
        // Se conseguimos os cabeçalhos a tempo, cancelamos o timeout de aborto para poder transmitir a música à vontade!
        clearTimeout(timeoutId);

        if (!response.ok) return false; 

        const contentType = response.headers.get('content-type') || '';
        const contentLength = response.headers.get('content-length');

        // FILTRO DE LIXO: Rejeita se não for áudio ou se for um ficheiro de erro minúsculo disfarçado
        if (!contentType.includes('audio') && !contentType.includes('video') && !contentType.includes('octet-stream')) {
            console.log(`[REJEITADO] Não é áudio. Tipo: ${contentType}`);
            return false;
        }
        if (contentLength && parseInt(contentLength) < 50000) {
            console.log(`[REJEITADO] Ficheiro demasiado pequeno (${contentLength} bytes)`);
            return false;
        }

        res.status(response.status);
        res.set({
            'Access-Control-Allow-Origin': '*',
            'Content-Type': contentType,
            'Accept-Ranges': 'bytes',
        });
        if (contentLength) res.set('Content-Length', contentLength);
        if (response.headers.get('content-range')) res.set('Content-Range', response.headers.get('content-range'));

        // TUBAGEM UNIVERSAL (Compatível com qualquer versão do Node.js)
        if (typeof ReadableStream !== 'undefined' && response.body && !response.body.pipe) {
            const { Readable } = require('stream');
            const stream = Readable.fromWeb(response.body);
            stream.pipe(res);
            req.on('close', () => { stream.destroy(); });
        } else if (response.body && typeof response.body.pipe === 'function') {
            response.body.pipe(res);
        } else {
            const buffer = await response.arrayBuffer();
            res.end(Buffer.from(buffer));
        }

        return true; 
    } catch (error) {
        clearTimeout(timeoutId);
        return false; 
    }
}

// --- ROTA 2: STREAM MULTI-CAMADA (NOVO MOTOR) ---
app.get('/stream', async (req, res) => {
    const videoId = req.query.url; 
    if (!videoId) return res.status(400).send('ID ausente');

    // CORS OBRIGATÓRIO NA BASE
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');
    if (req.method === 'OPTIONS') return res.status(200).end();

    console.log(`\n=== NOVA TENTATIVA DE ÁUDIO: ${videoId} ===`);

    // CAMADA 1: INVIDIOUS PROXY (Estratégia de Ouro: local=true faz bypass aos bloqueios da Google)
    const invidiousInstances = [
        "https://invidious.jing.rocks",
        "https://inv.tux.pizza",
        "https://invidious.lunar.icu",
        "https://invidious.projectsegfau.lt",
        "https://inv.rvt.wtf",
        "https://invidious.privacydev.net",
        "https://inv.pistasjis.net",
        "https://invidious.perennialte.ch"
    ];

    for (const instance of invidiousInstances) {
        console.log(`[CAMADA 1] A testar Invidious Proxy: ${instance}`);
        const targetUrl = `${instance}/latest_version?id=${videoId}&itag=140&local=true`;
        
        // Se a função proxyStream retornar true, o ficheiro era válido e já foi enviado ao Vercel!
        if (await proxyStream(targetUrl, req, res, 2500)) {
            console.log(`[SUCESSO] Transmissão iniciada por Invidious!`);
            return;
        }
    }

    // CAMADA 2: Cobalt API (Nova API Oficial 2024)
    try {
        console.log(`[CAMADA 2] A testar Cobalt API...`);
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 3000);
        
        const cobaltRes = await fetch("https://api.cobalt.tools/api/json", {
            method: "POST",
            headers: {
                "Accept": "application/json",
                "Content-Type": "application/json",
                "User-Agent": "EmeraPlayer/1.0"
            },
            body: JSON.stringify({
                url: `https://www.youtube.com/watch?v=${videoId}`,
                isAudioOnly: true,
                aFormat: "mp3"
            }),
            signal: controller.signal
        });
        clearTimeout(timeoutId);

        if (cobaltRes.ok) {
            const cobaltData = await cobaltRes.json();
            if (cobaltData.url) {
                if (await proxyStream(cobaltData.url, req, res, 3000)) {
                    console.log(`[SUCESSO] Transmissão iniciada pelo Cobalt!`);
                    return;
                }
            }
        }
    } catch(e) {
        console.log(`[AVISO] Cobalt falhou.`);
    }

    // CAMADA 3: PIPED NATIVO
    const pipedInstances = [
        'https://pipedapi.kavin.rocks',
        'https://pipedapi.tokhmi.xyz',
        'https://pipedapi.smnz.de'
    ];

    for (const api of pipedInstances) {
        try {
            console.log(`[CAMADA 3] A testar Piped: ${api}`);
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 2000);

            const response = await fetch(`${api}/streams/${videoId}`, { signal: controller.signal });
            clearTimeout(timeoutId);

            if (!response.ok) continue;

            const data = await response.json();
            const bestAudio = data.audioStreams.find(s => s.mimeType && s.mimeType.includes('audio/mp4')) || data.audioStreams[0];

            if (bestAudio && bestAudio.url) {
                if (await proxyStream(bestAudio.url, req, res, 3000)) {
                    console.log(`[SUCESSO] Transmissão iniciada pelo Piped!`);
                    return;
                }
            }
        } catch (err) {
            console.log(`[AVISO] Piped saltado (Timeout)`);
        }
    }

    // SE CHEGAR AQUI, TUDO FALHOU.
    console.log(`[ERRO FATAL] Todas as camadas falharam.`);
    if (!res.headersSent) {
        res.status(500).send('Erro Crítico: Nenhum proxy suportou este vídeo.');
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Backend Supremo (V3 Invidious Proxy) rodando na porta ${PORT}`);
});

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

// --- FUNÇÃO DE TRANSMISSÃO ROBUSTA (À PROVA DE CRASH) ---
async function proxyStream(url, req, res) {
    try {
        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            'Accept': '*/*',
        };
        if (req.headers.range) headers['Range'] = req.headers.range;

        const response = await fetch(url, { headers, redirect: 'follow' });

        if (!response.ok) {
            console.log(`[REJEITADO] HTTP ${response.status} de ${url.substring(0, 30)}...`);
            return false; 
        }

        const contentType = response.headers.get('content-type') || '';
        const contentLength = response.headers.get('content-length');

        // Se não for media real, ou for demasiado pequeno (página de erro), salta fora!
        if (!contentType.includes('audio') && !contentType.includes('video') && !contentType.includes('octet-stream')) {
            console.log(`[REJEITADO] Falso Positivo: ${contentType}`);
            return false;
        }
        if (contentLength && parseInt(contentLength) < 100000) {
            console.log(`[REJEITADO] Ficheiro demasiado pequeno (${contentLength} bytes)`);
            return false;
        }

        res.status(response.status);
        res.set({
            'Access-Control-Allow-Origin': '*',
            'Content-Type': contentType,
            'Accept-Ranges': 'bytes',
        });
        if (contentLength) res.set('Content-Length', contentLength);
        if (response.headers.get('content-range')) res.set('Content-Range', response.headers.get('content-range'));

        // Tubagem Universal (Compatível com qualquer versão do Node no Railway)
        if (response.body && typeof response.body.pipe === 'function') {
            response.body.pipe(res);
        } else if (typeof ReadableStream !== 'undefined') {
            const { Readable } = require('stream');
            const stream = Readable.fromWeb(response.body);
            stream.pipe(res);
            req.on('close', () => { stream.destroy(); });
        } else {
            // Em último caso, envia em buffer
            const buffer = await response.arrayBuffer();
            res.end(Buffer.from(buffer));
        }

        return true; 
    } catch (error) {
        console.error('[ERRO PROXY STREAM]:', error.message);
        return false; 
    }
}

// --- ROTA 2: STREAM MULTI-CAMADA DE ALTA RESILIÊNCIA ---
app.get('/stream', async (req, res) => {
    const videoId = req.query.url; 
    if (!videoId) return res.status(400).send('ID ausente');

    // CORS OBRIGATÓRIO (Impede o browser de mentir sobre o erro)
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');

    if (req.method === 'OPTIONS') return res.status(200).end();

    if (videoId.startsWith('http')) {
        if (await proxyStream(videoId, req, res)) return;
        return res.redirect(videoId);
    }

    console.log(`\n=== INICIANDO EXTRAÇÃO: ${videoId} ===`);

    // TENTATIVA 1: Cobalt Oficial (Atualizado para a API V10 da co.wuk.sh)
    try {
        console.log(`[CAMADA 1] A testar API Oficial Cobalt (co.wuk.sh)...`);
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 6000); // 6s máx
        
        const cobaltRes = await fetch("https://co.wuk.sh/api/json", {
            method: "POST",
            headers: {
                "Accept": "application/json",
                "Content-Type": "application/json",
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
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
                console.log(`[SUCESSO] Link gerado pelo Cobalt! A transmitir...`);
                if (await proxyStream(cobaltData.url, req, res)) return;
            }
        } else {
             console.log(`[FALHA] Cobalt devolveu status: ${cobaltRes.status}`);
        }
    } catch(e) {
        console.log(`[FALHA] Tempo esgotado ou erro no Cobalt.`);
    }

    // TENTATIVA 2: Instâncias rápidas do Piped (Garantidas)
    const pipedInstances = [
        'https://pipedapi.kavin.rocks',
        'https://deapi.piped.stream',
        'https://piped-api.garudalinux.org'
    ];

    for (const api of pipedInstances) {
        try {
            console.log(`[CAMADA 2] A testar Piped: ${api}`);
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 4000); // 4s rápidos

            const response = await fetch(`${api}/streams/${videoId}`, { signal: controller.signal });
            clearTimeout(timeoutId);

            if (!response.ok) continue;

            const data = await response.json();
            if (data.audioStreams && data.audioStreams.length > 0) {
                const bestAudio = data.audioStreams.find(s => s.mimeType && s.mimeType.includes('audio/mp4')) || data.audioStreams[0];

                if (bestAudio && bestAudio.url) {
                    console.log(`[SUCESSO] Link gerado pelo Piped! A transmitir...`);
                    if (await proxyStream(bestAudio.url, req, res)) return;
                }
            }
        } catch (err) {
            console.log(`[AVISO] Instância Piped saltada (Timeout)`);
        }
    }

    // TENTATIVA 3: ytdl-core nativo (Fallback robusto com cookies padrão)
    try {
        console.log(`[CAMADA 3] A testar YTDL-Core nativo...`);
        const info = await ytdl.getInfo(`https://www.youtube.com/watch?v=${videoId}`);
        const format = ytdl.chooseFormat(info.formats, { quality: 'highestaudio', filter: 'audioonly' });

        if (format && format.url) {
            console.log(`[SUCESSO] Extração nativa completa! A transmitir...`);
            if (await proxyStream(format.url, req, res)) return; 
        }
    } catch (err) {
        console.log(`[AVISO] YTDL bloqueado pelo YouTube (IP binding)`);
    }

    // SE CHEGAR AQUI, TUDO FALHOU.
    console.log(`[FALHA TOTAL] Todas as camadas falharam.`);
    if (!res.headersSent) {
        res.status(500).send('Erro Crítico: Nenhuma API conseguiu extrair o áudio de forma segura.');
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Backend Supremo (V2 Blindada) rodando na porta ${PORT}`);
});
