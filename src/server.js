// Local server: serves public/ and tells the host screen your laptop's network address,
// so the lobby QR code works for phones on the same Wi-Fi. The game and Claude run inside SpacetimeDB.
import express from 'express';
import os from 'node:os';

const PORT = Number(process.env.PORT || 8080);
const app = express();

// your laptop's address on the local network (Wi-Fi or hotspot), e.g. 192.168.1.42
function lanIp() {
  if (process.env.LAN_IP) return process.env.LAN_IP; // e.g. LAN_IP=172.20.10.2 npm start, if the wrong network gets picked
  const all = Object.entries(os.networkInterfaces()).flatMap(([name, list]) => (list || []).map(a => ({ name, ...a })));
  const v4 = all.filter(a => a.family === 'IPv4' && !a.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address));
  return (v4.find(a => /^(en|wl|eth)/.test(a.name)) || v4[0])?.address || null;
}

app.get('/lan.json', (_req, res) => res.json({ ip: lanIp(), port: PORT }));
// override public/config.js, e.g. STDB_URI=wss://maincloud.spacetimedb.com STDB_DB=my-db npm start
if (process.env.STDB_URI) app.get('/config.js', (_req, res) => res.type('application/javascript').send(`window.STDB = ${JSON.stringify({ uri: process.env.STDB_URI, db: process.env.STDB_DB || 'second-thoughts' })};`));
app.use(express.static('public'));

app.listen(PORT, '0.0.0.0', () => {
  const ip = lanIp();
  console.log(`\nSecond Thoughts is running!\n`);
  console.log(`  big screen:  http://localhost:${PORT}`);
  console.log(ip ? `  phones:      http://${ip}:${PORT}   (same Wi-Fi; the lobby QR code points here)` : '  phones:      no Wi-Fi network found. Connect to Wi-Fi or a hotspot and restart.');
  console.log(`\n  make sure the database is running in another tab: npm run db\n`);
});