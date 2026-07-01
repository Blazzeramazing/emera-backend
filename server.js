const express = require('express');
const cors = require('cors');
const yts = require('yt-search');
const ytdl = require('@distube/ytdl-core');
const https = require('https');

const app = express();

// Permite que o Front-end (Vercel) acesse este servidor
app.use(cors({ origin: '*' }));

// --- ROTA 1: PESQUISA NATIVA NO YOUTUBE ---
// Em vez de usar APIs de terceiros que caem, o próprio servidor 
// faz a varredura nativa no YouTube.
app.get('/search', async (req, res) => {
    const query = req.query.q;
    if (!query) return res.status(400).json({ error: 'Digite o nome da música.' });

    try {
        // Busca a música + "audio" para priorizar faixas oficiais de estúdio
        const r = await yts(query + ' audio');
        const videos = r.videos.slice(0, 15);

        // Formata o resultado exatamente como o seu Player (Front-end) espera ler
        const formattedResults = videos.map(v => ({
            id: v.videoId,
            name: v.title,
            image: [{ quality: '500x500', link: v.thumbnail }],
            downloadUrl: [{ quality: '320kbps', link: v.videoId }], // Devolve o ID do vídeo
            artists: { primary: [{ name: v.author.name }] }
        }));

        res.json({ data: { results: formattedResults } });
    } catch (error) {
        console.error('Erro na pesquisa:', error);
        res.status(500).json({ error: 'Erro ao pesquisar no YouTube' });
    }
});

// --- ROTA 2: STREAMING DE ÁUDIO DIRETO ---
app.get('/stream', async (req, res) => {
    const urlOrId = req.query.url; 
    if (!urlOrId) return res.status(400).send('ID ausente');

    // Correção do Bug do Jamendo:
    // Se a requisição já for um link de áudio completo (como as músicas de emergência),
    // o servidor apenas atua como ponte (proxy) para liberar o CORS para as partículas.
    if (urlOrId.startsWith('http')) {
        https.get(urlOrId, (audioStream) => {
            res.writeHead(audioStream.statusCode, {
                'Content-Type': audioStream.headers['content-type'] || 'audio/mpeg',
                'Access-Control-Allow-Origin': '*'
            });
            audioStream.pipe(res);
        }).on('error', (err) => {
            res.status(500).send('Erro ao transmitir link direto.');
        });
        return;
    }

    // Se for uma música do YouTube (ID), usa o motor ytdl-core
    try {
        // Extrai o áudio em tempo real com a melhor qualidade
        const stream = ytdl(urlOrId, {
            filter: 'audioonly',
            quality: 'highestaudio'
        });

        // Envia os cabeçalhos de liberação para o visualizador (Canvas) funcionar
        res.setHeader('Content-Type', 'audio/mpeg');
        res.setHeader('Access-Control-Allow-Origin', '*');

        // Transmite a música pedaço por pedaço para o celular do usuário
        stream.pipe(res);
    } catch (error) {
        console.error('Erro ao extrair áudio:', error);
        res.status(500).send('Erro ao processar o áudio do YouTube');
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Motor Backend Emera (YouTube Nativo) rodando na porta ${PORT}`);
});
