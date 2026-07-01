const express = require('express');
const cors = require('cors');
const yts = require('yt-search');
const ytdl = require('@distube/ytdl-core');
const https = require('https');

const app = express();

// Permite acesso de qualquer Frontend
app.use(cors({ origin: '*' }));

// --- ROTA 1: PESQUISA NATIVA ---
app.get('/search', async (req, res) => {
    const query = req.query.q;
    if (!query) return res.status(400).json({ error: 'Digite o nome da música.' });

    try {
        const r = await yts(query + ' audio');
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
        res.status(500).json({ error: 'Erro ao pesquisar no YouTube' });
    }
});

// --- ROTA 2: STREAMING COM ESCUDO ANTI-CRASH ---
app.get('/stream', async (req, res) => {
    const urlOrId = req.query.url; 
    if (!urlOrId) return res.status(400).send('ID ausente');

    // Se for link direto (Músicas de emergência)
    if (urlOrId.startsWith('http')) {
        https.get(urlOrId, (audioStream) => {
            res.writeHead(audioStream.statusCode, {
                'Content-Type': audioStream.headers['content-type'] || 'audio/mpeg',
                'Access-Control-Allow-Origin': '*'
            });
            audioStream.pipe(res);
        }).on('error', () => {
            res.status(500).send('Erro no link direto');
        });
        return;
    }

    // Se for ID do YouTube
    const videoUrl = `https://www.youtube.com/watch?v=${urlOrId}`;

    try {
        const stream = ytdl(videoUrl, {
            filter: 'audioonly',
            quality: 'highestaudio',
            highWaterMark: 1 << 25 // Buffer gigante para evitar cortes
        });

        // Só envia os cabeçalhos de sucesso quando o áudio estiver pronto
        stream.on('info', () => {
            if (!res.headersSent) {
                res.setHeader('Content-Type', 'audio/mpeg');
                res.setHeader('Access-Control-Allow-Origin', '*');
                res.setHeader('Transfer-Encoding', 'chunked');
            }
        });

        // O ESCUDO: Se o YouTube bloquear o Railway, ele não desliga o servidor!
        stream.on('error', (err) => {
            console.error(`[YTDL Bloqueado pelo YouTube] ${urlOrId}:`, err.message);
            if (!res.headersSent) {
                res.status(500).send('Servidor impedido de baixar o áudio.');
            } else {
                res.end(); // Termina suavemente
            }
        });

        stream.pipe(res);
    } catch (error) {
        console.error('Catch Error:', error);
        if (!res.headersSent) res.status(500).send('Erro interno');
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Backend Emera rodando e blindado na porta ${PORT}`);
});
