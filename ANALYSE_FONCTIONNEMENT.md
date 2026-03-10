# Analyse détaillée du fonctionnement de Stellumin.io

## 1) Architecture générale
- **Client Web** (Canvas + WebSocket) dans `client/` : rendu, interface HUD/menu, connexion Twitch, envoi des inputs souris.
- **Serveur Node.js + ws** dans `server/` : simulation du monde, collisions, éliminations, classement top 10, persistance de progression.
- Le protocole réseau est basé sur des messages JSON (`status`, `state`, `join`, `input`, `run_end`, etc.).

## 2) Boucle de jeu serveur
- La simulation tourne à **20 ticks/s** (`TICK_HZ = 20`).
- Le monde est borné à **4000 x 4000** unités.
- Le serveur maintient un stock cible de nourriture (**1200** éléments) avec deux types :
  - commune : masse +1
  - rare : masse +10 (6% de chance)
- À chaque tick :
  1. Mise à jour vitesse/position des joueurs selon input directionnel + inertie (drag).
  2. Clamp sur les limites du monde.
  3. Détection et consommation de nourriture.
  4. Détection des collisions joueur-joueur et logique d’absorption.
  5. Broadcast `status` puis `state` à tous les clients.

## 3) Déplacement et inertie
- L’input du joueur est un vecteur normalisé `(dx, dy)` envoyé toutes les 50 ms par le client.
- La vitesse instantanée dépend de la masse : plus on est massif, plus on est lent (`speedFromMass`).
- La vélocité est lissée via `DRAG = 0.92` (effet glissant/spatial).

## 4) Échelle de masse et rayon
- Le rayon visuel/collision dérive de la masse : `radius = 18 + sqrt(mass) * 1.6`.
- Cette relation donne une croissance sous-linéaire du rayon, évitant des tailles démesurées trop vite.

## 5) Combat/absorption entre joueurs
- Deux joueurs peuvent interagir quand leur distance est inférieure à un seuil basé sur la taille max (`eatDistance`).
- Une absorption a lieu si un joueur dépasse l’autre d’un ratio de sécurité (~12%) :
  - gagnant reçoit `+90%` de la masse de la cible
  - progression de session (`sessionMassGained`) augmente de `+75%` de la masse absorbée
- Le perdant passe en phase d’élimination (caméra figée + délai), puis fin de run.

## 6) Spawn et anti-spawn-kill
- Le spawn est choisi en minimisant un score de proximité avec les joueurs existants (`pickSpawnPoint`), sur 36 candidats aléatoires.
- Cela favorise des apparitions loin des zones dangereuses.

## 7) Progression (EXP globale)
- Le serveur conserve la progression par `accountId` (Twitch ID si dispo).
- En fin de run :
  - `earnedXp = floor(sessionMassGained * 0.35)`
  - `totalXp` est mis à jour et persisté dans `server/data/player-progress.json`.
- Le client affiche un système de niveau :
  - XP requise par niveau : `50 + (niveau-1)*25`
  - Barre de progression et animation `+EXP` au retour menu.

## 8) Cycle de vie d’une partie
1. Le client se connecte au serveur WebSocket et reçoit `status` + `state`.
2. L’utilisateur se connecte via Twitch (obligatoire pour jouer).
3. Clic sur “Rejoindre la partie” → message `join`.
4. Le serveur accepte/refuse (max 30 joueurs).
5. En jeu : inputs souris → simulation → snapshots temps réel.
6. Sortie volontaire (`leave`) ou élimination (`eaten`) → `run_end` + attribution EXP.

## 9) Interface et rendu client
- Rendu Canvas centré caméra sur le joueur local.
- Zoom dynamique lié à la masse (`getCameraScaleForMass`) : plus le joueur grandit, plus la caméra dézoome légèrement.
- Nourriture affichée en “étoiles de poussière”.
- Joueurs affichés avec avatar Twitch clipé dans une sphère + halo lumineux.
- HUD : profil, masse courante, Top 10, état de la partie.

## 10) Twitch OAuth
- Connexion Twitch avec `state` anti-CSRF et PKCE (ou implicite sur GitHub Pages).
- Le client récupère l’identité/profil Twitch, stocke `id/login/avatar` en localStorage.
- Le serveur utilise cet ID pour lier progression et sessions.

## 11) Robustesse réseau et UX
- Reconnexion auto côté client en cas de fermeture WebSocket (délai ~1.2 s).
- Serveur plein : réponse explicite `join_rejected`.
- Statut de partie toujours diffusé pour synchroniser menu/HUD.

## 12) Résumé gameplay
Stellumin.io est un **agar-like spatial** orienté parties courtes : on collecte des étoiles pour grossir, on absorbe les plus petits en évitant les plus gros, puis on convertit la masse gagnée en EXP globale persistante via compte Twitch. Le design combine une simulation serveur simple mais lisible, un rendu client soigné (halo, zoom, avatars), et une boucle méta légère (niveaux/EXP) qui motive la rejouabilité.
