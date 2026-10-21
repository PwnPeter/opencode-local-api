<p align="center">
  <img src="assets/logo.png" width="160" height="160" alt="Petit robot relais menthe et corail, avec deux prises et une antenne éclair">
</p>

<h1 align="center">OpenCode API</h1>

<p align="center">
  Un petit pont entre DeepSeek Harness et OpenCode.<br>
  <strong>Local · Léger · Sans dépendance npm</strong>
</p>

<p align="center">
  <a href="#démarrage">Démarrage</a> ·
  <a href="#harness">Harness</a> ·
  <a href="#modèles">Modèles</a> ·
  <a href="#actualisation">Actualisation</a>
</p>

---

Expose une API compatible **OpenAI Chat Completions** sur `http://127.0.0.1:4097/v1`, avec le texte, le raisonnement, les appels d'outils et le streaming.

Le relais tourne avec Node. Le moteur OpenCode complet sert uniquement à extraire le protocole nécessaire, puis il est supprimé avec ses dépendances temporaires. Les outils restent exécutés par le Harness.

> **Modèle activé dans ce relais :** `deepseek-v4.1-flash-free`. La liste ci-dessous décrit le catalogue OpenCode ; les autres modèles ne sont pas activés ici. Aucun repli payant.

## Démarrage

```sh
git clone https://github.com/PwnPeter/opencode-local-api.git
cd opencode-local-api
make install
```

## Prérequis

- Linux avec systemd utilisateur
- Node.js 22+, Python 3.10+, curl, make
- Clé API OpenCode
- x86_64 ou ARM64 (testé sur Fedora x86_64)

## Commandes

| Commande | Ce qu'elle fait |
| --- | --- |
| `make status` | Affiche l'état du service |
| `make logs` | Suit les journaux |
| `make start` / `make stop` | Démarre ou arrête le relais |
| `make restart` | Redémarre le relais |
| `make refresh` | Récupère OpenCode, extrait, teste et nettoie |
| `make verify` | Teste le protocole installé auprès du modèle gratuit |
| `make test` | Lance les tests locaux, sans clé ni appel au fournisseur |

## Modèles

**Vérifié le 20 octobre 2026.** Les tarifs viennent de la [documentation officielle](https://opencode.ai/v2/docs/console/models/#pricing) ; la présence dans le catalogue vient de l'[API officielle des modèles](https://opencode.ai/inference/v1/models). « Présent » signifie listé par cette API, sans garantir l'accès avec chaque compte.

### Gratuits

| Modèle | Identifiant |
| --- | --- |
| Big Pickle | `big-pickle` |
| GLM-5.3-Flash Free | `glm-5.3-flash-free` |
| **DeepSeek V4.1 Flash Free** | **`deepseek-v4.1-flash-free`** |
| MiniMax M3.1 Flash Free | `minimax-m3.1-flash-free` |
| Beam Free | `beam-free` |
| LongCat 2.5 Preview Free | `longcat-2.5-preview-free` |
| MiMo-V2.6-Flash Free | `mimo-v2.6-flash-free` |
| Nemotron 3.5 Lightning Free | `nemotron-3.5-lightning-free` |
| Nemotron 3.5 Super VL Free | `nemotron-3.5-super-vl-free` |
| Jev 1.13 Free | `jev-1.13-free` |

Jev utilise une API spécifique de décisions structurées ; ce n'est pas un modèle de chat interchangeable avec DeepSeek.

### Non listés

| Modèle | Identifiant documenté |
| --- | --- |
| LL Alpha Free | `ll-alpha-free` |
| Exo Free | `exo-free` |
| MiMo-V2.5 Free | `mimo-v2.5-free` |
| Nemotron 3 Ultra Free | `nemotron-3-ultra-free` |

### Illimités

La [documentation Go / Go Plus](https://opencode.ai/v2/docs/console/go/#usage-limits) affiche explicitement **Unlimited** pour **LongCat 2.5 Preview Free**, **Beam Free** et **MiniMax M3.1 Flash Free**, pendant leur période promotionnelle.

Cette mention concerne les offres Go / Go Plus, dont l'abonnement est payant ; elle ne garantit pas un accès illimité à ces modèles avec une simple clé Console sans abonnement. Beam a aussi des restrictions géographiques, détaillées dans la documentation.

Les autres modèles gratuits ne sont pas présentés ici comme illimités : leur gratuité est temporaire et ne garantit ni débit ni disponibilité. DeepSeek Free fonctionne avec la clé utilisée pour les essais de ce relais ; aucune promesse d'illimité n'est établie pour ce compte.

## Actualisation

```sh
make refresh
```

Le script récupère la dernière version officielle, extrait uniquement le protocole utile, teste une réponse et un aller-retour d'outil en streaming, puis supprime le binaire et ses dépendances temporaires. Pas besoin de conserver les sources OpenCode.

**Si les essais échouent, le protocole fonctionnel et le service actuel sont conservés.** Une évolution incompatible peut nécessiter une adaptation du relais.

`make install` réutilise un protocole existant ; une première installation utilise la version de référence **1.19.3**. L'extraction initiale, `make refresh` et `make verify` effectuent des requêtes au modèle gratuit.

## Harness

Importer les blocs de `dsh.patch.yml` dans votre profil Harness, ou les passer à une commande ponctuelle :

```sh
(
  set -a
  . "${XDG_CONFIG_HOME:-$HOME/.config}/opencode-local-api/harness.env"
  dsh headless --patch ./dsh.patch.yml \
    'Reply exactly RELAY_OK. Do not call tools.'
)
```

Le fournisseur `opencode` utilise `http://127.0.0.1:4097/v1` et `OPENCODE_LOCAL_API_KEY`. Pour un Harness lancé par systemd, ajouter à son unité utilisateur, via `systemctl --user edit deepseek-harness.service` :

```ini
[Unit]
Wants=opencode-local-api.service
After=opencode-local-api.service

[Service]
EnvironmentFile=%h/.config/opencode-local-api/harness.env
```

Adapter le chemin si `XDG_CONFIG_HOME` est personnalisé, puis exécuter `systemctl --user daemon-reload` et `systemctl --user restart deepseek-harness.service`.

## Configuration

<details>
<summary>Automatisation</summary>

Fournir `OPENCODE_API_KEY` dans l'environnement de `make install`. Le jeton local est généré séparément.

</details>

- Le code de ce dépôt et les tests, sans dépendance externe à installer.
- `~/.config/opencode-local-api/environment` : votre clé amont et un jeton local distinct ; le dossier suit `XDG_CONFIG_HOME` si défini.
- `harness.env` : uniquement le jeton local à charger dans le Harness.
- `envelope.json` : protocole extrait sans clé API.
- L'unité `systemd/user/opencode-local-api.service` : lance seulement Node.

Le service démarre à chaque connexion utilisateur. Après un déplacement du projet, relancer `make install`.

La configuration est privée (`0700` pour le dossier, `0600` pour les fichiers). Aucun de ces fichiers locaux n'est publié. Chaque utilisateur du dépôt fournit sa propre clé. Le service écoute seulement sur `127.0.0.1` et exige le jeton local ; il ne journalise pas les messages ni les clés. Les requêtes transitent chez OpenCode et son fournisseur de modèle.

## Conversations

Le relais conserve les messages et les outils de votre agent. Il n'ajoute plus le prompt système OpenCode complet et ne garde que deux définitions d'outils natifs de compatibilité (`bash` et `read`). Sur une petite requête de contrôle, la surcharge passe d'environ 7 800 à 2 000 tokens, soit environ 75 % de moins ; le gain dépend des outils déjà fournis par le client.

Les en-têtes `x-opencode-session`, `x-opencode-session-id` et `x-dsh-session-id` sont reconnus. Chaque identité cliente est associée à un identifiant natif stable, renouvelé après 30 minutes. Sans en-tête, le relais utilise l'empreinte du premier message utilisateur pour garder la même route pendant les appels d'outils du Harness. Deux conversations ayant exactement le même premier message peuvent alors partager cette identité de routage ; chaque requête conserve son propre historique complet.

Le cache conserve uniquement des empreintes et des identifiants, avec un maximum de 512 entrées, sans enregistrer les textes ni les clés. Les types invalides pour les messages, les outils ou le paramètre `stream` sont rejetés avec une erreur `400` avant tout appel au fournisseur.

## Limites

Le profil Harness réserve une marge de contexte. Le relais n'exécute aucun outil : le Harness exécute les siens ; il peut refuser un outil natif qu'il ne connaît pas. L'extraction et les sondes réelles de `make refresh` vérifient que le protocole réduit reste accepté avant de l'installer.

Le relais reproduit le format de requête extrait et les identifiants natifs ; il ne fabrique aucune signature cryptographique. Le modèle gratuit et la compatibilité peuvent changer côté OpenCode. L'extraction initiale nécessite temporairement plusieurs centaines de Mo de disque et le moteur natif consomme de la mémoire pendant cette étape.

<details>
<summary>Désinstallation</summary>

```sh
systemctl --user disable --now opencode-local-api.service
```

Retirer aussi la configuration du fournisseur dans votre Harness avant de supprimer le projet. Les clés et les éventuelles sauvegardes privées ne sont pas supprimées automatiquement.

</details>

---

## Projets voisins

- [zen-proxy](https://github.com/12errh/zen-proxy) : relais Node avec identifiants natifs et outils de compatibilité, ainsi que des routes OpenAI et Anthropic.
- [opencode-free-bridge](https://github.com/raksix/opencode-free-bridge) : traduit Chat Completions vers un serveur `opencode serve` maintenu en fonctionnement.
- [dsh-opencode-bridge](https://github.com/XucroYuri/dsh-opencode-bridge) : intégration expérimentale sous forme de plugin DeepSeek Harness.

Ces projets partagent le principe du relais local ; ils n'ont pas été installés ni validés avec cette configuration.

[Licence MIT](LICENSE) · [OpenCode officiel](https://github.com/anomalyco/opencode) · [Version de référence](https://github.com/anomalyco/opencode/tree/v1.19.3)

Le codec d'identifiants provient de `packages/schema/src/identifier.ts`, sous licence MIT. Le logo a été créé avec `imagegen` : petit robot relais menthe et corail, deux prises, antenne éclair, fond transparent.
