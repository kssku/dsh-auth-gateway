# Releasing

1. Bump `version` in `package.json` and add a matching `CHANGELOG.md` section.
2. Run the checks:

   ```bash
   npm ci
   npm run check
   npm run pack:check
   ```

3. Publish:

   ```bash
   npm publish --access public
   ```

4. Tag and push:

   ```bash
   git tag v$(node -p "require('./package.json').version")
   git push origin main --tags
   ```

`prepack` runs the build automatically, so `lib/` in the tarball is always fresh.
