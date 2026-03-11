# Arthur & Brent — AI Content Bot

## Deployen op Railway

### Optie 1: Via Railway CLI
```bash
npm install -g @railway/cli
railway login
railway init
railway up
```

### Optie 2: Via GitHub
1. Push deze map naar een GitHub repository
2. Ga naar railway.app → New Project → Deploy from GitHub repo
3. Selecteer de repository
4. Railway detecteert automatisch Node.js en deployt

### Omgevingsvariabelen (optioneel, voor toekomstige backend)
Stel in via Railway dashboard → Variables:
```
PORT=3000          # automatisch gezet door Railway
NODE_ENV=production
```

### Structuur
```
ab-content-bot/
├── public/
│   ├── index.html   # De volledige app (single-page)
│   └── logo.png     # Arthur & Brent logo
├── server.js        # Express server
├── package.json
└── railway.json     # Railway configuratie
```

### Supabase koppelen (volgende stap)
Installeer supabase-js en voeg toe aan server.js:
```bash
npm install @supabase/supabase-js
```
Voeg toe als env variabelen:
```
SUPABASE_URL=https://xxxxx.supabase.co
SUPABASE_ANON_KEY=eyJhbGci...
```
