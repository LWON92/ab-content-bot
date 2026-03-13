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
  // Actieve klant: uit header of primaire klant
  req.clientId = req.headers['x-client-id'] || profile.client_id;
  next();
}

function requireAdmin(req, res, next) {
  if (!['superadmin','admin'].includes(req.profile.role)) {
    return res.status(403).json({ error: 'Onvoldoende rechten' });
  }
  next();
}

function requireSuperadmin(req, res, next) {
  if (req.profile.role !== 'superadmin') {
    return res.status(403).json({ error: 'Alleen superadmin heeft toegang' });
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

  // Haal alle gekoppelde klanten op via user_clients
  const { data: clientLinks } = await db
    .from('user_clients')
    .select('role, clients(id, name, initials, slug)')
    .eq('user_id', user.id);

  res.json({ user: profile, clients: (clientLinks || []).map(function(l) {
    return { ...l.clients, role: l.role };
  })});
});

// ════════════════════════════════════════════════
//  USERS
// ════════════════════════════════════════════════
app.get('/api/users', requireAuth, async (req, res) => {
  const { data, error } = await db
    .from('user_clients')
    .select('role, users(id, name, email, avatar_color, is_active, added_at, last_login_at)')
    .eq('client_id', req.clientId)
    .order('added_at', { ascending: true });

  if (error) return res.status(500).json({ error: error.message });
  // Flatten + filter superadmin uit klantenoverzicht
  const users = (data || [])
    .map(function(row) { return { ...row.users, role: row.role }; })
    .filter(function(u) { return u.role !== 'superadmin'; });
  return res.json({ users });

  const _dummy = null;
});

app.put('/api/users/:id', requireAuth, requireAdmin, async (req, res) => {
  const { role } = req.body;
  if (!['admin','member','viewer'].includes(role)) {
    return res.status(400).json({ error: 'Ongeldige rol' });
  }
  const { data, error } = await db
    .from('user_clients')
    .update({ role })
    .eq('user_id', req.params.id)
    .eq('client_id', req.clientId)
    .neq('role', 'superadmin')
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ user: data });
});

app.delete('/api/users/:id', requireAuth, requireAdmin, async (req, res) => {
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

app.post('/api/invitations', requireAuth, requireAdmin, async (req, res) => {
  const { email, role } = req.body;
  if (!email) return res.status(400).json({ error: 'E-mailadres vereist' });
  if (!['admin','member','viewer'].includes(role)) {
    return res.status(400).json({ error: 'Ongeldige rol' });
  }
  // Superadmin kan niet via uitnodiging worden aangemaakt
  if (role === 'superadmin') {
    return res.status(403).json({ error: 'Superadmin kan niet worden uitgenodigd' });
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
    type: 'invite',
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

app.delete('/api/invitations/:id', requireAuth, requireAdmin, async (req, res) => {
  const { error } = await db
    .from('invitations')
    .delete()
    .eq('id', req.params.id)
    .eq('client_id', req.profile.client_id);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

app.post('/api/invitations/:id/resend', requireAuth, requireAdmin, async (req, res) => {
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
    type: 'invite',
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
//  ME — PROFIEL BIJWERKEN (naam + avatar kleur)
// ════════════════════════════════════════════════
const VALID_COLORS = ['av-b','av-g','av-a','av-gr','av-p','av-r','av-t'];

app.put('/api/me/name', requireAuth, async (req, res) => {
  const { name } = req.body;
  if (!name || name.trim().length < 2) {
    return res.status(400).json({ error: 'Naam te kort' });
  }
  const { data, error } = await db
    .from('users')
    .update({ name: name.trim() })
    .eq('id', req.profile.id)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ user: data });
});

app.put('/api/me/profile', requireAuth, async (req, res) => {
  const { name, avatar_color } = req.body;
  if (!name || name.trim().length < 2) {
    return res.status(400).json({ error: 'Naam te kort' });
  }
  if (avatar_color && !VALID_COLORS.includes(avatar_color)) {
    return res.status(400).json({ error: 'Ongeldige kleur' });
  }
  const updates = { name: name.trim() };
  if (avatar_color) updates.avatar_color = avatar_color;

  const { data, error } = await db
    .from('users')
    .update(updates)
    .eq('id', req.profile.id)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ user: data });
});

// ════════════════════════════════════════════════
//  CLIENTS — voor klantenswitcher
// ════════════════════════════════════════════════
app.get('/api/clients', requireAuth, async (req, res) => {
  const { data, error } = await db
    .from('user_clients')
    .select('role, clients(id, name, initials, slug)')
    .eq('user_id', req.profile.id);

  if (error) return res.status(500).json({ error: error.message });
  const clients = (data || []).map(function(row) {
    return { ...row.clients, role: row.role };
  });
  res.json({ clients });
});

// POST /api/user-clients — extra klant koppelen aan gebruiker (owner only)
app.post('/api/user-clients', requireAuth, requireAdmin, async (req, res) => {
  const { user_id, client_id, role } = req.body;
  if (!user_id || !client_id) return res.status(400).json({ error: 'user_id en client_id vereist' });
  if (!['admin','member','viewer'].includes(role)) return res.status(400).json({ error: 'Ongeldige rol' });

  const { data, error } = await db
    .from('user_clients')
    .insert({ user_id, client_id, role })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ link: data });
});

// DELETE /api/user-clients/:user_id/:client_id — koppeling verwijderen (owner only)
app.delete('/api/user-clients/:user_id/:client_id', requireAuth, requireAdmin, async (req, res) => {
  const { error } = await db
    .from('user_clients')
    .delete()
    .eq('user_id', req.params.user_id)
    .eq('client_id', req.params.client_id);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// PATCH /api/meta-results/:jobId — n8n schrijft resultaten terug per URL
// Body: { results: [{url, current_title, current_description, status}] }
app.patch('/api/meta-results/:jobId', async (req, res) => {
  const { results } = req.body;
  if (!Array.isArray(results) || !results.length) {
    return res.status(400).json({ error: 'results array vereist' });
  }

  // Verifieer dat de job bestaat
  const { data: job, error: jobErr } = await db
    .from('meta_jobs')
    .select('id, client_id, status')
    .eq('id', req.params.jobId)
    .single();

  if (jobErr || !job) return res.status(404).json({ error: 'Job niet gevonden' });

  // Update resultaten per URL
  for (const r of results) {
    if (!r.url) continue;
    await db
      .from('meta_results')
      .update({
        current_title:       r.current_title       || null,
        current_description: r.current_description || null,
        status:              r.status || 'verwerkt'
      })
      .eq('job_id', job.id)
      .eq('url', r.url);
  }

  // Check of alle resultaten klaar zijn → job status op 'verwerkt'
  const { data: pending } = await db
    .from('meta_results')
    .select('id')
    .eq('job_id', job.id)
    .in('status', ['wachtend', 'verwerkt']);

  if (!pending || !pending.length) {
    await db.from('meta_jobs').update({ status: 'verwerkt' }).eq('id', job.id);
  }

  res.json({ success: true });
});

// GET /api/meta-results/:jobId — frontend pollt voor live statusupdates
app.get('/api/meta-results/:jobId', requireAuth, async (req, res) => {
  const { data: results, error } = await db
    .from('meta_results')
    .select('id, url, status, current_title, current_description')
    .eq('job_id', req.params.jobId)
    .order('created_at', { ascending: true });

  if (error) return res.status(500).json({ error: error.message });

  const { data: job } = await db
    .from('meta_jobs')
    .select('status')
    .eq('id', req.params.jobId)
    .single();

  res.json({ results: results || [], job_status: job ? job.status : 'unknown' });
});

// ════════════════════════════════════════════════
//  META CHECKER JOBS
// ════════════════════════════════════════════════

// POST /api/meta-jobs — maak nieuwe job + URL-rijen aan
app.post('/api/meta-jobs', requireAuth, async (req, res) => {
  const { urls } = req.body;
  if (!Array.isArray(urls) || !urls.length) {
    return res.status(400).json({ error: 'urls array vereist' });
  }

  // Maak job aan
  const { data: job, error: jobErr } = await db
    .from('meta_jobs')
    .insert({ client_id: req.clientId, created_by: req.profile.id, status: 'wachtend', type: 'checker' })
    .select()
    .single();
  if (jobErr) return res.status(500).json({ error: jobErr.message });

  // Maak result-rijen aan
  const rows = urls.map(function(url) {
    return { job_id: job.id, client_id: req.clientId, url, status: 'wachtend' };
  });
  const { error: rowErr } = await db.from('meta_results').insert(rows);
  if (rowErr) return res.status(500).json({ error: rowErr.message });

  res.json({ job });
});

// GET /api/meta-jobs/active — haal actieve job + resultaten op
app.get('/api/meta-jobs/active', requireAuth, async (req, res) => {
  const { data: job, error: jobErr } = await db
    .from('meta_jobs')
    .select('id, status, created_at, type')
    .eq('client_id', req.clientId)
    .eq('type', 'checker')
    .in('status', ['wachtend', 'verwerkt'])
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  if (jobErr || !job) return res.json({ job: null, results: [] });

  const { data: results } = await db
    .from('meta_results')
    .select('id, url, status, current_title, current_description')
    .eq('job_id', job.id)
    .order('created_at', { ascending: true });

  res.json({ job, results: results || [] });
});

// GET /api/meta-jobs/done — haal voltooide jobs + resultaten op
app.get('/api/meta-jobs/done', requireAuth, async (req, res) => {
  const { data: jobs } = await db
    .from('meta_jobs')
    .select('id, status, created_at')
    .eq('client_id', req.clientId)
    .eq('type', 'checker')
    .eq('status', 'verwerkt')
    .order('created_at', { ascending: false })
    .limit(1);

  if (!jobs || !jobs.length) return res.json({ job: null, results: [] });
  const job = jobs[0];

  const { data: results } = await db
    .from('meta_results')
    .select('id, url, status, current_title, current_description')
    .eq('job_id', job.id)
    .order('created_at', { ascending: true });

  res.json({ job, results: results || [] });
});

// ════════════════════════════════════════════════
//  WEBHOOKS (superadmin only)
// ════════════════════════════════════════════════
const WEBHOOK_TYPES = ['productcategorie', 'meta-checker', 'meta-writer'];

// GET /api/webhooks — haal webhooks op voor actieve klant
app.get('/api/webhooks', requireAuth, requireSuperadmin, async (req, res) => {
  const { data, error } = await db
    .from('webhooks')
    .select('id, type, url, is_active')
    .eq('client_id', req.clientId);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ webhooks: data || [] });
});

// PUT /api/webhooks — sla webhooks op (upsert per type)
app.put('/api/webhooks', requireAuth, requireSuperadmin, async (req, res) => {
  const { webhooks } = req.body; // [{type, url}]
  if (!Array.isArray(webhooks)) return res.status(400).json({ error: 'webhooks array vereist' });

  const results = [];
  for (const wh of webhooks) {
    if (!WEBHOOK_TYPES.includes(wh.type)) continue;

    // Check of er al een rij bestaat voor deze client+type
    const { data: existing } = await db
      .from('webhooks')
      .select('id')
      .eq('client_id', req.clientId)
      .eq('type', wh.type)
      .single();

    if (existing) {
      const { data, error } = await db
        .from('webhooks')
        .update({ url: wh.url || '', is_active: !!(wh.url) })
        .eq('id', existing.id)
        .select()
        .single();
      if (!error) results.push(data);
    } else {
      const { data, error } = await db
        .from('webhooks')
        .insert({ client_id: req.clientId, type: wh.type, url: wh.url || '', is_active: !!(wh.url) })
        .select()
        .single();
      if (!error) results.push(data);
    }
  }

  res.json({ webhooks: results });
});

// GET /api/webhooks/:type — haal 1 webhook op (voor gebruik door modules)
app.get('/api/webhooks/:type', requireAuth, async (req, res) => {
  if (!WEBHOOK_TYPES.includes(req.params.type)) {
    return res.status(400).json({ error: 'Ongeldig webhook type' });
  }
  const { data, error } = await db
    .from('webhooks')
    .select('url, is_active')
    .eq('client_id', req.clientId)
    .eq('type', req.params.type)
    .single();

  if (error || !data) return res.json({ url: '', is_active: false });
  res.json(data);
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

// PUT /api/me/name — naam bijwerken van ingelogde gebruiker
