# Groky Desk

Tableau de bord temps réel (lecture seule) du trading de meme coins Solana de Groky.
Site statique, sans build : `index.html`, `css/style.css`, `js/app.js`, `manifest.json`, `icons/`, `data/state.json`.

## Temps réel (navigateur, sans clé)
- Solde SOL et tokens : RPC public `https://solana-rpc.publicnode.com` (repli `https://api.mainnet-beta.solana.com`), toutes les 15 s.
  `?rpc=https://…` dans l'URL ajoute un RPC prioritaire.
  Les RPC publics refusent `getTokenAccountsByOwner` : le site lit alors les comptes de tokens listés dans `state.json` (`token_accounts`) avec `getMultipleAccounts`.
- Prix : API DexScreener `tokens/v1/solana/…`, toutes les 20 s.
- Courbe de valeur et prix SOL : points enregistrés dans le `localStorage` de l'appareil.

## Données des agents
`data/state.json` est relu toutes les 45 s. Pour le régénérer :

    python3 /workspace/groky-desk/build_state.py

Fichiers lus (optionnels) : `/workspace/trading/positions.json`, `journal.csv`, `last_scan.json`, `agents.json`,
`/workspace/radar/state.json`, `copytrade_journal.json`, `/workspace/garde/state.json`, `/workspace/stratege/state.json`.
Formats attendus : voir l'en-tête de `build_state.py`.

`HELIUS_API_KEY` (env) n'est utilisée que par `build_state.py` sur le box pour lister les comptes de tokens ; elle n'est jamais écrite dans le dépôt.

## Test local

    cd /workspace/groky-desk && python3 -m http.server 8765
