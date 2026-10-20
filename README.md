# OpenCode local API → DeepSeek Harness

API compatible OpenAI Chat Completions : **http://127.0.0.1:4097/v1**.
Modèle autorisé : `deepseek-v4.1-flash-free`. Aucun modèle payant de secours.

Le plugin s'exécute dans le binaire officiel **OpenCode 1.19.3**. Chaque requête ouvre une session native temporaire et passe par son SDK et son transport habituels. Le Harness reçoit les réponses et exécute ses propres outils. Le hook `tool.execute.before` bloque l'exécution des outils dans OpenCode.

Les requêtes HTTP directes avec de simples en-têtes OpenCode sont refusées par l'offre gratuite. Cette implémentation conserve le contexte et les définitions d'outils natifs nécessaires au parcours OpenCode ; aucune signature cryptographique n'est fabriquée. Les messages du Harness sont ajoutés au contexte natif, et ses définitions d'outils remplacent les définitions natives portant le même nom. Les sessions temporaires sont supprimées après chaque appel.

## Rangement

- `../opencode/` : sources officielles, tag `v1.19.3`, commit `e3c4eb242585dcd77be1a867391b7c25fd47ce52`, laissées intactes.
- `runtime/` : binaire officiel et archive de la release, exclus de Git.
- `plugin.mjs`, `native.mjs`, `relay.mjs` : plugin, transport natif et validation HTTP.
- `opencode.json` : configuration du processus dédié.
- `dsh.patch.yml` : configuration du fournisseur Harness ; aucun secret.
- `~/.config/opencode-local-api/environment` : clés locales, accès `0600` dans un répertoire `0700`.
- `~/.config/opencode-local-api/backups/` : sauvegardes privées avant intégration au Harness.
- `~/.config/systemd/user/opencode-local-api.service` : service installé.

## Utilisation

Le service démarre automatiquement avec la session utilisateur. Son API native sur `127.0.0.1:4096` est protégée par un mot de passe distinct ; le relais sur `127.0.0.1:4097` utilise un jeton Bearer distinct de la clé OpenCode.

```sh
systemctl --user status opencode-local-api.service
systemctl --user restart opencode-local-api.service
journalctl --user -u opencode-local-api.service -n 30 --no-pager
```

Le fournisseur Harness conserve l'identifiant `opencode` afin que les sessions existantes utilisent la route locale après rechargement du profil.

```sh
(
  set -a
  . ~/.config/opencode-local-api/harness.env
  dsh headless --patch ~/Documents/Tools/opencode-local-api/dsh.patch.yml \
    'Reply exactly LOCAL_API_OK. Do not call tools.'
)
```

## Vérification

Sans dépendances à installer :

```sh
cd ~/Documents/Tools/opencode-local-api
node --test
```

Les tests utilisent des serveurs locaux pour l'authentification, la séparation des credentials, le SSE, les arguments d'outils, l'annulation et les erreurs partielles. La validation réelle utilise ensuite le modèle gratuit et un cycle `lookup_city` → résultat d'outil → réponse SSE.

## Limites

- Les requêtes sont sérialisées, car les hooks de ce SDK partagent leur configuration. Les sous-agents concurrents attendent leur tour.
- Le contexte natif ajoute environ 15 000 tokens par appel. Le profil Harness réserve 20 000 tokens en déclarant une fenêtre de 180 000 tokens.
- Les outils natifs restent visibles au modèle mais ne sont jamais exécutés par ce plugin ; le Harness peut refuser un nom qui ne fait pas partie de ses propres outils.
- L'offre gratuite et ses contrôles restent dépendants d'OpenCode. Cette version est épinglée ; une mise à jour peut nécessiter une adaptation.
- Le service ne journalise ni les requêtes du Harness ni les clés. Les réponses transitent chez OpenCode et son fournisseur de modèle.

## Sources

- [Dépôt officiel et version utilisée](https://github.com/anomalyco/opencode/tree/v1.19.3)
- [Serveur local OpenCode](https://opencode.ai/docs/server/)
- [SDK natif et construction des requêtes](https://github.com/anomalyco/opencode/blob/v1.19.3/packages/opencode/src/session/llm/request.ts)

Pour arrêter le relais : `systemctl --user disable --now opencode-local-api.service`. Restaurer aussi le profil Harness depuis la sauvegarde privée avant de supprimer le fournisseur local.
