const express = require('express');
const path    = require('path');
const { createClient } = require('@supabase/supabase-js');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Supabase clients ──
const supabaseUrl     = process.env.SUPABASE_URL;
const supabaseAnon    = process.env.SUPABASE_ANON_KEY;
const supabaseService = process.env.SUPABASE_SERVICE_KEY;

// Service role: bypast RLS voor server-side queries
const db = createClient(supabaseUrl, supabaseService || supabaseAnon);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ════════════════════════════════════════════════
//  AUTH MIDDLEWARE
//  Valideert Bearer token en hangt user+profile
//  aan req.user / req.profile
// ════════════════════════════════════════════════
async function requireAuth(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Niet ingelogd' });

  const { data: { user }, error } = await db.auth.getUser(token);
  if (error || !user) return res.status(401).json({ error: 'Ongeldig token' });

  const { data: profile } = await db
    .from('users')
    .select('id, name, email, role, client_id')
    .eq('id', user.id)
    .single();

  if (!profile) return res.status(403).json({ error: 'Gebruiker niet gekoppeld' });

  req.user    = user;
  req.profile = profile;
  next();
}

// Alleen owner mag bepaalde acties
function requireOwner(req, res, next) {
  if (req.profile.role !== 'owner') {
    return res.status(403).json({ error: 'Alleen owners mogen dit doen' });
  }
  next();
}

// ════════════════════════════════════════════════
//  CONFIG  (publiek — voor frontend Supabase init)
// ════════════════════════════════════════════════
app.get('/api/config', (req, res) => {
  res.json({ supabaseUrl, supabaseAnon });
});

// ════════════════════════════════════════════════
//  ME  (huidig gebruikersprofiel)
// ════════════════════════════════════════════════
app.get('/api/me', async (req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Geen token' });

  const { data: { user }, error } = await db.auth.getUser(token);
  if (error || !user) return res.status(401).json({ error: 'Ongeldig token' });

  const { data: profile, error: profileError } = await db
    .from('users')
    .select('id, name, email, role, avatar_color, client_id, clients(id, name, initials, slug)')
    .eq('id', user.id)
    .single();

  if (profileError || !profile) {
    return res.status(404).json({ error: 'Gebruiker niet gevonden in database' });
  }

  res.json({ user: profile });
});

// ════════════════════════════════════════════════
//  USERS
// ════════════════════════════════════════════════

// GET /api/users — alle gebruikers van de klant
app.get('/api/users', requireAuth, async (req, res) => {
  const { data, error } = await db
    .from('users')
    .select('id, name, email, role, avatar_color, is_active, added_at, last_login_at')
    .eq('client_id', req.profile.client_id)
    .order('added_at', { ascending: true });

  if (error) return res.status(500).json({ error: error.message });
  res.json({ users: data });
});

// PUT /api/users/:id — rol wijzigen (owner only)
app.put('/api/users/:id', requireAuth, requireOwner, async (req, res) => {
  const { role } = req.body;
  const validRoles = ['admin', 'member', 'viewer'];
  if (!validRoles.includes(role)) {
    return res.status(400).json({ error: 'Ongeldige rol' });
  }

  const { data, error } = await db
    .from('users')
    .update({ role })
    .eq('id', req.params.id)
    .eq('client_id', req.profile.client_id) // mag alleen eigen klant
    .neq('role', 'owner')                   // owner mag niet gewijzigd worden
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ user: data });
});

// DELETE /api/users/:id — gebruiker verwijderen (owner only)
app.delete('/api/users/:id', requireAuth, requireOwner, async (req, res) => {
  if (req.params.id === req.profile.id) {
    return res.status(400).json({ error: 'Je kunt jezelf niet verwijderen' });
  }

  const { error } = await db
    .from('users')
    .delete()
    .eq('id', req.params.id)
    .eq('client_id', req.profile.client_id)
    .neq('role', 'owner');

  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ════════════════════════════════════════════════
//  INVITATIONS
// ════════════════════════════════════════════════

// GET /api/invitations — openstaande uitnodigingen
app.get('/api/invitations', requireAuth, async (req, res) => {
  const { data, error } = await db
    .from('invitations')
    .select('id, email, role, invited_at, expires_at, accepted')
    .eq('client_id', req.profile.client_id)
    .eq('accepted', false)
    .gt('expires_at', new Date().toISOString())
    .order('invited_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json({ invitations: data });
});

// POST /api/invitations — uitnodiging versturen (owner only)
app.post('/api/invitations', requireAuth, requireOwner, async (req, res) => {
  const { email, role } = req.body;
  const validRoles = ['admin', 'member', 'viewer'];

  if (!email) return res.status(400).json({ error: 'E-mailadres vereist' });
  if (!validRoles.includes(role)) return res.status(400).json({ error: 'Ongeldige rol' });

  // Controleer of gebruiker al bestaat
  const { data: existing } = await db
    .from('users')
    .select('id')
    .eq('email', email)
    .eq('client_id', req.profile.client_id)
    .single();

  if (existing) return res.status(400).json({ error: 'Dit e-mailadres is al actief als gebruiker' });

  // Sla uitnodiging op in database
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data: invitation, error: invError } = await db
    .from('invitations')
    .insert({
      client_id:  req.profile.client_id,
      email,
      role,
      expires_at: expiresAt
    })
    .select()
    .single();

  if (invError) return res.status(500).json({ error: invError.message });

  // Stuur magic link via Supabase Auth
  const { error: authError } = await db.auth.admin.inviteUserByEmail(email, {
    redirectTo: `${process.env.APP_URL || 'https://ab-content-bot-production.up.railway.app'}`
  });

  if (authError) {
    // Auth fout — verwijder de uitnodiging weer
    await db.from('invitations').delete().eq('id', invitation.id);
    return res.status(500).json({ error: authError.message });
  }

  res.json({ invitation });
});

// DELETE /api/invitations/:id — uitnodiging intrekken (owner only)
app.delete('/api/invitations/:id', requireAuth, requireOwner, async (req, res) => {
  const { error } = await db
    .from('invitations')
    .delete()
    .eq('id', req.params.id)
    .eq('client_id', req.profile.client_id);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// POST /api/invitations/:id/resend — uitnodiging opnieuw sturen (owner only)
app.post('/api/invitations/:id/resend', requireAuth, requireOwner, async (req, res) => {
  const { data: inv } = await db
    .from('invitations')
    .select('email')
    .eq('id', req.params.id)
    .eq('client_id', req.profile.client_id)
    .single();

  if (!inv) return res.status(404).json({ error: 'Uitnodiging niet gevonden' });

  // Verlenging: zet expires_at 7 dagen vooruit
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  await db.from('invitations').update({ expires_at: expiresAt }).eq('id', req.params.id);

  const { error } = await db.auth.admin.inviteUserByEmail(inv.email, {
    redirectTo: `${process.env.APP_URL || 'https://ab-content-bot-production.up.railway.app'}`
  });

  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ════════════════════════════════════════════════
//  SPA CATCH-ALL
// ════════════════════════════════════════════════
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Arthur & Brent AI Content Bot draait op poort ${PORT}`);
});
