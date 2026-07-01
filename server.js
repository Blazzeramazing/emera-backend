const express = require('express');
const cors = require('cors');
const https = require('https');

const app = express();

// Permite que o seu site hospedado na Vercel acesse este servidor
app.use(cors({ origin: '*' }));

// --- O SEGREDO MILIONÁRIO: MUDAMOS DE JIOSAAVN PARA YOUTUBE (Via Piped API) ---
// O YouTube não sofre quedas de DMCA e tem TODAS as músicas do mundo!
const PIPED_INSTANCES = [
    'https://pipedapi.kavin.rocks',
    'https://pipedapi.tokhmi.xyz',
    'https://pipedapi.syncpundit.io',
    'https://pipedapi.smnz.de'
];

// --- ROTA 1: PESQUISA (Agora busca no YouTube Music) ---
app.get('/search', async (req, res) => {
    const query = req.query.q;
    if (!query) return res.status(400).json({ error: 'Digite o nome da música.' });

    for (const baseUrl of PIPED_INSTANCES) {
        try {
            // Busca a música no YouTube Music (filter=music_songs garante que pegamos músicas oficiais e não videoclipes amadores)
            const response = await fetch(`${baseUrl}/search?q=${encodeURIComponent(query)}&filter=music_songs`);
            if (!response.ok) continue; // Se este espelho falhar, tenta o próximo
            
            const data = await response.json();
            
            if (data && data.items && data.items.length > 0) {
                // Aqui está a mágica: Transformamos o resultado do YouTube para ficar 
                // EXATAMENTE igual ao formato do JioSaavn que o seu Front-end já entende!
                const formattedResults = data.items.slice(0, 15).map(item => {
                    // Pega o ID do vídeo na URL
                    const videoId = item.url.split('?v=')[1] || item.url.split('/').pop();
                    
                    return {
                        id: videoId,
                        name: item.title,
                        image: [{ quality: '500x500', link: item.thumbnail }],
                        // Em vez do link direto, enviamos o ID do vídeo para a nossa Rota 2 extrair
                        downloadUrl: [{ quality: '320kbps', link: videoId }],
                        artists: { primary: [{ name: item.uploaderName }] }
                    };
                });
                
                return res.json({ data: { results: formattedResults } }); 
            }
        } catch (error) {
            console.error(`O espelho falhou (tentando o próximo): ${baseUrl}`);
        }
    }

    res.status(500).json({ error: 'Todos os servidores globais falharam no momento.' });
});

// --- ROTA 2: STREAMING (Extrai o áudio puro do YouTube e envia para o PWA) ---
app.get('/stream', async (req, res) => {
    const videoId = req.query.url; 
    if (!videoId) return res.status(400).send('ID do áudio ausente');

    let streamUrl = null;

    // 1. Pergunta aos servidores qual é o link oculto do áudio em alta qualidade
    for (const baseUrl of PIPED_INSTANCES) {
        try {
            const response = await fetch(`${baseUrl}/streams/${videoId}`);
            if (!response.ok) continue;
            
            const data = await response.json();
            if (data && data.audioStreams && data.audioStreams.length > 0) {
                // Escolhe a melhor qualidade de áudio (maior bitrate, geralmente .m4a)
                const bestAudio = data.audioStreams.sort((a, b) => b.bitrate - a.bitrate)[0];
                streamUrl = bestAudio.url;
                break;
            }
        } catch (error) {
            console.error(`Falha ao extrair stream de: ${baseUrl}`);
        }
    }

    if (!streamUrl) {
        return res.status(500).send('Não foi possível extrair o áudio do YouTube.');
    }

    // 2. Faz o download em tempo real do áudio e "Pipa" (transmite) para o celular
    const options = {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36'
        }
    };

    https.get(streamUrl, options, (audioStream) => {
        // Envia os cabeçalhos mágicos para liberar o CORS no seu visualizador
        res.writeHead(audioStream.statusCode, {
            'Content-Type': audioStream.headers['content-type'] || 'audio/mp4',
            'Content-Length': audioStream.headers['content-length'],
            'Accept-Ranges': 'bytes',
            'Access-Control-Allow-Origin': '*' // A MÁGICA: CORS liberado para os seus Canvas!
        });
        
        audioStream.pipe(res);
    }).on('error', (err) => {
        console.error("Erro de Streaming:", err);
        res.status(500).send('Erro ao transmitir o áudio');
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Motor Backend do Emera rodando na porta ${PORT}`);
});
