const express = require('express');
const cors = require('cors');
const yts = require('yt-search');

const app = express();

// Permite acesso de qualquer Frontend
app.use(cors({ origin: '*' }));

// --- ROTA 1: PESQUISA NATIVA ---
app.get('/search', async (req, res) => {
    const query = req.query.q;
    if (!query) return res.status(400).json({ error: 'Digite o nome da música.' });

    try {
        // Busca vídeos relacionados a áudio
        const r = await yts(query + ' audio');
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

// --- ROTA 2: RESOLVEDOR DE STREAM (O REDIRECTOR INTELIGENTE) ---
app.get('/stream', async (req, res) => {
    const videoId = req.query.url; 
    if (!videoId) return res.status(400).send('ID ausente');

    // Se for um link de emergência, repassa direto
    if (videoId.startsWith('http')) {
        return res.redirect(videoId);
    }

    // Array de APIs públicas, gigantescas e confiáveis (Piped) que fazem o bypass do YouTube
    const pipedInstances = [
        'https://pipedapi.kavin.rocks',
        'https://pipedapi.tokhmi.xyz',
        'https://pipedapi.smnz.de',
        'https://api.piped.projectsegfau.lt'
    ];

    // Tenta encontrar a URL direta do áudio em uma das instâncias globais
    for (const api of pipedInstances) {
        try {
            // Fetch nativo do Node.js
            const response = await fetch(`${api}/streams/${videoId}`);
            if (!response.ok) continue;
            
            const data = await response.json();
            
            if (data.audioStreams && data.audioStreams.length > 0) {
                // Pega o melhor formato suportado por navegadores web (geralmente m4a/mp4)
                const bestAudio = data.audioStreams.find(s => s.mimeType === 'audio/mp4') || data.audioStreams[0];
                
                // A MÁGICA FINAL: Em vez de baixar o arquivo para o Railway (e tomar banimento de IP), 
                // nós emitimos um comando 302 Redirecionar. O navegador do seu usuário muda de rota
                // silenciosamente e toca o áudio puro direto do proxy do Piped!
                return res.redirect(bestAudio.url);
            }
        } catch (err) {
            console.log(`Falha ao tentar a instância proxy: ${api}`);
        }
    }

    // Se TODAS as APIs do Piped sofrerem queda simultânea, o super-fallback para a rede Invidious
    const invidiousFallback = `https://invidious.slipfox.xyz/latest_version?id=${videoId}&itag=140`;
    res.redirect(invidiousFallback);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Backend Inteligente rodando na porta ${PORT}`);
});
