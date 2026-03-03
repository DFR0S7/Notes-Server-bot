import express from 'express';

const app = express();
const PORT = process.env.PORT || 3000;

app.get('/ping', (_req, res) => res.send('pong'));
app.get('/', (_req, res) => res.send('Notes Server Bot is running'));

app.listen(PORT, () => console.log(`HTTP server on port ${PORT}`));
