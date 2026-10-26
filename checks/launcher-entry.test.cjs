const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const javaRoot = path.join(root, 'android/app/src/main/java/com/nivra/app');
const source = name => fs.readFileSync(path.join(javaRoot, `${name}.java`), 'utf8');
const manifest = fs.readFileSync(path.join(root, 'android/app/src/main/AndroidManifest.xml'), 'utf8');
const attributes = text => Object.fromEntries([...text.matchAll(/android:([\w]+)="([^"]*)"/g)].map(match => [match[1], match[2]]));
const activities = [...manifest.matchAll(/<activity\s([^>]*?)(?:\/>|>([\s\S]*?)<\/activity>)/g)]
  .map(match => ({ ...attributes(match[1]), body: match[2] || '', offset: match.index }));

test('replaceable launcher aliases use a transient private no-display task instead of the live WebView task', () => {
  const entry = activities.find(activity => activity.name === '.LauncherEntryActivity');
  assert.ok(entry);
  assert.equal(entry.theme, '@android:style/Theme.NoDisplay');
  assert.equal(entry.noHistory, 'true');
  assert.equal(entry.taskAffinity, '');
  assert.equal(entry.excludeFromRecents, 'true');
  assert.equal(entry.exported, 'false');
  assert.equal(entry.enabled, 'true');
  assert.equal(entry.launchMode, 'standard');
  const aliases = [...manifest.matchAll(/<activity-alias\s([^>]+)>([\s\S]*?)<\/activity-alias>/g)];
  assert.equal(aliases.length, 3);
  assert.deepEqual(aliases.map(match => attributes(match[1]).name).sort(), ['.LauncherEmerald', '.LauncherIvory', '.LauncherOriginal']);
  for (const alias of aliases) {
    assert.equal(attributes(alias[1]).targetActivity, '.LauncherEntryActivity');
    assert.equal(attributes(alias[1]).exported, 'true');
    assert.ok(alias.index > entry.offset, 'Android requires the target activity to be declared before aliases');
    assert.match(alias[2], /android\.intent\.action\.MAIN/);
    assert.match(alias[2], /android\.intent\.category\.LAUNCHER/);
  }
});

test('the stable singleTask MainActivity retains app-link and share entry points without another launcher entry', () => {
  const main = activities.find(activity => activity.name === '.MainActivity');
  assert.ok(main);
  assert.equal(main.enabled, 'true');
  assert.equal(main.exported, 'true');
  assert.equal(main.launchMode, 'singleTask');
  assert.match(main.body, /android\.intent\.action\.VIEW/);
  assert.match(main.body, /android\.intent\.action\.SEND_MULTIPLE/);
  assert.doesNotMatch(main.body, /android\.intent\.category\.LAUNCHER/);
});

test('the launcher forwards a fresh explicit MainActivity intent without accepting caller routes, extras, flags or URI grants', () => {
  const entry = source('LauncherEntryActivity');
  assert.match(entry, /extends Activity/);
  assert.match(entry, /new Intent\(LauncherEntryActivity\.this, MainActivity\.class\)/);
  assert.match(entry, /Intent\.ACTION_MAIN/);
  assert.match(entry, /Intent\.CATEGORY_LAUNCHER/);
  assert.match(entry, /Intent\.FLAG_ACTIVITY_NEW_TASK\s*\|\s*Intent\.FLAG_ACTIVITY_CLEAR_TOP\s*\|\s*Intent\.FLAG_ACTIVITY_SINGLE_TOP/);
  assert.match(entry, /startActivity\(main\)/);
  assert.match(entry, /finishEntry\(\)\s*\{\s*finish\(\);/);
  assert.doesNotMatch(entry, /getIntent\(|putExtras\(|putExtra\(|setData\(|setClipData\(|getFlags\(|setFlags\(|FLAG_GRANT_|finishAndRemoveTask\(|finishAffinity\(/);
  assert.doesNotMatch(entry, /BridgeActivity|registerPlugin\(|loadUrl\(|Handler|postDelayed|CompletableFuture|new Thread|setContentView\(/);
});

test('appearance updates still toggle only fixed aliases with DONT_KILL_APP and never mutate an activity lifecycle', () => {
  const policy = source('LauncherAppearancePolicy');
  const manager = source('LauncherAppearanceManager');
  assert.match(policy, /Arrays\.asList\("original", "emerald", "ivory"\)/);
  assert.doesNotMatch(policy, /com\.nivra\.app\.(MainActivity|LauncherEntryActivity)/);
  assert.equal((manager.match(/PackageManager\.DONT_KILL_APP/g) || []).length, 2);
  assert.doesNotMatch(manager, /startActivity\(|finish\(|finishAffinity\(|killProcess\(|stopService\(/);
  assert.doesNotMatch(source('MainActivity'), /LauncherAppearanceManager[^\n]*onStop|protected void onStop/);
});

test('messages, calls and screen sharing keep their explicit stable MainActivity intents', () => {
  for (const name of ['NivraMessagingService', 'NivraIncomingCallActivity', 'NivraOngoingCallService', 'NivraScreenProjectionService', 'NivraCallActionReceiver']) {
    assert.match(source(name), /MainActivity\.class/, name);
    assert.doesNotMatch(source(name), /getLaunchIntentForPackage|LauncherEntryActivity\.class/, name);
  }
});
