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

    // Sistema de Espelhos (Fallbacks) - Se um falhar, tenta o próximo!
    const apis = [
        `https://saavn.echomusic.fun/api/search/songs?query=${encodeURIComponent(query)}`,
        `https://jiosaavn-api-sigma-sandy.vercel.app/api/search/songs?query=${encodeURIComponent(query)}`,
        `https://saavn.me/search/songs?query=${encodeURIComponent(query)}`
    ];

    for (const url of apis) {
        try {
            const response = await fetch(url);
            const data = await response.json();
            
            // Verifica se a API retornou resultados válidos
            if (data && data.data && data.data.results && data.data.results.length > 0) {
                return res.json(data); // Se funcionou, devolve a música e para de procurar!
            }
        } catch (error) {
            console.error(`O espelho falhou (tentando o próximo): ${url}`);
        }
    }

    // Se o código chegar aqui, é porque todos os servidores globais caíram
    res.status(500).json({ error: 'Todos os servidores globais falharam no momento.' });
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
