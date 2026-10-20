# OpenCode local API

Relais OpenAI Chat Completions pour **DeepSeek Harness**, sur `http://127.0.0.1:4097/v1`.
Modèle unique : `deepseek-v4.1-flash-free`, sans repli payant.

Le relais fonctionne avec Node, sans dépendance npm et sans moteur OpenCode résident. À l'installation, le script télécharge temporairement le binaire officiel OpenCode, vérifie son SHA-256, extrait son protocole de requête puis teste une réponse, un appel d'outil et son résultat en streaming. Le binaire, ses dépendances et ses données temporaires sont ensuite supprimés. Seul le petit protocole nécessaire est conservé dans la configuration privée.

## Installer et démarrer

Linux avec une session **systemd utilisateur**, Node.js **22+**, Python **3.10+**, `curl` et `make`. Architectures prévues : x86_64 et ARM64 ; validation réelle effectuée sur Fedora x86_64.

```sh
git clone https://github.com/PwnPeter/opencode-local-api.git
cd opencode-local-api
make install
```

Ce dépôt est privé : le propriétaire doit vous donner accès. `make install` demande votre propre clé API OpenCode, sans l'afficher. Pour une installation non interactive, fournir `OPENCODE_API_KEY` dans l'environnement. Aucun abonnement n'est ajouté par le relais ; l'accès au modèle reste soumis aux règles et quotas OpenCode.

Le service démarre immédiatement puis automatiquement à chaque connexion utilisateur. Conserver le dossier du projet à son emplacement après installation ; après un déplacement, relancer `make install`.

```sh
make status
make logs
make restart
make stop
make start
```

## Après une mise à jour OpenCode

```sh
make refresh
```

Cette commande récupère la dernière version officielle et recommence l'extraction, les tests réels et le nettoyage. Il n'est pas nécessaire de garder une copie des sources OpenCode. Si le nouveau protocole échoue aux essais, le fichier fonctionnel et le service actuel sont conservés. Une évolution incompatible peut nécessiter une adaptation du relais ; le script refuse alors de remplacer le protocole.

`make install` réutilise le protocole existant ; sur une première installation il utilise la version de référence **1.19.3**. `make verify` teste le protocole installé auprès du fournisseur. Ces trois commandes effectuent des requêtes au modèle gratuit. `make test` lance uniquement des tests locaux, sans clé ni connexion au fournisseur.

## Brancher DeepSeek Harness

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

## Ce qui est conservé

- Le code de ce dépôt et les tests, sans dépendance externe à installer.
- `${XDG_CONFIG_HOME:-~/.config}/opencode-local-api/environment` : votre clé amont et un jeton local distinct.
- `harness.env` : uniquement le jeton local à charger dans le Harness.
- `envelope.json` : protocole extrait sans clé API.
- L'unité `systemd/user/opencode-local-api.service` : lance seulement Node.

La configuration est privée (`0700` pour le dossier, `0600` pour les fichiers). Aucun de ces fichiers locaux n'est publié. Chaque utilisateur du dépôt fournit sa propre clé. Le service écoute seulement sur `127.0.0.1` et exige le jeton local ; il ne journalise pas les messages ni les clés. Les requêtes transitent chez OpenCode et son fournisseur de modèle.

## Limites

Le protocole conserve le contexte et les définitions d'outils natifs nécessaires au modèle gratuit, soit environ 7 800 tokens supplémentaires par requête avec la version de référence. Le profil Harness réserve une marge. Le relais n'exécute aucun outil : le Harness exécute les siens ; il peut refuser un outil natif qu'il ne connaît pas.

Le relais reproduit le format de requête extrait et les identifiants natifs ; il ne fabrique aucune signature cryptographique. Le modèle gratuit et la compatibilité peuvent changer côté OpenCode. L'extraction initiale nécessite temporairement plusieurs centaines de Mo de disque et le moteur natif consomme de la mémoire pendant cette étape.

Pour désinstaller le démarrage automatique : `systemctl --user disable --now opencode-local-api.service`. Retirer aussi la configuration du fournisseur dans votre Harness avant de supprimer le projet. Les clés et les éventuelles sauvegardes privées ne sont pas supprimées automatiquement.

Sources : [OpenCode officiel](https://github.com/anomalyco/opencode), [version de référence](https://github.com/anomalyco/opencode/tree/v1.19.3). Le codec d'identifiants provient de `packages/schema/src/identifier.ts` sous licence MIT.
