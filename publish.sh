#!/bin/bash
# Régénère data/state.json et le pousse sur GitHub Pages (samgrok/groky-desk). N'affiche jamais la clé.
cd /workspace/groky-desk || exit 1
python3 build_state.py >/dev/null || exit 1
git add data/state.json
git diff --cached --quiet && { echo "rien à publier"; exit 0; }
git commit -q -m "state: $(date '+%d/%m %H:%M')"
git push -q "https://x-access-token:${GITHUB_GROKY_DESK_TOKEN}@github.com/samgrok/groky-desk.git" HEAD:main 2>&1 | sed 's/x-access-token:[^@]*@/***@/'
echo "publié"
