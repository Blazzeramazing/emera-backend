const express = require('express');
const cors = require('cors');
const https = require('https');
const http = require('http'); // Necessário caso o redirecionamento seja para http
const crypto = require('crypto');

const app = express();

app.use(cors({ origin: '*' }));

const SAAVN_KEY = '38346591';

// Função para quebrar a encriptação dos links de alta qualidade
function decryptSaavnUrl(encryptedUrl) {
    try {
        const key = Buffer.from(SAAVN_KEY, 'utf8');
        const decipher = crypto.createDecipheriv('des-ecb', key, '');
        let decrypted = decipher.update(encryptedUrl, 'base64', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted.replace('_96.mp4', '_160.mp4').replace('_96_p.mp4', '_160.mp4');
    } catch (e) {
        console.error("Erro ao desencriptar:", e);
        return null;
    }
}

app.get('/search', (req, res) => {
    const query = req.query.q;
    if (!query) return res.status(400).json({ error: 'Digite o nome da música.' });

    const searchUrl = `https://www.jiosaavn.com/api.php?__call=search.getResults&q=${encodeURIComponent(query)}&_format=json&_marker=0&api_version=4&ctx=web6dot0&n=15`;

    https.get(searchUrl, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
            'Accept': 'application/json'
        }
    }, (apiRes) => {
        let data = '';
        apiRes.on('data', chunk => data += chunk);
        apiRes.on('end', () => {
            try {
                const json = JSON.parse(data);
                if (!json.results || json.results.length === 0) {
                    return res.json({ data: { results: [] } });
                }

                const formattedResults = json.results.map(song => {
                    let decryptedLink = null;
                    if (song.more_info && song.more_info.encrypted_media_url) {
                        decryptedLink = decryptSaavnUrl(song.more_info.encrypted_media_url);
                    }

                    const cleanTitle = song.title.replace(/&amp;/g, '&').replace(/&quot;/g, '"');
                    const cleanArtist = (song.more_info?.primary_artists || song.subtitle || "Desconhecido").replace(/&amp;/g, '&');
                    const highResImage = song.image.replace('150x150', '500x500');

                    return {
                        id: song.id,
                        name: cleanTitle,
                        image: [{ quality: '500x500', link: highResImage }],
                        downloadUrl: [{ quality: '160kbps', link: decryptedLink }],
                        artists: { primary: [{ name: cleanArtist }] }
                    };
                }).filter(s => s.downloadUrl[0].link !== null);

                res.json({ data: { results: formattedResults } });
            } catch (e) {
                res.status(500).json({ error: 'Erro ao processar dados da plataforma.' });
            }
        });
    }).on('error', () => res.status(500).json({ error: 'Falha na conexão de pesquisa.' }));
});

app.get('/stream', (req, res) => {
    const audioUrl = req.query.url;
    if (!audioUrl) return res.status(400).send('URL ausente');

    // Função recursiva para seguir redirecionamentos (Resolve o bloqueio do Jamendo/Saavn)
    function handleStream(targetUrl, redirectCount = 0) {
        if (redirectCount > 5) return res.status(502).send('Muitos redirecionamentos');

        const client = targetUrl.startsWith('https') ? https : http;
        const headers = { 
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': '*/*'
        };
        
        // Muito importante para poder clicar na barra de progresso da música
        if (req.headers.range) headers['Range'] = req.headers.range;

        client.get(targetUrl, { headers }, (streamRes) => {
            // O SEGREDO: Em vez de enviar o 302 para o Vercel (o que causaria erro de CORS),
            // o próprio servidor Railway segue a rota silenciosamente e busca o MP4 verdadeiro!
            if (streamRes.statusCode >= 300 && streamRes.statusCode < 400 && streamRes.headers.location) {
                let nextUrl = streamRes.headers.location;
                if (!nextUrl.startsWith('http')) {
                    const urlObj = new URL(targetUrl);
                    nextUrl = `${urlObj.protocol}//${urlObj.host}${nextUrl}`;
                }
                return handleStream(nextUrl, redirectCount + 1);
            }

            if (streamRes.statusCode >= 400) {
                return res.status(streamRes.statusCode).send('Bloqueado pela Fonte');
            }

            // Headers essenciais de CORS Injetados (Isto impede o NotSupportedError no browser)
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', streamRes.headers['content-type'] || 'audio/mp4');
            
            if (streamRes.headers['content-length']) res.setHeader('Content-Length', streamRes.headers['content-length']);
            if (streamRes.headers['content-range']) res.setHeader('Content-Range', streamRes.headers['content-range']);
            res.setHeader('Accept-Ranges', 'bytes');
            
            res.status(streamRes.statusCode);

            // Repassa o áudio real para o Vercel de forma limpa!
            streamRes.pipe(res);
        }).on('error', (err) => {
            console.error('Erro no túnel:', err);
            if (!res.headersSent) res.status(500).end();
        });
    }

    handleStream(audioUrl);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Backend Musical (Proxy Reverso Direto) rodando na porta ${PORT}`);
});
