/**
 * Which commit is running.
 *
 * Stored alongside every generated recap so the exact prompt is reconstructable
 * later: the facts are already persisted, PERSONA lives in this repo, and
 * factsBlock(facts) is deterministic, so facts + sha == the prompt that was
 * sent. That is smaller than storing the prompt and it keeps prompts in version
 * control, which is the point. A prompt pasted into a dashboard text box can
 * never be traced back to the output it produced.
 *
 * Render sets RENDER_GIT_COMMIT on every deploy. Locally there is no such
 * variable and no guarantee of a .git directory either, so this degrades to
 * null rather than throwing: an unknown sha is a gap in the trace, not an
 * outage.
 */
let cached;

function commitSha() {
  if (cached !== undefined) return cached;
  cached = process.env.RENDER_GIT_COMMIT || process.env.GIT_COMMIT || null;
  if (!cached) {
    try {
      cached = require('child_process')
        .execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
        .toString().trim() || null;
    } catch {
      cached = null;
    }
  }
  return cached;
}

module.exports = { commitSha };
