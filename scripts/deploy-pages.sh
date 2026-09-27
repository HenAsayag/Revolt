#!/usr/bin/env sh
# Build and publish dist/ to the gh-pages branch (GitHub Pages serves it at /<repo>/).
set -e
cd "$(dirname "$0")/.."
npm run build
cd dist
touch .nojekyll
rm -rf .git
git init -q
git checkout -q -b gh-pages
git add -A
git commit -q -m "Deploy $(date -u +%Y-%m-%dT%H:%MZ)"
git push -f "$(cd .. && git remote get-url origin)" gh-pages
rm -rf .git
echo "Published to gh-pages"
