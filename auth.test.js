const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

test("Firebase profiles preserve legacy data and isolate project identities", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "iris-auth-"));
  try {
    const SQL = await require("sql.js")();
    const legacy = new SQL.Database();
    legacy.run("CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE COLLATE NOCASE, password_hash TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')))");
    legacy.run("INSERT INTO users (username, password_hash) VALUES ('legacy', 'existing-hash')");
    fs.writeFileSync(path.join(dir, "redlist.db"), Buffer.from(legacy.export()));
    legacy.close();
    const db = require("./database");
    await db.init(dir);
    const a = db.getFirebaseProfile("dev", { uid: "same-uid" });
    const again = db.getFirebaseProfile("dev", { uid: "same-uid" });
    const b = db.getFirebaseProfile("live", { uid: "same-uid" });
    assert.equal(a.id, again.id);
    assert.notEqual(a.id, b.id);
    db.upsertSpecies({ userId: a.id, name: "test", displayName: "Test", rootDir: dir, specimenCount: 0, hasSummary: false });
    assert.equal(db.getAllSpecies(a.id, dir).length, 1);
    assert.equal(db.getAllSpecies(b.id, dir).length, 0);
    const saved = new SQL.Database(fs.readFileSync(path.join(dir, "redlist.db")));
    assert.equal(saved.exec("SELECT password_hash FROM users WHERE id=1")[0].values[0][0], "existing-hash");
    assert.equal(saved.exec("SELECT COUNT(*) FROM firebase_profiles")[0].values[0][0], 2);
    saved.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("auth validates inputs and reports safe errors without contacting Firebase", async () => {
  const auth = require("./auth-service");
  await assert.rejects(auth.login("invalid", "password"), { code: "auth/invalid-email" });
  await assert.rejects(auth.register("a@example.com", ""), { code: "auth/missing-password" });
  delete process.env.FIREBASE_API_KEY;
  await assert.rejects(auth.login("a@example.com", "password"), { code: "auth/missing-config" });
  assert.equal(auth.errorMessage({ code: "auth/user-not-found" }), auth.errorMessage({ code: "auth/wrong-password" }));
  assert.equal(auth.errorMessage(new Error("private detail")), "Unable to complete authentication. Please try again.");
  await auth.logout();
});
const vm = require("node:vm");

function authFixture() {
  const client = { currentUser: null };
  const calls = [];
  const user = { uid: "test-uid", email: "test@example.com", emailVerified: false };
  let sendError;
  let verified = false;
  const sdk = {
    initializeAuth: () => client,
    inMemoryPersistence: {},
    validatePassword: async () => ({ isValid: true }),
    createUserWithEmailAndPassword: async () => { client.currentUser = user; calls.push("register"); return { user }; },
    signInWithEmailAndPassword: async () => { client.currentUser = user; calls.push("login"); return { user }; },
    sendEmailVerification: async () => { calls.push("send"); if (sendError) throw sendError; },
    reload: async () => { calls.push("reload"); user.emailVerified = verified; },
    getIdToken: async (_user, force) => { assert.equal(force, true); calls.push("token"); },
    signOut: async () => { client.currentUser = null; },
  };
  const context = vm.createContext({
    module: { exports: {} }, Date,
    process: { env: { FIREBASE_API_KEY: "test", FIREBASE_AUTH_DOMAIN: "test", FIREBASE_PROJECT_ID: "test", FIREBASE_APP_ID: "test" } },
    require: name => name === "firebase/app" ? { initializeApp: () => ({}) } : sdk,
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "auth-service.js"), "utf8"), context);
  return {
    auth: context.module.exports, calls, user,
    setSendError: error => { sendError = error; },
    verify: () => { verified = true; },
  };
}

function mainFixture(fixture) {
  const handlers = new Map();
  let profiles = 0;
  const contents = { mainFrame: {} };
  const context = vm.createContext({
    console, process, __dirname, module: { exports: {} },
    require(name) {
      if (name === "electron") return {
        app: { getPath: () => __dirname, whenReady: () => new Promise(() => {}), on() {} },
        ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
      };
      if (name === "./auth-service") return fixture.auth;
      if (name === "./database") return { getFirebaseProfile: () => { profiles++; return { id: 42 }; } };
      if (name === "dotenv") return { config() {} };
      if (name.startsWith("./")) return {};
      return require(name);
    },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "main.js"), "utf8"), context);
  context.testContents = contents;
  vm.runInContext("mainWindow = { webContents: testContents };", context);
  const event = { sender: contents, senderFrame: contents.mainFrame };
  return {
    invoke: (channel, ...args) => handlers.get(channel)(event, ...args),
    profiles: () => profiles,
    rejectFrame: () => handlers.get("auth-check-verification")({ sender: contents, senderFrame: {} }),
  };
}

test("verification blocks sessions and protected IPC until Firebase reload confirms verification", async () => {
  const fixture = authFixture();
  const main = mainFixture(fixture);
  const registered = await main.invoke("auth-register", "test@example.com", "password123");
  assert.equal(registered.verificationRequired, true);
  assert.match(registered.message, /Account created/);
  assert.ok(fixture.calls.includes("send"));
  assert.equal(await main.invoke("auth-current"), null);
  assert.equal(main.profiles(), 0);
  for (const channel of ["load-output-root", "run-pipeline", "run-voucher-pipeline", "copy-images-to-pics", "get-api-key", "set-output-root"]) {
    assert.match((await main.invoke(channel)).error, /verified email/);
  }
  assert.match((await main.rejectFrame()).error, /denied/);
  assert.equal((await main.invoke("auth-check-verification")).verificationRequired, true);
  assert.equal(fixture.calls.includes("token"), false);
  assert.match((await main.invoke("auth-resend-verification")).error, /wait a minute/);
  fixture.verify();
  const checked = await main.invoke("auth-check-verification");
  assert.equal(checked.user.emailVerified, true);
  assert.equal(main.profiles(), 1);
  assert.ok(fixture.calls.indexOf("token") > fixture.calls.indexOf("reload"));
  assert.equal((await main.invoke("auth-current")).id, 42);
  await main.invoke("auth-logout");
  assert.equal(await main.invoke("auth-current"), null);
  assert.match((await main.invoke("auth-check-verification")).error, /sign in again/);
});

test("send failures preserve a recoverable pending account and never grant access", async () => {
  const fixture = authFixture();
  const main = mainFixture(fixture);
  fixture.setSendError({ code: "auth/network-request-failed" });
  const registered = await main.invoke("auth-register", "test@example.com", "password123");
  assert.equal(registered.verificationRequired, true);
  assert.match(registered.message, /Account created/);
  assert.match(registered.message, /internet connection/);
  assert.doesNotMatch(registered.message, /email requested/);
  assert.equal(main.profiles(), 0);
  assert.equal(await main.invoke("auth-current"), null);
  fixture.setSendError({ code: "auth/too-many-requests" });
  assert.match((await main.invoke("auth-resend-verification")).error, /Too many attempts/);
  fixture.setSendError(null);
  assert.equal((await main.invoke("auth-resend-verification")).verificationRequired, true);
  await main.invoke("auth-logout");
  assert.equal((await main.invoke("auth-login", "test@example.com", "password123")).verificationRequired, true);
  assert.equal(main.profiles(), 0);
});

test("verified existing accounts sign in normally", async () => {
  const fixture = authFixture();
  fixture.user.emailVerified = true;
  const main = mainFixture(fixture);
  const result = await main.invoke("auth-login", "test@example.com", "password123");
  assert.equal(result.user.emailVerified, true);
  assert.equal(main.profiles(), 1);
  assert.equal(fixture.calls.includes("send"), false);
});

test("verification refresh failures cannot create an application session", async () => {
  const fixture = authFixture();
  const main = mainFixture(fixture);
  await main.invoke("auth-login", "test@example.com", "password123");
  fixture.auth.checkVerification = async () => { throw { code: "auth/network-request-failed" }; };
  assert.match((await main.invoke("auth-check-verification")).error, /internet connection/);
  assert.equal(await main.invoke("auth-current"), null);
  assert.equal(main.profiles(), 0);
});
