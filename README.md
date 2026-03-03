# Stellumin.io

Prototype multijoueur type agar.io (Canvas + WebSocket).

## Local
### Server
cd server
npm install
npm start

### Client
Ouvrir `client/index.html` (ou servir via un petit serveur statique).


## Twitch client ID (GitHub Pages)
- Ajoutez le secret d'environnement GitHub `TWITCH_CLIENT_ID` (ou `TWITCH_ID_CLIENT`) dans l'Environment `github-pages`.
- Le workflow `.github/workflows/deploy-pages.yml` injecte automatiquement ce secret dans `runtime-config.js` au moment du déploiement.
- Le build met à jour `index.html` avec un paramètre de version (`runtime-config.js?v=...`) pour éviter un cache navigateur obsolète après redéploiement.
- En local, vous pouvez éditer `client/runtime-config.js` avec votre client id Twitch pour tester l'auth.


## Connexion Twitch / profil
- Le client lit `TWITCH_CLIENT_ID` depuis `client/runtime-config.js` (injecté au déploiement par GitHub Actions).
- Le profil Twitch (id, pseudo, image) est utilisé automatiquement au login et envoyé au serveur sur `join`.

## Sauvegarde de progression
- Le serveur persiste la progression par `accountId` (Twitch ID) dans `server/data/player-progress.json`.
- Les champs persistés sont `xp`, `mass`, `name`, `avatar`, `updatedAt`.
- Au prochain login avec le même Twitch ID, `xp` et `mass` sont rechargés.
