const express = require('express');
const path    = require('path');
const { createClient } = require('@supabase/supabase-js');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Supabase admin client (service role voor server-side checks) ──
const supabaseUrl    = process.env.SUPABASE_URL;
const supabaseAnon   = process.env.SUPABASE_ANON_KEY;
const supabaseServer = createClient(supabaseUrl, supabaseAnon);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Geef Supabase config door aan de frontend ──
app.get('/api/config', (req, res) => {
  res.json({
    supabaseUrl:  supabaseUrl,
    supabaseAnon: supabaseAnon
  });
});

// ── Haal profiel op van ingelogde user (via Bearer token) ──
app.get('/api/me', async (req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Geen token' });

  // Valideer token bij Supabase
  const { data: { user }, error } = await supabaseServer.auth.getUser(token);
  if (error || !user) return res.status(401).json({ error: 'Ongeldig token' });

  // Haal gebruikersprofiel op uit onze users tabel
  const { data: profile, error: profileError } = await supabaseServer
    .from('users')
    .select('id, name, email, role, avatar_color, client_id, clients(id, name, initials, slug)')
    .eq('id', user.id)
    .single();

  if (profileError || !profile) {
    return res.status(404).json({ error: 'Gebruiker niet gevonden in database' });
  }

  res.json({ user: profile });
});

// ── Alle andere routes → index.html (SPA) ──
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Arthur & Brent AI Content Bot draait op poort ${PORT}`);
});
