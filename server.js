import express from 'express';

const app = express();
const PORT = process.env.PORT || 10000;

app.get('/', (_req, res) => res.type('text').send('ROOT OK'));
app.get('/health', (_req, res) => res.json({ ok: true, tag: 'health' }));
app.get('/v1/health', (_req, res) => res.json({ ok: true, tag: 'health-v1' }));

app.listen(PORT, () => {
  console.log('TEST API listening on http://localhost:' + PORT);
});
