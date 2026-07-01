const express = require('express');
const cors = require('cors');
const yts = require('yt-search');
const { Readable } = require('stream');

const app = express();

// Permite acesso do Frontend no Vercel
app.use(cors({ origin: '*' }));

// --- ROTA 1: PESQUISA NATIVA ---
app.get('/search', async (req, res) => {
    const query = req.query.q;
    if (!query) return res.status(400).json({ error: 'Digite o nome da música.' });

    try {
        // Busca vídeos relacionados a áudio
        const r = await yts(query + ' official audio');
        const videos = r.videos.slice(0, 15);

        const formattedResults = videos.map(v => ({
            id: v.videoId,
            name: v.title,
            image: [{ quality: '500x500', link: v.thumbnail }],
            downloadUrl: [{ quality: '320kbps', link: v.videoId }], // Passamos apenas o ID
            artists: { primary: [{ name: v.author.name }] }
        }));

        res.json({ data: { results: formattedResults } });
    } catch (error) {
        console.error('Erro na pesquisa:', error);
        res.status(500).json({ error: 'Erro ao pesquisar no YouTube' });
    }
});

// --- FUNÇÃO MÁGICA: PROXY DE STREAM (Bypass de CORS) ---
// Em vez de redirecionar, baixamos o stream em tempo real e retransmitimos com cabeçalhos CORS
async function proxyStream(url, req, res) {
    try {
        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 Safari/537.36',
        };
        
        // Repassa o cabeçalho Range se existir (Crucial para a barra de progresso e saltos na música funcionarem)
        if (req.headers.range) {
            headers['Range'] = req.headers.range;
        }

        const response = await fetch(url, { headers });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        // Aplicamos os nossos próprios cabeçalhos para o browser aceitar sem bloquear
        res.status(response.status);
        res.set({
            'Access-Control-Allow-Origin': '*',
            'Content-Type': response.headers.get('content-type') || 'audio/mp4',
            'Accept-Ranges': response.headers.get('accept-ranges') || 'bytes',
        });

        // Repassar informações de tamanho e buffers de áudio
        if (response.headers.get('content-length')) res.set('Content-Length', response.headers.get('content-length'));
        if (response.headers.get('content-range')) res.set('Content-Range', response.headers.get('content-range'));

        // Converte o Stream de Web (Fetch) para Stream de Node.js e "Manda a água pelo tubo" para o Frontend
        Readable.fromWeb(response.body).pipe(res);
        return true; // Sucesso!
    } catch (error) {
        console.error('Falha ao retransmitir a URL:', error.message);
        return false; // Falhou, tenta a próxima instância
    }
}

// --- ROTA 2: RESOLVEDOR DE STREAM (PROXY INTELIGENTE) ---
app.get('/stream', async (req, res) => {
    const videoId = req.query.url; 
    if (!videoId) return res.status(400).send('ID ausente');

    // Se for um link de emergência (como do Jamendo), retransmite direto
    if (videoId.startsWith('http')) {
        const success = await proxyStream(videoId, req, res);
        if (success) return;
        return res.redirect(videoId); // Se o proxy falhar numa emergência absoluta, faz o redirect antigo
    }

    // Instâncias do Piped Atualizadas, Mais Estáveis
    const pipedInstances = [
        'https://pipedapi.kavin.rocks',
        'https://api.piped.projectsegfau.lt',
        'https://pipedapi.smnz.de',
        'https://piped-api.lunar.icu'
    ];

    // Tenta encontrar a URL direta do áudio
    for (const api of pipedInstances) {
        try {
            // Adiciona um timeout pequeno (4s) para não prender o utilizador se uma API estiver lenta
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 4000);

            const response = await fetch(`${api}/streams/${videoId}`, { signal: controller.signal });
            clearTimeout(timeoutId);

            if (!response.ok) continue;
            
            const data = await response.json();
            
            if (data.audioStreams && data.audioStreams.length > 0) {
                const bestAudio = data.audioStreams.find(s => s.mimeType === 'audio/mp4') || data.audioStreams[0];
                
                // Em vez do antigo `res.redirect`, agora puxamos e retransmitimos! (Sem bloqueios CORS)
                const success = await proxyStream(bestAudio.url, req, res);
                if (success) return; 
            }
        } catch (err) {
            console.log(`Instância Piped falhou ou demorou muito: ${api}`);
        }
    }

    // Se todas as APIs do Piped sofrerem queda simultânea, usa o Invidious, MAS como proxy!
    // Instâncias atualizadas e a funcionar:
    const invidiousInstances = [
        'https://invidious.perennialte.ch',
        'https://invidious.jing.rocks',
        'https://iv.melmac.space'
    ];

    for (const invAPI of invidiousInstances) {
        const invUrl = `${invAPI}/latest_version?id=${videoId}&itag=140`;
        const success = await proxyStream(invUrl, req, res);
        if (success) return;
    }

    res.status(500).send('Erro Global: Nenhuma fonte de áudio conseguiu ser carregada.');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Backend de Streaming Inteligente rodando na porta ${PORT}`);
});
