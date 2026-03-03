# Stellumin.io

Prototype multijoueur type agar.io (Canvas + WebSocket).

## Local
### Server
cd server
npm install
npm start

### Client
Ouvrir `client/index.html` (ou servir via un petit serveur statique).


## Connexion Twitch / profil
- Le client utilise un `TWITCH_CLIENT_ID` codé en dur dans `client/main.js`.
- Le profil Twitch (id, pseudo, image) est utilisé automatiquement au login et envoyé au serveur sur `join`.

## Sauvegarde de progression
- Le serveur persiste la progression par `accountId` (Twitch ID) dans `server/data/player-progress.json`.
- Les champs persistés sont `xp`, `mass`, `name`, `avatar`, `updatedAt`.
- Au prochain login avec le même Twitch ID, `xp` et `mass` sont rechargés.
