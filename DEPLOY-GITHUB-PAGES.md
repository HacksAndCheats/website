# Deploiement GitHub Pages + WormGPT

GitHub Pages heberge uniquement des fichiers statiques. La page `wormgpt.html` et l'app dans `wormgpt/` peuvent donc etre publiees sur `*.github.io`, mais le chat a besoin d'un backend Node separe pour les routes `/api/chat` et `/api/ollama/*`.

## 1. Publier le site statique

Pousse ces fichiers sur le depot GitHub Pages :

- `index.html`, `wormgpt.html`, les autres pages HTML
- `music-controls.css`, `music-controls.js`
- le dossier `wormgpt/`

## 2. Deployer le backend

Deploie le dossier `backend/` sur un hebergeur Node comme Render, Railway ou Fly.io.

Variables recommandees :

```env
PORT=3001
FRONTEND_URL=https://ton-compte.github.io/ton-repo/wormgpt.html
RENDER_EXTERNAL_URL=https://ton-backend.onrender.com
ENABLE_REMOTE_TOOLS=false
```

`ENABLE_REMOTE_TOOLS=false` garde les fonctions terminal, git et ecriture de fichiers desactivees en public. Le chat reste disponible.

## 3. Brancher GitHub Pages au backend

Dans `wormgpt/config.js`, remplace les valeurs vides :

```js
window.WORMGPT_CONFIG = {
  apiBaseUrl: 'https://ton-backend.onrender.com',
  wsBaseUrl: 'wss://ton-backend.onrender.com'
};
```

Si tu n'as pas besoin du terminal/code runner en ligne, tu peux laisser `wsBaseUrl` vide.
