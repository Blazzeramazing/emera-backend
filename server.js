const express = require('express');
const cors = require('cors');
const https = require('https');
const crypto = require('crypto');

const app = express();

app.use(cors({ origin: '*' }));

const SAAVN_KEY = '38346591';

// Função que quebra a encriptação da plataforma e revela o link direto .mp4
function decryptSaavnUrl(encryptedUrl) {
    try {
        const key = Buffer.from(SAAVN_KEY, 'utf8');
        const decipher = crypto.createDecipheriv('des-ecb', key, '');
        let decrypted = decipher.update(encryptedUrl, 'base64', 'utf8');
        decrypted += decipher.final('utf8');
        
        // As músicas vêm a 96kbps por padrão, forçamos o CDN a entregar a versão 160kbps (Alta Qualidade)
        return decrypted.replace('_96.mp4', '_160.mp4').replace('_96_p.mp4', '_160.mp4');
    } catch (e) {
        console.error("Erro ao desencriptar link:", e);
        return null;
    }
}

app.get('/search', async (req, res) => {
    const query = req.query.q;
    if (!query) return res.status(400).json({ error: 'Digite o nome da música.' });

    try {
        // Pesquisa ultrarrápida (Sem bloqueios de IP!)
        const searchUrl = `https://www.jiosaavn.com/api.php?__call=search.getResults&q=${encodeURIComponent(query)}&_format=json&_marker=0&api_version=4&ctx=web6dot0&n=15`;
        
        const response = await fetch(searchUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
                'Accept': 'application/json'
            }
        });
        
        const data = await response.json();

        if (!data.results || data.results.length === 0) {
            return res.json({ data: { results: [] } });
        }

        // Mapear para o exato formato que o seu index.html espera!
        const formattedResults = data.results.map(song => {
            let decryptedLink = null;
            if (song.more_info && song.more_info.encrypted_media_url) {
                decryptedLink = decryptSaavnUrl(song.more_info.encrypted_media_url);
            }

            // Limpar códigos HTML estranhos nos nomes das músicas
            const cleanTitle = song.title.replace(/&amp;/g, '&').replace(/&quot;/g, '"');
            const cleanArtist = (song.more_info?.primary_artists || song.subtitle || "Desconhecido").replace(/&amp;/g, '&');
            const highResImage = song.image.replace('150x150', '500x500'); // Puxa a Capa do Álbum em HD

            return {
                id: song.id,
                name: cleanTitle,
                image: [{ quality: '500x500', link: highResImage }],
                downloadUrl: [{ quality: '160kbps', link: decryptedLink }],
                artists: { primary: [{ name: cleanArtist }] }
            };
        }).filter(s => s.downloadUrl[0].link !== null); // Remove as faixas que não tenham link de áudio

        res.json({ data: { results: formattedResults } });
    } catch (error) {
        console.error('Erro na pesquisa:', error);
        res.status(500).json({ error: 'Erro ao pesquisar música' });
    }
});

app.get('/stream', (req, res) => {
    const audioUrl = req.query.url;
    if (!audioUrl) return res.status(400).send('URL ausente');

    const headers = { 
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'Accept': '*/*'
    };
    
    // Repassa os Range Headers (Isto é o que permite clicar na barra para avançar a música sem crashar)
    if (req.headers.range) {
        headers['Range'] = req.headers.range;
    }

    const request = https.get(audioUrl, { headers }, (streamRes) => {
        // Seguir possíveis redirecionamentos do CDN
        if (streamRes.statusCode >= 300 && streamRes.statusCode < 400 && streamRes.headers.location) {
            return res.redirect(streamRes.headers.location);
        }

        if (streamRes.statusCode >= 400) {
            return res.status(streamRes.statusCode).send('Bloqueado pelo CDN');
        }

        // Headers essenciais para o Chrome e Safari reconhecerem como ficheiro de áudio
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Content-Type', streamRes.headers['content-type'] || 'audio/mp4');
        if (streamRes.headers['content-length']) res.setHeader('Content-Length', streamRes.headers['content-length']);
        if (streamRes.headers['content-range']) res.setHeader('Content-Range', streamRes.headers['content-range']);
        res.setHeader('Accept-Ranges', 'bytes');
        res.status(streamRes.statusCode);

        // Faz a ponte perfeita entre o CDN e o seu Vercel
        streamRes.pipe(res);
    });

    request.on('error', (err) => {
        console.error('Erro no túnel:', err);
        if (!res.headersSent) res.status(500).end();
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Backend Musical (Nova Fonte - Saavn Direct) rodando na porta ${PORT}`);
});
