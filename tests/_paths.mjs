// _paths.mjs - kit-relative paths for the test scripts (no machine-specific absolute paths in the repo).
//   KIT  the kit root (this repo), with a trailing slash
//   TD   test media (Twitch VOD segments + playlists; not shipped): $STTV_TESTDATA or tests/testdata/ (git-ignored)
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..') + '/';
export const TD = (process.env.STTV_TESTDATA || path.join(KIT, 'tests', 'testdata')).replace(/\/?$/, '/');
