const express = require('express');
const cors = require('cors');
const https = require('https');

const app = express();

// Permite que o seu site hospedado na Vercel acesse este servidor
app.use(cors({ origin: '*' }));

// --- ROTA 1: PESQUISA (Contorna o bloqueio de país) ---
app.get('/search', async (req, res) => {
    const query = req.query.q;
    if (!query) return res.status(400).json({ error: 'Digite o nome da música.' });

    try {
        // O Render hospeda isso nos EUA, então a API do JioSaavn não bloqueia o acesso!
        const response = await fetch(`https://saavn.dev/api/search/songs?query=${encodeURIComponent(query)}`);
        const data = await response.json();
        res.json(data);
    } catch (error) {
        console.error("Erro na busca:", error);
        res.status(500).json({ error: 'Falha na comunicação com a API de música.' });
    }
});

// --- ROTA 2: STREAMING (Contorna o CORS e protege o formato do áudio) ---
app.get('/stream', (req, res) => {
    const audioUrl = req.query.url;
    if (!audioUrl) return res.status(400).send('URL do áudio ausente');

    // O servidor baixa o áudio do CDN blindado e envia para o usuário em "doses" (Stream)
    https.get(audioUrl, (audioStream) => {
        // Repassa os cabeçalhos originais para o navegador entender que é música
        res.writeHead(audioStream.statusCode, {
            'Content-Type': audioStream.headers['content-type'] || 'audio/mp4',
            'Content-Length': audioStream.headers['content-length'],
            'Accept-Ranges': 'bytes',
            'Access-Control-Allow-Origin': '*' // A MÁGICA ACONTECE AQUI: CORS liberado para os seus Canvas!
        });
        
        // Pipa (conecta o tubo) do áudio da Índia/EUA direto para o celular no Brasil
        audioStream.pipe(res);
    }).on('error', (err) => {
        console.error("Erro de Streaming:", err);
        res.status(500).send('Erro ao transmitir o áudio');
    });
});

// Inicializa o servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Motor Backend do Emera rodando na porta ${PORT}`);
});
