# API locale OpenCode pour DeepSeek Harness

Objectif : recevoir les requêtes OpenAI Chat Completions du Harness dans un plugin chargé par le binaire officiel OpenCode 1.19.3.

Sources officielles séparées : ../opencode, tag v1.19.3, commit e3c4eb242585dcd77be1a867391b7c25fd47ce52. Le protocole observé utilise l'identité client OpenCode ; aucune signature cryptographique ajoutée par ce projet.

- [x] Tester l'authentification locale, le refus des modèles payants, la conservation des outils et du SSE, les erreurs et l'annulation : 11 tests passent.
- [x] Implémenter relay.mjs, native.mjs et plugin.mjs sans dépendances, dans le processus natif OpenCode.
- [x] Démarrer avec un service systemd utilisateur ; secrets privés dans ~/.config/opencode-local-api.
- [x] Vérifier un appel texte et un cycle d'outil réels, puis ajouter le fournisseur au Harness.

Validation réelle : réponse HTTP 200, cycle lookup_city et réponse SSE, dsh headless renvoyant DSH_OPENCODE_LOCAL_OK, lecture effective d'un fichier témoin depuis le Harness. Profil web composé vérifié : fournisseur opencode → http://127.0.0.1:4097/v1. Services actifs et interface web authentifiée en HTTP 200.

Revue indépendante : annulation pendant la création de session, flux vide et erreur après réponse partielle reproduits, corrigés et couverts par des tests.

Contraintes : écouter uniquement sur loopback, pas de journaux de prompts ou de clés, aucun fallback payant, préserver les autres fournisseurs et les sessions.
