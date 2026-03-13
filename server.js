const express = require('express');
const path    = require('path');
const { createClient } = require('@supabase/supabase-js');

const app  = express();
const PORT = process.env.PORT || 3000;

const supabaseUrl     = process.env.SUPABASE_URL;
const supabaseAnon    = process.env.SUPABASE_ANON_KEY;
const supabaseService = process.env.SUPABASE_SERVICE_KEY;
const resendKey       = process.env.RESEND_API_KEY;
const appUrl          = process.env.APP_URL || 'https://ab-content-bot-production.up.railway.app';

const db = createClient(supabaseUrl, supabaseService || supabaseAnon);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ════════════════════════════════════════════════
//  E-MAIL via Resend
// ════════════════════════════════════════════════
async function sendInviteEmail(toEmail, toName, inviterName, clientName, role, magicLink) {
  const roleLabels = { admin: 'Admin', member: 'Member', viewer: 'Viewer' };
  const roleLabel  = roleLabels[role] || role;

  const html = `
    <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;">
      <img src="https://ab-content-bot-production.up.railway.app/logo-email.png"
           alt="Arthur &amp; Brent" style="height:36px;margin-bottom:24px;">
      <h2 style="font-size:20px;font-weight:600;margin:0 0 8px;">
        Je bent uitgenodigd voor ${clientName}
      </h2>
      <p style="color:#555;font-size:14px;line-height:1.6;margin:0 0 24px;">
        ${inviterName} heeft je uitgenodigd om in te loggen op de
        <strong>Arthur &amp; Brent AI Content Bot</strong> als <strong>${roleLabel}</strong>.
      </p>
      <a href="${magicLink}"
         style="display:inline-block;background:#BBE3FA;color:#0A0A0A;
                text-decoration:none;padding:12px 24px;border-radius:8px;
                font-weight:600;font-size:14px;">
        Inloggen →
      </a>
      <p style="color:#999;font-size:12px;margin-top:24px;line-height:1.5;">
        Deze link is 7 dagen geldig. Werkt de knop niet?<br>
        Kopieer deze URL: <span style="word-break:break-all;">${magicLink}</span>
      </p>
      <hr style="border:none;border-top:1px solid #eee;margin:24px 0;">
      <p style="color:#bbb;font-size:11px;margin:0;">
        Arthur &amp; Brent AI Content Bot — Alleen voor uitgenodigde gebruikers
      </p>
    </div>`;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${resendKey}`
    },
    body: JSON.stringify({
      from:    'Arthur & Brent <no-reply@arthurbrent.nl>',
      to:      [toEmail],
      subject: `Uitnodiging: ${clientName} AI Content Bot`,
      html
    })
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || 'E-mail versturen mislukt');
  }
  return await res.json();
}

// ════════════════════════════════════════════════
//  AUTH MIDDLEWARE
// ════════════════════════════════════════════════
async function requireAuth(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Niet ingelogd' });

  const { data: { user }, error } = await db.auth.getUser(token);
  if (error || !user) return res.status(401).json({ error: 'Ongeldig token' });

  const { data: profile } = await db
    .from('users')
    .select('id, name, email, role, client_id, clients(id, name, initials, slug)')
    .eq('id', user.id)
    .single();

  if (!profile) return res.status(403).json({ error: 'Gebruiker niet gekoppeld' });

  req.user    = user;
  req.profile = profile;
  next();
}

function requireOwner(req, res, next) {
  if (req.profile.role !== 'owner') {
    return res.status(403).json({ error: 'Alleen owners mogen dit doen' });
  }
  next();
}

// ════════════════════════════════════════════════
//  CONFIG
// ════════════════════════════════════════════════
app.get('/api/config', (req, res) => {
  res.json({ supabaseUrl, supabaseAnon });
});

// ════════════════════════════════════════════════
//  ME
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
app.get('/api/users', requireAuth, async (req, res) => {
  const { data, error } = await db
    .from('users')
    .select('id, name, email, role, avatar_color, is_active, added_at, last_login_at')
    .eq('client_id', req.profile.client_id)
    .order('added_at', { ascending: true });

  if (error) return res.status(500).json({ error: error.message });
  res.json({ users: data });
});

app.put('/api/users/:id', requireAuth, requireOwner, async (req, res) => {
  const { role } = req.body;
  if (!['admin','member','viewer'].includes(role)) {
    return res.status(400).json({ error: 'Ongeldige rol' });
  }
  const { data, error } = await db
    .from('users')
    .update({ role })
    .eq('id', req.params.id)
    .eq('client_id', req.profile.client_id)
    .neq('role', 'owner')
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ user: data });
});

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

app.post('/api/invitations', requireAuth, requireOwner, async (req, res) => {
  const { email, role } = req.body;
  if (!email) return res.status(400).json({ error: 'E-mailadres vereist' });
  if (!['admin','member','viewer'].includes(role)) {
    return res.status(400).json({ error: 'Ongeldige rol' });
  }

  // Controleer of gebruiker al bestaat
  const { data: existing } = await db
    .from('users')
    .select('id')
    .eq('email', email)
    .eq('client_id', req.profile.client_id)
    .single();
  if (existing) return res.status(400).json({ error: 'Dit e-mailadres is al actief als gebruiker' });

  // Sla uitnodiging op in database EERST
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data: invitation, error: invError } = await db
    .from('invitations')
    .insert({ client_id: req.profile.client_id, email, role, expires_at: expiresAt })
    .select()
    .single();
  if (invError) return res.status(500).json({ error: invError.message });

  // Genereer magic link via Supabase
  const { data: linkData, error: linkError } = await db.auth.admin.generateLink({
    type: 'magiclink',
    email,
    options: { redirectTo: appUrl }
  });

  if (linkError) {
    await db.from('invitations').delete().eq('id', invitation.id);
    return res.status(500).json({ error: linkError.message });
  }

  // Stuur e-mail via Resend
  try {
    await sendInviteEmail(
      email,
      email.split('@')[0],
      req.profile.name,
      req.profile.clients.name,
      role,
      linkData.properties.action_link
    );
  } catch (emailErr) {
    await db.from('invitations').delete().eq('id', invitation.id);
    return res.status(500).json({ error: emailErr.message });
  }

  res.json({ invitation });
});

app.delete('/api/invitations/:id', requireAuth, requireOwner, async (req, res) => {
  const { error } = await db
    .from('invitations')
    .delete()
    .eq('id', req.params.id)
    .eq('client_id', req.profile.client_id);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

app.post('/api/invitations/:id/resend', requireAuth, requireOwner, async (req, res) => {
  const { data: inv } = await db
    .from('invitations')
    .select('email, role')
    .eq('id', req.params.id)
    .eq('client_id', req.profile.client_id)
    .single();
  if (!inv) return res.status(404).json({ error: 'Uitnodiging niet gevonden' });

  // Verleng de uitnodiging
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  await db.from('invitations').update({ expires_at: expiresAt }).eq('id', req.params.id);

  // Nieuwe magic link genereren
  const { data: linkData, error: linkError } = await db.auth.admin.generateLink({
    type: 'magiclink',
    email: inv.email,
    options: { redirectTo: appUrl }
  });
  if (linkError) return res.status(500).json({ error: linkError.message });

  try {
    await sendInviteEmail(
      inv.email,
      inv.email.split('@')[0],
      req.profile.name,
      req.profile.clients.name,
      inv.role,
      linkData.properties.action_link
    );
  } catch (emailErr) {
    return res.status(500).json({ error: emailErr.message });
  }

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
