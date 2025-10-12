require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const validator = require('validator');

const app = express();
const PORT = process.env.PORT || 3000;

const token = process.env.token || "";
const accesskey = process.env.accesskey || "";
const tokenBot = process.env.tokenBot || "";
const chatIds = process.env.chatIds || "";

app.use(helmet());
const deployLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  message: { error: 'Terlalu banyak percobaan, coba lagi nanti' }
});

app.use(express.json());
const upload = multer({ storage: multer.memoryStorage() });

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

async function fetch(url, opts) {
  return (await import('node-fetch')).default(url, opts);
}

async function isSiteLive(url) {
  try {
    const res = await fetch(url, { method: 'HEAD', timeout: 5000 });
    return res.ok;
  } catch {
    return false;
  }
}

function keyGate(req, res, next) {
  const key = req.headers['x-access-key'] || req.query.key;
  if (!accesskey || key === accesskey) return next();
  return res.status(401).json({ error: 'Access key salah atau tidak ada' });
}

async function getUniqueName(rawName) {
  const base = rawName.trim().toLowerCase().replace(/[^a-z0-9-_]/g, '').slice(0, 30);
  let name = base;
  let attempts = 0;

  const randomLetters = (length = 3) => {
    const chars = 'abcdefghijklmnopqrstuvwxyz';
    let result = '';
    for (let i = 0; i < length; i++) result += chars[Math.floor(Math.random() * chars.length)];
    return result;
  };

  for (let i = 0; i < 3; i++) {
    if (!(await isSiteLive(`https://${name}.vercel.app`))) return name;
    const suffix = randomLetters(Math.random() > 0.5 ? 3 : 4);
    name = `${base}${suffix}`;
    if (++attempts > 99) throw new Error('Terlalu banyak percobaan nama');
  }
  throw new Error('Nama masih terpakai setelah 3x cek');
}

async function logTelegram(file, url) {
  if (!tokenBot || !chatIds) return;
  const text =
    `TERDETEKSI DEPLOY WEB\n` +
    `File : ${file}\n` +
    `Link : ${url}\n` +
    `Jam  : ${new Date().toLocaleString('id-ID')}`;
  const ids = chatIds.split(',').map(id => id.trim());
  for (const id of ids) {
    await fetch(`https://api.telegram.org/bot${tokenBot}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: id, text })
    });
  }
}

app.post('/deploy', deployLimiter, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'File HTML tidak diterima' });
    if (path.extname(req.file.originalname).toLowerCase() !== '.html') return res.status(400).json({ error: 'Hanya menerima file .html' });
    if (!token) return res.status(500).json({ error: 'token belum di-set' });

    const rawName = validator.escape((req.body.name || req.file.originalname.replace('.html', '')).trim());
    if (!rawName || rawName.length < 2 || rawName.length > 30) return res.status(400).json({ error: 'Nama project 2-30 karakter' });

    let name = await getUniqueName(rawName);
    for (let i = 0; i < 2; i++) {
      if (!(await isSiteLive(`https://${name}.vercel.app`))) break;
      name = await getUniqueName(rawName);
    }

    const base64 = req.file.buffer.toString('base64');

    const createRes = await fetch('https://api.vercel.com/v9/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name })
    });
    if (!createRes.ok) throw new Error('Gagal bikin project: ' + await createRes.text());

    const deployRes = await fetch('https://api.vercel.com/v13/deployments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        name,
        target: 'production',
        files: [{ file: 'index.html', data: base64, encoding: 'base64' }],
        projectSettings: { framework: null }
      })
    });
    const deployJson = await deployRes.json();
    if (!deployRes.ok) throw new Error(JSON.stringify(deployJson));

    const url = `https://${name}.vercel.app`;
    await logTelegram(req.file.originalname, url);
    res.json({ message: 'Deploy sukses', url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Deploy gagal' });
  }
});

app.get('/projects', keyGate, async (_req, res) => {
  try {
    const response = await fetch('https://api.vercel.com/v9/projects', {
      headers: { Authorization: `Bearer ${token}` }
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || 'Gagal ambil daftar');
    res.json({ projects: data.projects || [] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Gagal list project' });
  }
});

app.delete('/projects/:name', keyGate, async (req, res) => {
  const { name } = req.params;
  try {
    const delRes = await fetch(`https://api.vercel.com/v9/projects/${name}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` }
    });
    if (delRes.status === 204) return res.json({ message: `Project '${name}' terhapus` });
    const err = await delRes.json();
    throw new Error(err.error?.message || `Hapus gagal (${delRes.status})`);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Gagal delete project' });
  }
});

if (require.main === module) {
  app.listen(PORT, () => console.log(`Listening on http://localhost:${PORT}`));
}

module.exports = app;
