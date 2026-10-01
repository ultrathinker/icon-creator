// Starts the fake browser through runBrowser and then exits the program while
// the browser is still running, to prove the exit hook ends it. Run by
// browser-process.test.mjs as a child process.
import { runBrowser } from '../../scripts/lib/browserproc.mjs';

const [fake, outPath] = process.argv.slice(2);
runBrowser(process.execPath, [fake, `--screenshot=${outPath}`, '--window-size=16,16'], {
  probe: async () => null,
  timeoutMs: 600000,
});
setTimeout(() => process.exit(0), 1500);
